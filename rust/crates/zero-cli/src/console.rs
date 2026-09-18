//! Line-oriented durable follow-ups; no full-screen terminal or implicit authority.
use crate::{
    framing::{self, Frame},
    server,
};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    error::Error,
    future::Future,
    pin::Pin,
    sync::Arc,
};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    sync::{mpsc, watch},
};
use zero_engine::Engine;
use zero_protocol::{
    Command, ExecutionEvent, MAX_FRAME_BYTES, OperationStatus, Reply,
    agent::{AgentRequest, AgentStatus},
};

// Aborting this task cannot retract acknowledged inputs. The runtime's bounded
// shutdown handles Tokio's uninterruptible underlying stdin read on an idle pipe.
struct Reader(tokio::task::JoinHandle<()>);
impl Drop for Reader {
    fn drop(&mut self) {
        self.0.abort();
    }
}
enum Notice {
    Question(String),
    Approval(String),
}
type Active = (String, Pin<Box<dyn Future<Output = Reply> + Send>>);

pub async fn run(
    engine: Arc<Engine>,
    session: String,
    profile: AgentRequest,
) -> Result<bool, Box<dyn Error>> {
    let (events, mut event_rx) = mpsc::channel(128);
    let diagnostic_engine = engine.clone();
    let (admitted_tx, admitted_rx) = watch::channel(None::<(String, String)>);
    let (active_tx, active_rx) = watch::channel(None::<String>);
    let (question_tx, question_rx) = mpsc::channel::<Notice>(32);
    let drain = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            match event {
                ExecutionEvent::Admitted {
                    operation_id,
                    command_id,
                    ..
                } => {
                    if active_rx.borrow().as_deref() == Some(command_id.as_str()) {
                        admitted_tx.send_replace(Some((command_id.clone(), operation_id.clone())));
                    }
                    if let Err(error) = diagnostic(&format!(
                        "admitted operation {operation_id} command {command_id}"
                    ))
                    .await
                    {
                        let _ = diagnostic_engine.shutdown().await;
                        return Err(error);
                    }
                }
                ExecutionEvent::OperatorQuestionRequested {
                    question_operation_id,
                    ..
                } => {
                    if question_tx
                        .send(Notice::Question(question_operation_id))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                ExecutionEvent::ToolApprovalRequested {
                    approval_operation_id,
                    ..
                } => {
                    if question_tx
                        .send(Notice::Approval(approval_operation_id))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                _ => {}
            }
        }
        Ok::<(), std::io::Error>(())
    });
    let result = conversation(
        engine.clone(),
        session,
        profile,
        events.clone(),
        admitted_rx,
        active_tx,
        question_rx,
    )
    .await;
    let shutdown = engine.shutdown().await;
    drop(events);
    let drained = drain.await?;
    shutdown?;
    drained?;
    result
}

