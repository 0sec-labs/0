//! Actual CLI/provider-wire fixtures. Context reduction never executes a tool.
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tempfile::TempDir;
#[derive(Clone, Copy)]
enum Wire {
    Responses,
    Chat,
    Anthropic,
}
impl Wire {
    fn name(self) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::Chat => "chat_completions",
            Self::Anthropic => "anthropic_messages",
        }
    }
}
struct Gateway {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}
impl Gateway {
    fn new(wire: Wire) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/inference", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (captured, done) = (requests.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                let mut socket = match listener.accept() {
                    Ok((s, _)) => s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => panic!("{e}"),
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let request = loop {
                    let mut buf = [0; 4096];
                    let n = socket.read(&mut buf).unwrap();
                    assert_ne!(n, 0);
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let len: usize = headers
                            .lines()
                            .find_map(|l| {
                                let (k, v) = l.split_once(':')?;
                                k.eq_ignore_ascii_case("content-length")
                                    .then(|| v.trim().parse().unwrap())
                            })
                            .unwrap();
                        if bytes.len() >= end + 4 + len {
                            break serde_json::from_slice(&bytes[end + 4..end + 4 + len]).unwrap();
                        }
                    }
                };
                let turn = {
                    let mut v = captured.lock().unwrap();
                    let n = v.len();
                    v.push(request);
                    n
                };
                let body = body(wire, turn);
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        Self {
            url,
            requests,
            stop,
            thread: Some(thread),
        }
    }
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}
fn body(wire: Wire, turn: usize) -> String {
    let tool = turn < 3;
    let reasoning = format!("reasoning-round-{turn}:{}", "x".repeat(800));
    let call = format!("call-{turn}");
    let events = match wire {
        Wire::Responses => vec![
            json!({"type":"response.completed","response":{"id":format!("r-{turn}"),"status":"completed","output":if tool {json!([{"type":"reasoning","encrypted_content":reasoning,"summary":[]},{"type":"function_call","call_id":call,"name":"not_authorized","arguments":"{}"}])}else{json!([{"type":"message","content":[{"type":"output_text","text":format!("answer-{turn}")}]}])},"usage":{"input_tokens":2,"output_tokens":1}}}),
        ],
        Wire::Chat => vec![
            json!({"id":format!("r-{turn}"),"choices":[{"index":0,"delta":if tool{json!({"role":"assistant","reasoning_content":reasoning,"tool_calls":[{"index":0,"id":call,"type":"function","function":{"name":"not_authorized","arguments":"{}"}}]})}else{json!({"role":"assistant","content":format!("answer-{turn}")})},"finish_reason":null}]}),
            json!({"id":format!("r-{turn}"),"choices":[{"index":0,"delta":{},"finish_reason":if tool{"tool_calls"}else{"stop"}}]}),
            json!({"id":format!("r-{turn}"),"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}),
        ],
        Wire::Anthropic => {
            let mut v = vec![
                json!({"type":"message_start","message":{"id":format!("r-{turn}"),"type":"message","model":"fixture","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":2,"output_tokens":0}}}),
            ];
            if tool {
                v.extend([json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":reasoning}}),json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":format!("signature-{turn}")}}),json!({"type":"content_block_stop","index":0}),json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":call,"name":"not_authorized","input":{}}}),json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}),json!({"type":"content_block_stop","index":1})]);
            } else {
                v.extend([json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":format!("answer-{turn}")}}),json!({"type":"content_block_stop","index":0})]);
            }
            v.extend([json!({"type":"message_delta","delta":{"stop_reason":if tool{"tool_use"}else{"end_turn"},"stop_sequence":null},"usage":{"output_tokens":1}}),json!({"type":"message_stop"})]);
            v
        }
    };
    let mut body = events
        .into_iter()
        .map(|v| match wire {
            Wire::Anthropic => format!("event: {}\ndata: {v}\n\n", v["type"].as_str().unwrap()),
            _ => format!("data: {v}\n\n"),
        })
        .collect::<String>();
    if matches!(wire, Wire::Chat) {
        body.push_str("data: [DONE]\n\n");
    }
    body
}
fn cli(dir: &TempDir) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    c.env("CONTEXT_FIXTURE_KEY", "fixture-secret");
    c.arg("--state").arg(dir.path().join("state.db"));
    c
}
fn parsed(out: std::process::Output) -> Value {
    assert!(
        out.status.success(),
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
fn exercise(wire: Wire) {
    let dir = TempDir::new().unwrap();
    let gateway = Gateway::new(wire);
    let source = dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("fixture"), "fixture").unwrap();
    let providers = dir.path().join("providers.json");
    std::fs::write(&providers,json!({"fixture":{"url":gateway.url,"wire_api":wire.name(),"api_key_env":"CONTEXT_FIXTURE_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":3000,"max_response_bytes":65536}}).to_string()).unwrap();
    let created = parsed(
        cli(&dir)
            .args(["session", "create", "--budget-limit", "100"])
            .output()
            .unwrap(),
    );
    let session = created["session"]["id"].as_str().unwrap();
    let request = dir.path().join("request.json");
    let mut profile = json!({"provider":"fixture","model":"fixture","instructions":"host instruction must survive","prompt":"first user instruction must survive","max_turns":4,"reservation_per_turn":10,"context_policy":{"schema_version":1,"max_input_bytes":2048,"keep_recent_rounds":1},"execution":{"execution_id":"fixture","image":"local:no-execution","snapshot":zero_executor::pin_snapshot(&source).unwrap(),"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}});
    std::fs::write(&request, profile.to_string()).unwrap();
    let first = parsed(
        cli(&dir)
            .args([
                "queue",
                "enqueue",
                "--session",
                session,
                "--command-id",
                "first",
                "--request",
            ])
            .arg(&request)
            .output()
            .unwrap(),
    );
    let first_id = first["input"]["id"].as_str().unwrap();
    profile["prompt"] = json!("second user instruction must survive");
    std::fs::write(&request, profile.to_string()).unwrap();
    let second = parsed(
        cli(&dir)
            .args([
                "queue",
                "enqueue",
                "--session",
                session,
                "--command-id",
                "second",
                "--after-input",
                first_id,
                "--request",
            ])
            .arg(&request)
            .output()
            .unwrap(),
    );
    let second_id = second["input"]["id"].as_str().unwrap();
    let first_run = parsed(
        cli(&dir)
            .arg("--providers")
            .arg(&providers)
            .args(["queue", "run", "--session", session, "--input", first_id])
            .output()
            .unwrap(),
    );
    assert_eq!(first_run["operation"]["status"], "succeeded");
    assert_eq!(gateway.count(), 4);
    let first_op = first_run["operation"]["id"].as_str().unwrap();
    let store = zero_store::Store::open_read_only(dir.path().join("state.db")).unwrap();
    let artifacts = store.operation_artifacts(first_op).unwrap();
    let full = store
        .artifact(
            artifacts
                .get("context.state.2")
                .expect("retained original context"),
        )
        .unwrap();
    assert!(String::from_utf8_lossy(&full).contains("reasoning-round-0"));
    assert!(artifacts.contains_key("context.receipt.2"));
    let historical = store
        .get_operation_by_command(session, &format!("{first_op}:model:1"))
        .unwrap();
    let old_payload = historical.payload.clone();
    drop(store);
    let second_run = parsed(
        cli(&dir)
            .arg("--providers")
            .arg(&providers)
            .args(["queue", "run", "--session", session, "--input", second_id])
            .output()
            .unwrap(),
    );
    assert_eq!(second_run["operation"]["status"], "succeeded");
    for id in [first_id, second_id] {
        let retry = parsed(
            cli(&dir)
                .args(["queue", "run", "--session", session, "--input", id])
                .output()
                .unwrap(),
        );
        assert_eq!(retry["duplicate"], true);
    }
    assert_eq!(gateway.count(), 5);
    let captures = gateway.requests.lock().unwrap();
    let third = captures[2].to_string();
    assert!(third.contains("first user instruction must survive"));
    assert!(third.contains("host instruction must survive"));
    assert!(!third.contains("reasoning-round-0"));
    assert!(!third.contains("call-0"));
    assert!(third.contains("reasoning-round-1"));
    assert!(third.contains("call-1"));
    if matches!(wire, Wire::Anthropic) {
        assert!(third.contains("signature-1"));
        assert!(!third.contains("signature-0"));
    }
    let followup = captures[4].to_string();
    assert!(followup.contains("first user instruction must survive"));
    assert!(followup.contains("second user instruction must survive"));
    drop(captures);
    let store = zero_store::Store::open_read_only(dir.path().join("state.db")).unwrap();
    assert_eq!(
        store
            .get_operation_by_command(session, &format!("{first_op}:model:1"))
            .unwrap()
            .payload,
        old_payload
    );
    let budget = store.budget(session).unwrap();
    assert_eq!(budget.charged, 15);
    assert_eq!(budget.reserved, 0);
}
#[test]
fn responses_context_omits_atomic_rounds_and_keeps_durable_history() {
    exercise(Wire::Responses)
}
#[test]
fn chat_context_preserves_reasoning_and_correlated_results() {
    exercise(Wire::Chat)
}
#[test]
fn anthropic_context_preserves_signed_thinking_and_correlated_results() {
    exercise(Wire::Anthropic)
}
