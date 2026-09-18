#![cfg(target_os = "linux")]
//! Executable queue fixtures: loopback provider only, no tools or paid calls.
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    process::{Output, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{Semaphore, mpsc},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
struct Gateway {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    gate: Arc<Semaphore>,
    seen: mpsc::Receiver<usize>,
    stop: CancellationToken,
    task: JoinHandle<()>,
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop.cancel();
        self.task.abort();
    }
}
impl Gateway {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/responses", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let gate = Arc::new(Semaphore::new(0));
        let permits = gate.clone();
        let stop = CancellationToken::new();
        let cancel = stop.clone();
        let (tx, seen) = mpsc::channel(100);
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) =
                    tokio::select! {_=cancel.cancelled()=>break,v=listener.accept()=>v.unwrap()};
                let captures = captured.clone();
                let gate = permits.clone();
                let notify = tx.clone();
                let cancel = cancel.clone();
                tokio::spawn(async move {
                    let request = read_request(&mut socket).await;
                    let index = {
                        let mut v = captures.lock().unwrap();
                        v.push(request);
                        v.len()
                    };
                    notify.send(index).await.unwrap();
                    if index == 1 {
                        tokio::select! {_=cancel.cancelled()=>return,p=gate.acquire()=>p.unwrap().forget()}
                    }
                    let body = format!(
                        "data: {}\n\n",
                        json!({"type":"response.completed","response":{"id":format!("reply-{index}"),"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":format!("answer-{index}")}]}],"usage":{"input_tokens":2,"output_tokens":1}}})
                    );
                    let _=socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
                });
            }
        });
        Self {
            url,
            requests,
            gate,
            seen,
            stop,
            task,
        }
    }
    async fn first(&mut self) {
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), self.seen.recv())
                .await
                .unwrap(),
            Some(1)
        );
    }
    fn release(&self) {
        self.gate.add_permits(1);
    }
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}
async fn read_request(socket: &mut TcpStream) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut data = Vec::new();
        loop {
            let mut buf = [0; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert_ne!(n, 0);
            data.extend_from_slice(&buf[..n]);
            assert!(data.len() < 1_000_000);
            if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&data[..end]);
                let len = headers
                    .lines()
                    .find_map(|s| {
                        let (k, v) = s.split_once(':')?;
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                if data.len() >= end + 4 + len {
                    return serde_json::from_slice(&data[end + 4..end + 4 + len]).unwrap();
                }
            }
        }
    })
    .await
    .unwrap()
}
struct Fixture {
    dir: tempfile::TempDir,
    config: PathBuf,
    request: PathBuf,
    session: String,
}
impl Fixture {
    async fn new(gateway: &Gateway) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("file.txt"), "fixture").unwrap();
        let snapshot = zero_executor::pin_snapshot(&source).unwrap();
        let config = dir.path().join("providers.json");
        let request = dir.path().join("agent.json");
        std::fs::write(&config,json!({"fixture":{"url":gateway.url,"api_key_env":"QUEUE_FIXTURE_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":10000,"max_response_bytes":65536}}).to_string()).unwrap();
        std::fs::write(&request,json!({"provider":"fixture","model":"fixture","instructions":"fixture","prompt":"first prompt","max_turns":2,"reservation_per_turn":10,"execution":{"execution_id":"fixture","image":"local:no-tool","snapshot":snapshot,"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}}).to_string()).unwrap();
        let mut fixture = Self {
            dir,
            config,
            request,
            session: String::new(),
        };
        let result = output(
            fixture
                .cli()
                .args(["session", "create", "--budget-limit", "1000"]),
        )
        .await;
        fixture.session = parse(&result)["session"]["id"].as_str().unwrap().into();
        fixture
    }
    fn cli(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        c.arg("--state").arg(self.dir.path().join("state.db"));
        c
    }
    fn configured(&self) -> Command {
        let mut c = self.cli();
        c.arg("--providers")
            .arg(&self.config)
            .env("QUEUE_FIXTURE_KEY", "fixture-secret");
        c
    }
    fn console(&self) -> Command {
        let mut c = self.configured();
        c.args(["console", "--session", &self.session, "--request"])
            .arg(&self.request);
        c
    }
    fn enqueue(&self, command: &str, after: Option<&str>) -> Command {
        let mut c = self.configured();
        c.args([
            "queue",
            "enqueue",
            "--session",
            &self.session,
            "--command-id",
            command,
            "--request",
        ])
        .arg(&self.request);
        if let Some(id) = after {
            c.args(["--after-input", id]);
        }
        c
    }
    async fn list(&self) -> Vec<Value> {
        let result = output(
            self.cli()
                .args(["queue", "list", "--session", &self.session]),
        )
        .await;
        parse(&result)["inputs"].as_array().unwrap().clone()
    }
    fn run(&self, id: &str) -> Command {
        let mut c = self.configured();
        c.args(["queue", "run", "--session", &self.session, "--input", id]);
        c
    }
}
async fn output(command: &mut Command) -> Output {
    tokio::time::timeout(Duration::from_secs(12), command.output())
        .await
        .unwrap()
        .unwrap()
}
fn parse(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
async fn diagnostic(reader: &mut BufReader<tokio::process::ChildStderr>, prefix: &str) -> String {
    tokio::time::timeout(Duration::from_secs(6), async {
        loop {
            let mut line = String::new();
            assert_ne!(
                reader.read_line(&mut line).await.unwrap(),
                0,
                "missing {prefix}"
            );
            if line.starts_with(prefix) {
                return line.trim().into();
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn console_acknowledges_while_running_preserves_partial_line_and_drains_eof_fifo() {
    let mut gateway = Gateway::new().await;
    let fixture = Fixture::new(&gateway).await;
    let mut child = fixture
        .console()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    input.write_all(b"first prompt\n").await.unwrap();
    let first = diagnostic(&mut stderr, "queued input ").await;
    gateway.first().await;
    input.write_all(b"second prompt\npar").await.unwrap();
    let second = diagnostic(&mut stderr, "queued input ").await;
    assert_ne!(first, second);
    assert_eq!(gateway.count(), 1);
    gateway.release();
    diagnostic(&mut stderr, "checkpoint operation ").await;
    input.write_all(b"tial third prompt").await.unwrap();
    drop(input);
    let diagnostics = tokio::spawn(async move {
        let mut text = String::new();
        stderr.read_to_string(&mut text).await.unwrap();
        text
    });
    let result = tokio::time::timeout(Duration::from_secs(10), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(result.status.success(), "{}", diagnostics.await.unwrap());
    assert_eq!(
        String::from_utf8(result.stdout).unwrap(),
        "answer-1\nanswer-2\nanswer-3\n"
    );
    let requests = gateway.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(
        requests[1]["input"].as_array().unwrap().last().unwrap()["content"],
        "second prompt"
    );
    assert_eq!(
        requests[2]["input"].as_array().unwrap().last().unwrap()["content"],
        "partial third prompt"
    );
    assert!(
        requests[2]["input"].to_string().contains("answer-1")
            && requests[2]["input"].to_string().contains("answer-2")
    );
    drop(requests);
    let rows = fixture.list().await;
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|row| row["status"] == "succeeded"));
    assert_eq!(rows[1]["after_input"], rows[0]["id"]);
    assert_eq!(rows[2]["after_input"], rows[1]["id"]);
}

#[tokio::test]
async fn explicit_queue_restart_retry_cancel_and_fifo_do_not_repeat_effects() {
    let gateway = Gateway::new().await;
    gateway.release();
    let fixture = Fixture::new(&gateway).await;
    let first = parse(&output(&mut fixture.enqueue("first", None)).await);
    let id = first["input"]["id"].as_str().unwrap();
    assert_eq!(gateway.count(), 0);
    let duplicate = parse(&output(&mut fixture.enqueue("first", None)).await);
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(duplicate["input"]["id"], id);
    let second = parse(&output(&mut fixture.enqueue("second", Some(id))).await);
    let second_id = second["input"]["id"].as_str().unwrap();
    let blocked = output(&mut fixture.run(second_id)).await;
    assert!(!blocked.status.success());
    assert_eq!(gateway.count(), 0);
    let result = parse(&output(&mut fixture.run(id)).await);
    assert_eq!(result["operation"]["status"], "succeeded");
    let repeated = parse(&output(&mut fixture.run(id)).await);
    assert_eq!(repeated["duplicate"], true);
    assert_eq!(gateway.count(), 1);
    let result = parse(
        &output(fixture.cli().args([
            "queue",
            "cancel",
            "--session",
            &fixture.session,
            "--input",
            second_id,
        ]))
        .await,
    );
    assert_eq!(result["input"]["status"], "cancelled");
    assert!(!output(&mut fixture.run(second_id)).await.status.success());
    assert_eq!(gateway.count(), 1);
}

#[tokio::test]
async fn signal_keeps_acknowledged_followup_pending_and_unknown_parent_cannot_continue() {
    let mut gateway = Gateway::new().await;
    let fixture = Fixture::new(&gateway).await;
    let mut child = fixture
        .console()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    stdin.write_all(b"first\n").await.unwrap();
    diagnostic(&mut stderr, "queued input ").await;
    gateway.first().await;
    stdin.write_all(b"durable follow-up\n").await.unwrap();
    let ack = diagnostic(&mut stderr, "queued input ").await;
    assert!(
        Command::new("kill")
            .args(["-TERM", &child.id().unwrap().to_string()])
            .status()
            .await
            .unwrap()
            .success()
    );
    let diagnostics = tokio::spawn(async move {
        let mut text = String::new();
        stderr.read_to_string(&mut text).await.unwrap();
        text
    });
    let output = tokio::time::timeout(Duration::from_secs(6), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(diagnostics.await.unwrap().contains("Stopped at operation"));
    drop(stdin);
    let rows = fixture.list().await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["status"], "unknown");
    assert_eq!(rows[1]["status"], "pending");
    let id = rows[1]["id"].as_str().unwrap();
    assert_eq!(ack, format!("queued input {id}"));
    assert!(!crate::output(&mut fixture.run(id)).await.status.success());
    assert_eq!(gateway.count(), 1);
}
async fn send(input: &mut tokio::process::ChildStdin, id: &str, command: Value) {
    let mut params = command.as_object().unwrap().clone();
    let method = params.remove("type").unwrap();
    let command = if params.is_empty() {
        json!({"method":method})
    } else {
        json!({"method":method,"params":params})
    };
    let request =
        json!({"protocol_version":zero_protocol::PROTOCOL_VERSION,"id":id,"command":command});
    input
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
}
async fn response(reader: &mut BufReader<tokio::process::ChildStdout>, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(6), async {
        loop {
            let mut line = String::new();
            assert_ne!(
                reader.read_line(&mut line).await.unwrap(),
                0,
                "missing response {id}"
            );
            let value: Value = serde_json::from_str(&line).unwrap();
            if value["id"] == id {
                return value["reply"].clone();
            }
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn appserver_can_enqueue_and_cancel_pending_input_while_queued_turn_is_active() {
    let mut gateway = Gateway::new().await;
    let fixture = Fixture::new(&gateway).await;
    let mut child = fixture
        .configured()
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    send(&mut input, "init", json!({"type":"initialize"})).await;
    assert_eq!(response(&mut reader, "init").await["type"], "initialized");
    let request: Value = serde_json::from_slice(&std::fs::read(&fixture.request).unwrap()).unwrap();
    send(&mut input,"enqueue",json!({"type":"queue_agent","session_id":fixture.session,"command_id":"first","request":request,"after_input":null})).await;
    let first = response(&mut reader, "enqueue").await;
    let first_id = first["input"]["id"].as_str().unwrap();
    send(
        &mut input,
        "run",
        json!({"type":"run_queued_agent","session_id":fixture.session,"input_id":first_id}),
    )
    .await;
    gateway.first().await;
    send(&mut input,"enqueue-next",json!({"type":"queue_agent","session_id":fixture.session,"command_id":"next","request":request,"after_input":first_id})).await;
    let second = response(&mut reader, "enqueue-next").await;
    assert_eq!(second["type"], "agent_queued");
    assert_eq!(second["input"]["status"], "pending");
    let second_id = second["input"]["id"].as_str().unwrap();
    send(
        &mut input,
        "cancel-next",
        json!({"type":"cancel_queued_agent","session_id":fixture.session,"input_id":second_id}),
    )
    .await;
    assert_eq!(
        response(&mut reader, "cancel-next").await["input"]["status"],
        "cancelled"
    );
    assert_eq!(gateway.count(), 1);
    drop(input);
    let drain = tokio::spawn(async move {
        let mut remaining = String::new();
        reader.read_to_string(&mut remaining).await.unwrap();
        remaining
    });
    let result = tokio::time::timeout(Duration::from_secs(6), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(drain.await.unwrap().contains("unknown"));
    let rows = fixture.list().await;
    assert_eq!(rows[0]["status"], "unknown");
    assert_eq!(rows[1]["status"], "cancelled");
}

#[tokio::test]
async fn queue_help_and_schema_do_not_load_configs_or_create_state() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("absent.db");
    for args in [vec!["queue", "enqueue", "--help"], vec!["schema"]] {
        let result = output(
            Command::new(env!("CARGO_BIN_EXE_0sec-native"))
                .arg("--state")
                .arg(&db)
                .arg("--providers")
                .arg(dir.path().join("missing.json"))
                .args(args),
        )
        .await;
        assert!(result.status.success());
        assert!(!db.exists());
    }
}