async fn conversation(
    engine: Arc<Engine>,
    session: String,
    profile: AgentRequest,
    events: mpsc::Sender<ExecutionEvent>,
    admitted: watch::Receiver<Option<(String, String)>>,
    active_command: watch::Sender<Option<String>>,
    mut questions: mpsc::Receiver<Notice>,
) -> Result<bool, Box<dyn Error>> {
    // A single reader owns read_frame across awaits. Cancelling/recreating that
    // future for every completed turn would lose a partially consumed line.
    let (input_tx, mut input_rx) = mpsc::channel(1);
    let _reader = Reader(tokio::spawn(async move {
        let mut stdin = BufReader::new(tokio::io::stdin());
        loop {
            let frame = framing::read_frame(&mut stdin, MAX_FRAME_BYTES).await;
            let done = matches!(&frame, Ok(None) | Err(_));
            if input_tx.send(frame).await.is_err() || done {
                break;
            }
        }
    }));
    let signal = server::shutdown_signal();
    tokio::pin!(signal);
    diagnostic("Experimental line console. Ordinary lines are durably queued; /steer TEXT addresses the admitted active turn, //steer escapes literal text. EOF drains accepted inputs; interruption leaves pending inputs for explicit resumption.").await?;
    let mut pending = VecDeque::<(String, String)>::new();
    let mut previous = None;
    let mut active: Option<Active> = None;
    let mut eof = false;
    let mut rejected = false;
    let mut awaiting_questions = BTreeSet::new();
    let mut awaiting_approvals = BTreeSet::new();
    let mut approval_commands = BTreeMap::<(String, String, String), String>::new();
    loop {
        tokio::select! {
            biased;
            _ = &mut signal => {
                engine.shutdown().await?;
                if let Some((command, work)) = active.take() {
                    let reply = work.await;
                    let _ = finish(reply, &command, true).await?;
                }
                return Ok(false);
            }
            reply = async { match active.as_mut() { Some((_,work)) => work.as_mut().await, None => std::future::pending().await } }, if active.is_some() => {
                let (command, _) = active.take().ok_or("Missing completed console turn")?;
                active_command.send_replace(None);
                awaiting_questions.clear();
                awaiting_approvals.clear();
                let completed = tokio::select! {
                    biased;
                    _ = &mut signal => return Ok(false),
                    result = finish(reply, &command, false) => result?,
                };
                if !completed { return Ok(false); }
            }
            _ = std::future::ready(()), if active.is_none() && !pending.is_empty() => {
                let (input, command) = pending.pop_front().ok_or("Missing pending console input")?;
                diagnostic(&format!("command {command}")).await?;
                active_command.send_replace(Some(command.clone()));
                let owner = engine.clone();
                let events = events.clone();
                let session_id = session.clone();
                // This future is first polled by the next select, after its
                // biased signal branch. A pending signal cannot start a new turn.
                active = Some((command, Box::pin(async move {
                    owner.handle(Command::RunQueuedAgent { session_id, input_id:input }, events).await
                })));
            }
            Some(notice)=questions.recv()=>{
                let id=match notice {
                    Notice::Question(id)=>id,
                    Notice::Approval(id)=>{
                        match engine.handle(Command::ToolApproval{session_id:session.clone(),approval_operation_id:id.clone()},events.clone()).await {
                            Reply::ToolApproval{approval}=>{
                                if approval.status==zero_protocol::approvals::ToolApprovalStatus::Pending {
                                    if eof {return stop_unanswered(&engine,&mut active).await;}
                                    awaiting_approvals.insert(id);
                                    diagnostic(&format!("tool approval {} actor {} root {} — ONE exact invocation, not a tool-wide grant\nintent SHA256 {} preview_truncated={}\n{}\nFull intent: approvals show --session {} --approval {} --full-intent\nUse /approve APPROVAL_ID INTENT_SHA256 or /deny APPROVAL_ID INTENT_SHA256",approval.operation_id,approval.actor_operation_id,approval.root_operation_id,approval.intent_sha256,approval.preview_truncated,serde_json::to_string(&approval.preview)?,session,approval.operation_id)).await?;
                                } else {awaiting_approvals.remove(&id);}
                            }
                            _=>return Err("Could not load durable tool approval notification".into()),
                        }
                        continue;
                    }
                };

                let reply=engine.handle(Command::OperatorQuestion{session_id:session.clone(),question_operation_id:id.clone()},events.clone()).await;
                if let Reply::OperatorQuestion{question}=reply {
                    if question.status==zero_protocol::questions::OperatorQuestionStatus::Pending {
                        if eof {return stop_unanswered(&engine,&mut active).await;}
                        awaiting_questions.insert(id);
                        diagnostic(&format!("operator question {} actor {} root {} — information only, no permissions granted\n{}\nUse /answer QUESTION_ID {{\"type\":\"answer\",\"answers\":[{{\"question_index\":0,\"selected_indices\":[0]}}]}} or /dismiss QUESTION_ID",question.operation_id,question.actor_operation_id,question.root_operation_id,serde_json::to_string(&question.request)?)).await?;
                    } else {awaiting_questions.remove(&id);}
                } else {return Err("Could not load durable operator question notification".into());}
            }
            frame = input_rx.recv(), if !eof => {
                let Some(frame) = frame else { eof=true;if !awaiting_questions.is_empty() || !awaiting_approvals.is_empty(){return stop_unanswered(&engine,&mut active).await;} continue; };
                let Some(frame) = frame? else { eof=true;if !awaiting_questions.is_empty() || !awaiting_approvals.is_empty(){return stop_unanswered(&engine,&mut active).await;} continue; };
                let Frame::Data(bytes) = frame else { return Err("Console prompt exceeds frame byte limit".into()); };
                let prompt=String::from_utf8(bytes).map_err(|_| "Console prompt must be UTF-8")?;
                if prompt.trim().is_empty() { continue; }
                let prompt=match console_line(prompt) {
                    ConsoleLine::Followup(prompt)=>prompt,
                    ConsoleLine::Approval(line)=>{
                        let (id,digest,decision)=match crate::approvals::console_decision(&line){Ok(value)=>value,Err(error)=>{rejected=true;diagnostic(&format!("Approval decision not sent: {error}. Nothing was queued.")).await?;continue;}};
                        let approval=match engine.handle(Command::ToolApproval{session_id:session.clone(),approval_operation_id:id.clone()},events.clone()).await {
                            Reply::ToolApproval{approval}=>approval,
                            Reply::Error{message,..}=>{rejected=true;diagnostic(&format!("Approval decision not sent: {message}. Nothing was queued.")).await?;continue;},
                            _=>return Err("Unexpected approval detail response".into()),
                        };
                        if approval.intent_sha256!=digest {rejected=true;diagnostic("Approval decision not sent: supplied intent hash does not match retained invocation. Nothing was queued.").await?;continue;}
                        let key=(id.clone(),digest.clone(),serde_json::to_string(&decision)?);
                        if approval_commands.len()>=128 && !approval_commands.contains_key(&key){rejected=true;diagnostic("Approval decision cache full; no new decision sent").await?;continue;}
                        let command_id=approval_commands.entry(key).or_insert_with(||format!("console-approval-{}",uuid::Uuid::new_v4())).clone();
                        match engine.handle(Command::DecideToolApproval{session_id:session.clone(),command_id,approval_operation_id:id.clone(),expected_intent_sha256:digest,decision},events.clone()).await {
                            Reply::ToolApprovalDecided{approval,..}=>{awaiting_approvals.remove(&id);diagnostic(&format!("tool approval decision {} {:?} — exact invocation only; permission receipt is not proof of execution",approval.operation_id,approval.status)).await?;},
                            Reply::Error{message,..}=>{rejected=true;diagnostic(&format!("Approval decision not acknowledged: {message}. Repeat the identical explicit command to retry; nothing was queued.")).await?;},
                            _=>return Err("Unexpected approval decision response".into()),
                        }
                        continue;
                    }
                    ConsoleLine::Question(line)=>{
                        let (id,decision)=match crate::questions::console_decision(&line){Ok(value)=>value,Err(error)=>{rejected=true;diagnostic(&format!("Answer not sent: {error}. Nothing was queued.")).await?;continue;}};
                        let question=match engine.handle(Command::OperatorQuestion{session_id:session.clone(),question_operation_id:id.clone()},events.clone()).await {
                            Reply::OperatorQuestion{question}=>question,
                            Reply::Error{message,..}=>{rejected=true;diagnostic(&format!("Answer not sent: {message}. Nothing was queued.")).await?;continue;},
                            _=>return Err("Unexpected question detail response".into()),
                        };
                        let command_id=format!("console-answer-{}",uuid::Uuid::new_v4());
                        match engine.handle(Command::DecideOperatorQuestion{session_id:session.clone(),command_id,question_operation_id:id.clone(),expected_request_sha256:question.request_sha256,decision},events.clone()).await {
                            Reply::OperatorQuestionDecided{question,..}=>{awaiting_questions.remove(&id);diagnostic(&format!("question decision {} {:?} — answer receipt saved, not proof of model consumption; no permissions granted",question.operation_id,question.status)).await?;},
                            Reply::Error{message,..}=>{rejected=true;diagnostic(&format!("Answer not sent: {message}. Nothing was queued.")).await?;},
                            _=>return Err("Unexpected question decision response".into()),
                        }continue;
                    }
                    ConsoleLine::Steer(prompt)=>{
                        let operation=active.as_ref().and_then(|(command,_)|admitted.borrow().as_ref().filter(|(seen,_)|seen==command).map(|(_,operation)|operation.clone()));
                        let Some(operation_id)=operation else {rejected=true;diagnostic("Steering not sent: no admitted active turn. Nothing was queued.").await?;continue;};
                        let command_id=format!("console-steer-{}",uuid::Uuid::new_v4());
                        let reply=engine.handle(Command::SteerAgent{session_id:session.clone(),operation_id,command_id,prompt},events.clone()).await;
                        match reply {
                            Reply::AgentSteered{message,..}=>diagnostic(&format!("steering message {} {:?} operation {} — Captured means journaled, not provider receipt",message.id,message.status,message.operation_id)).await?,
                            Reply::Error{code,message}=>{rejected=true;diagnostic(&format!("Steering not sent: {code}: {message}. Nothing was queued.")).await?;},
                            _=>return Err("Unexpected steering reply".into()),
                        }
                        continue;
                    }
                };
                let mut request=profile.clone();
                request.prompt=prompt;
                if previous.is_some() { request.continuation_of=None; }
                let command_id=format!("console-{}",uuid::Uuid::new_v4());
                let reply=engine.handle(Command::QueueAgent {session_id:session.clone(),command_id,request,after_input:previous.clone()},events.clone()).await;
                match reply {
                    Reply::AgentQueued { input, .. } => {
                        diagnostic(&format!("queued input {}", input.id)).await?;
                        previous=Some(input.id.clone());
                        pending.push_back((input.id,input.run_command_id));
                    }
                    Reply::Error {code,message} => {
                        rejected=true;
                        diagnostic(&format!("Input not queued: {code}: {message}")).await?;
                    }
                    _ => return Err("Unexpected console queue reply".into()),
                }
            }
            _ = std::future::ready(()), if eof && active.is_none() && pending.is_empty() => return Ok(!rejected),
        }
    }
}

