//! Information-only question receipts and explicit console answers; never grants.
use clap::Subcommand;
use std::{error::Error, path::Path};
use zero_protocol::{Reply, questions::OperatorDecision};
#[derive(Debug, Subcommand)]
pub enum QuestionsCommand {
    /// Read durable question records; answers do not grant permissions.
    List {
        #[arg(long)]
        session: String,
        #[arg(long)]
        root: Option<String>,
        #[arg(long, default_value_t = 0)]
        after_sequence: u64,
        #[arg(long,default_value_t=50,value_parser=clap::value_parser!(u32).range(1..=100))]
        limit: u32,
    },
    Show {
        #[arg(long)]
        session: String,
        #[arg(long)]
        question: String,
    },
}
pub async fn run(path: &Path, command: QuestionsCommand) -> Result<bool, Box<dyn Error>> {
    let path = path.to_owned();
    let task = tokio::task::spawn_blocking(move || match command {
        QuestionsCommand::List {
            session,
            root,
            after_sequence,
            limit,
        } => zero_engine::read_operator_questions(
            &path,
            &session,
            root.as_deref(),
            after_sequence,
            limit,
        )
        .map(|questions| Reply::OperatorQuestions { questions }),
        QuestionsCommand::Show { session, question } => {
            zero_engine::read_operator_question(&path, &session, &question)
                .map(|question| Reply::OperatorQuestion { question })
        }
    });
    let reply = tokio::select! {result=tokio::time::timeout(std::time::Duration::from_secs(5),task)=>result.map_err(|_|"Question read deadline exceeded")???,_=crate::server::shutdown_signal()=>return Err("Question read interrupted".into())};
    crate::write_json(&reply, false).await?;
    Ok(true)
}
/// Check before owner/configuration work: these entrypoints cannot receive answers.
pub async fn preflight(path: &Path, command: &crate::args::Command) -> Result<(), Box<dyn Error>> {
    if let crate::args::Command::Agent { request, .. } = command {
        let bytes = crate::providers::read_bounded(request).await?;
        let request: zero_protocol::agent::AgentRequest =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid agent request JSON")?;
        if (request.operator_questions || request.tool_approval_policy.is_some())
            && !cached_agent(path, command, &request)
        {
            return Err("operator_questions/tool_approval_policy requires app-server, console or tui; batch agent cannot receive answers or tool approvals".into());
        }
    }
    Ok(())
}
/// Entire tagged decision JSON is explicit so multi-question choices are unambiguous.
pub fn console_decision(line: &str) -> Result<(String, OperatorDecision), &'static str> {
    let (command, rest) = line
        .split_once(char::is_whitespace)
        .ok_or("Use /answer QUESTION_ID JSON or /dismiss QUESTION_ID")?;
    let rest = rest.trim_start();
    if command == "/dismiss" {
        if rest.is_empty() || rest.chars().any(char::is_whitespace) {
            return Err("Use /dismiss QUESTION_ID");
        }
        return Ok((rest.into(), OperatorDecision::Dismiss));
    }
    let (id, json) = rest
        .split_once(char::is_whitespace)
        .ok_or("Use /answer QUESTION_ID {\"type\":\"answer\",\"answers\":[...]}")?;
    if id.is_empty() || json.len() > 65536 {
        return Err("Answer JSON must be bounded to 64 KiB");
    }
    let decision: OperatorDecision =
        serde_json::from_str(json).map_err(|_| "Invalid answer decision JSON")?;
    if command != "/answer" || !matches!(decision, OperatorDecision::Answer { .. }) {
        return Err("/answer requires an answer decision; use /dismiss for dismissal");
    }
    Ok((id.into(), decision))
}

fn cached_agent(
    path: &Path,
    command: &crate::args::Command,
    request: &zero_protocol::agent::AgentRequest,
) -> bool {
    let crate::args::Command::Agent {
        session,
        command_id,
        ..
    } = command
    else {
        return false;
    };
    cached_agent_request(path, session, command_id, request)
}
pub fn cached_agent_request(
    path: &Path,
    session: &str,
    command: &str,
    request: &zero_protocol::agent::AgentRequest,
) -> bool {
    let Ok(store) = zero_store::Store::open_read_only(path) else {
        return false;
    };
    let Ok(operation) = store.get_operation_by_command(session, command) else {
        return false;
    };
    serde_json::to_value(request).is_ok_and(|request| {
        operation.payload["kind"] == "offline_snapshot_agent"
            && operation.payload["request"] == request
    })
}
pub fn unattended_queue(path: &Path, session: &str, input: &str) -> Result<(), Box<dyn Error>> {
    let row = zero_store::Store::open_read_only(path)?.queued_agent(session, input)?;
    if row.operation_id.is_none()
        && (row.request.operator_questions
            || row.request.tool_approval_policy.is_some()
            || row
                .resolved_request
                .as_ref()
                .is_some_and(|r| r.operator_questions || r.tool_approval_policy.is_some()))
    {
        return Err("interactive-policy pending input requires app-server, console or tui; batch queue run cannot receive answers or tool approvals".into());
    }
    Ok(())
}