async fn stop_unanswered(
    engine: &Arc<Engine>,
    active: &mut Option<Active>,
) -> Result<bool, Box<dyn Error>> {
    diagnostic("Input ended while an operator answer or tool approval was required; cancelling owned work. No answer, approval, denial or dismissal was fabricated.").await?;
    engine.shutdown().await?;
    if let Some((command, work)) = active.take() {
        let _ = finish(work.await, &command, true).await?;
    }
    Ok(false)
}

enum ConsoleLine {
    Approval(String),
    Question(String),
    Followup(String),
    Steer(String),
}
fn console_line(prompt: String) -> ConsoleLine {
    for prefix in ["/approve", "/deny"] {
        if let Some(rest) = prompt.strip_prefix(&format!("/{prefix}")) {
            if rest.is_empty() || rest.starts_with(char::is_whitespace) {
                return ConsoleLine::Followup(prompt[1..].into());
            }
        }
        if let Some(rest) = prompt.strip_prefix(prefix) {
            if rest.is_empty() || rest.starts_with(char::is_whitespace) {
                return ConsoleLine::Approval(prompt);
            }
        }
    }
    for prefix in ["/answer", "/dismiss"] {
        if let Some(rest) = prompt.strip_prefix(&format!("/{prefix}")) {
            if rest.is_empty() || rest.starts_with(char::is_whitespace) {
                return ConsoleLine::Followup(prompt[1..].into());
            }
        }
        if let Some(rest) = prompt.strip_prefix(prefix) {
            if rest.is_empty() || rest.starts_with(char::is_whitespace) {
                return ConsoleLine::Question(prompt);
            }
        }
    }
    if let Some(rest) = prompt.strip_prefix("//steer") {
        if rest.is_empty() || rest.starts_with(char::is_whitespace) {
            return ConsoleLine::Followup(prompt[1..].to_owned());
        }
    }
    if let Some(rest) = prompt.strip_prefix("/steer") {
        if rest.is_empty() {
            return ConsoleLine::Steer(String::new());
        }
        if let Some(first) = rest.chars().next().filter(|c| c.is_whitespace()) {
            return ConsoleLine::Steer(rest[first.len_utf8()..].to_owned());
        }
    }
    ConsoleLine::Followup(prompt)
}

async fn finish(reply: Reply, command: &str, interrupted: bool) -> Result<bool, Box<dyn Error>> {
    match reply {
        Reply::Agent {
            operation,
            result: Some(result),
            ..
        } if operation.status == OperationStatus::Succeeded
            && result.status == AgentStatus::Completed =>
        {
            if !interrupted {
                let rendered = terminal_text(&result.text);
                let mut output = tokio::io::stdout();
                tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    output.write_all(rendered.as_bytes()).await?;
                    output.write_all(b"\n").await?;
                    output.flush().await
                })
                .await
                .map_err(|_| "Console output stalled")??;
            }
            diagnostic(&format!("checkpoint operation {}", operation.id)).await?;
            Ok(!interrupted)
        }
        Reply::Agent { operation, .. } => {
            diagnostic(&format!("Stopped at operation {} ({:?}). Inspect session events and budget; unresolved usage requires explicit reconciliation. Pending inputs remain queued; no next prompt was submitted.",operation.id,operation.status)).await?;
            Ok(false)
        }
        Reply::Error { code, message } => {
            diagnostic(&format!("Stopped command {command}: {code}: {message}. Inspect session events and queue before retrying.")).await?;
            Ok(false)
        }
        _ => Err("Unexpected console engine reply".into()),
    }
}

// Model output is untrusted terminal text. Keep readable line/tab formatting,
// but render terminal control bytes visibly (including ESC/OSC and carriage
// return) rather than allowing output to change clipboard or terminal state.
pub(crate) fn terminal_text(value: &str) -> String {
    let mut rendered = String::with_capacity(value.len());
    for c in value.chars() {
        if c.is_control() && c != '\n' && c != '\t' {
            rendered.extend(c.escape_default());
        } else {
            rendered.push(c);
        }
    }
    rendered
}
#[cfg(test)]
mod tests {
    #[test]
    fn steering_control_is_explicit_and_literal_escape_preserves_exact_text() {
        use super::{ConsoleLine, console_line};
        assert!(matches!(console_line("/steer λ ".into()),ConsoleLine::Steer(s) if s=="λ "));
        assert!(matches!(console_line("/steer".into()),ConsoleLine::Steer(s) if s.is_empty()));
        assert!(
            matches!(console_line("//steer λ ".into()),ConsoleLine::Followup(s) if s=="/steer λ ")
        );
        for input in [
            " /steer not a command",
            "/steering literal",
            "//steering literal",
        ] {
            assert!(matches!(console_line(input.into()),ConsoleLine::Followup(s) if s==input));
        }
    }

    #[test]
    fn approval_controls_never_fall_through_and_literal_escape_is_explicit() {
        use super::{ConsoleLine, console_line};
        for prefix in ["/approve", "/deny"] {
            assert!(matches!(
                console_line(prefix.into()),
                ConsoleLine::Approval(_)
            ));
            assert!(matches!(
                console_line(format!("{prefix} missing-digest")),
                ConsoleLine::Approval(_)
            ));
            assert!(
                matches!(console_line(format!("/{prefix} λ")),ConsoleLine::Followup(s) if s==format!("{prefix} λ"))
            );
        }
        assert!(matches!(
            console_line("/answer approval {}".into()),
            ConsoleLine::Question(_)
        ));
        assert!(matches!(
            console_line("/approver literal".into()),
            ConsoleLine::Followup(_)
        ));
    }

    #[test]
    fn model_terminal_controls_are_inert_but_text_layout_is_retained() {
        assert_eq!(
            super::terminal_text("ok\n\t\x1b]52;c;payload\x07\r"),
            "ok\n\t\\u{1b}]52;c;payload\\u{7}\\r"
        );
    }
}

async fn diagnostic(message: &str) -> std::io::Result<()> {
    let mut error = tokio::io::stderr();
    let line = format!("{}\n", terminal_text(message));
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        error.write_all(line.as_bytes()).await?;
        error.flush().await
    })
    .await
    .map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "Console diagnostic output stalled",
        )
    })?
}
