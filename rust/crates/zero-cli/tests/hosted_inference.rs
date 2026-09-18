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

struct Gateway {
    host: String,
    catalog: Arc<Mutex<Value>>,
    raw_catalog: Arc<Mutex<Option<String>>>,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Gateway {
    fn new(chat: bool, truncated: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let host = format!("http://{}/prefix", listener.local_addr().unwrap());
        let catalog = Arc::new(Mutex::new(
            json!({"object":"list","data":[{"id":"fixture","object":"model","owned_by":"fixture","provider":"fixture","upstream_model":"never-send-upstream","wire_api":if chat {"chat_completions"} else {"responses"},"context_length":16384,"max_output_tokens":8192,"pricing":{"input_per_million_usd":1.25,"cached_input_per_million_usd":0.25,"output_per_million_usd":2.5}}]}),
        ));
        let raw_catalog = Arc::new(Mutex::new(None::<String>));
        let raw = raw_catalog.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (c, r, s) = (catalog.clone(), requests.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !s.load(Ordering::SeqCst) {
                let mut socket = match listener.accept() {
                    Ok((socket, _)) => socket,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => panic!("{e}"),
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let (header, body) = loop {
                    let mut buf = [0; 4096];
                    let n = socket.read(&mut buf).unwrap();
                    assert_ne!(n, 0);
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        let header = String::from_utf8(bytes[..end].to_vec()).unwrap();
                        let len: usize = header
                            .lines()
                            .find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().unwrap())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + len {
                            let body = if len == 0 {
                                Value::Null
                            } else {
                                serde_json::from_slice(&bytes[end + 4..end + 4 + len]).unwrap()
                            };
                            break (header, body);
                        }
                    }
                };
                assert!(header.contains("Bearer fixture-secret"));
                let first = header.lines().next().unwrap().to_owned();
                r.lock().unwrap().push((first.clone(), body));
                let (kind, body) = if first.starts_with("GET ") {
                    assert_eq!(first, "GET /prefix/api/inference/v1/models HTTP/1.1");
                    (
                        "application/json",
                        raw.lock()
                            .unwrap()
                            .clone()
                            .unwrap_or_else(|| c.lock().unwrap().to_string()),
                    )
                } else {
                    assert_eq!(
                        first,
                        format!(
                            "POST /prefix/api/inference/v1/{} HTTP/1.1",
                            if chat {
                                "chat/completions"
                            } else {
                                "responses"
                            }
                        )
                    );
                    let body = if truncated {
                        "data: {}\n\n".to_owned()
                    } else if chat {
                        let chunks = [
                            json!({"id":"r1","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}),
                            json!({"id":"r1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
                            json!({"id":"r1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":4}}}),
                        ];
                        chunks
                            .into_iter()
                            .map(|c| format!("data: {c}\n\n"))
                            .collect::<String>()
                            + "data: [DONE]\n\n"
                    } else {
                        format!(
                            "data: {}\n\n",
                            json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":10,"output_tokens":2,"input_tokens_details":{"cached_tokens":4}}}})
                        )
                    };
                    ("text/event-stream", body)
                };
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        Self {
            host,
            catalog,
            raw_catalog,
            requests,
            stop,
            thread: Some(thread),
        }
    }
    fn posts(&self) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(h, _)| h.starts_with("POST "))
            .count()
    }
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn cli(dir: &TempDir) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    c.arg("--state").arg(dir.path().join("state.db"));
    c
}
fn session(dir: &TempDir) -> String {
    let out = cli(dir)
        .args(["session", "create", "--budget-limit", "100"])
        .output()
        .unwrap();
    assert!(out.status.success());
    serde_json::from_slice::<Value>(&out.stdout).unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn infer(
    dir: &TempDir,
    gateway: &Gateway,
    session: &str,
    model: &str,
    cap: u32,
) -> std::process::Output {
    let path = dir.path().join("request.json");
    std::fs::write(
        &path,
        json!({"model":model,"instructions":"test","input":[],"tools":[],"max_output_tokens":cap})
            .to_string(),
    )
    .unwrap();
    cli(dir)
        .args([
            "--hosted-model",
            "fixture",
            "--hosted-host",
            &gateway.host,
            "--hosted-token-env",
            "NATIVE_HOSTED_KEY",
            "--hosted-timeout-ms",
            "3000",
            "infer",
            "--session",
            session,
            "--command-id",
            "one",
            "--provider",
            "hosted",
            "--reservation",
            "80",
            "--request",
        ])
        .arg(path)
        .env("NATIVE_HOSTED_KEY", "fixture-secret")
        .output()
        .unwrap()
}
fn budget(dir: &TempDir, session: &str) -> Value {
    let out = cli(dir)
        .args(["session", "budget", session])
        .output()
        .unwrap();
    assert!(out.status.success());
    serde_json::from_slice::<Value>(&out.stdout).unwrap()["budget"].clone()
}
fn exercise(chat: bool, truncated: bool) {
    let dir = TempDir::new().unwrap();
    let gateway = Gateway::new(chat, truncated);
    let session = session(&dir);
    for duplicate in [false, true] {
        let out = infer(&dir, &gateway, &session, "fixture", 32);
        assert_eq!(
            out.status.success(),
            !truncated,
            "{} {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(!String::from_utf8_lossy(&out.stdout).contains("fixture-secret"));
        let reply: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(reply["duplicate"], duplicate);
        assert_eq!(
            reply["operation"]["status"],
            if truncated { "unknown" } else { "succeeded" }
        );
        let pin = &reply["operation"]["payload"]["hosted_catalog"];
        assert_eq!(pin["model"], "fixture");
        assert_eq!(pin["currency"], "USD");
        assert_eq!(pin["rates"]["input"], 1_250_000);
    }
    assert_eq!(gateway.posts(), 1);
    let b = budget(&dir, &session);
    assert_eq!(b["charged"], if truncated { 0 } else { 14 });
    assert_eq!(b["reserved"], if truncated { 80 } else { 0 });
    let requests = gateway.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|(h, _)| h.starts_with("GET "))
            .count(),
        2
    );
    assert_eq!(
        requests
            .iter()
            .find(|(h, _)| h.starts_with("POST "))
            .unwrap()
            .1["model"],
        "fixture"
    );
    drop(requests);
    gateway.catalog.lock().unwrap()["data"][0]["pricing"]["input_per_million_usd"] = json!(2);
    let changed = infer(&dir, &gateway, &session, "fixture", 32);
    assert!(!changed.status.success());
    assert_eq!(gateway.posts(), 1);
    assert_eq!(budget(&dir, &session), b);
}
#[test]
fn responses_quote_is_durable_and_price_drift_does_not_redispatch() {
    exercise(false, false);
}
#[test]
fn chat_quote_routes_alias_and_settles_cached_usage() {
    exercise(true, false);
}
#[test]
fn incomplete_hosted_stream_retains_reservation_without_redispatch() {
    exercise(false, true);
}
#[test]
fn model_and_output_policy_reject_before_dispatch() {
    let dir = TempDir::new().unwrap();
    let gateway = Gateway::new(false, false);
    let session = session(&dir);
    for (model, cap) in [("upstream", 32), ("fixture", 8193)] {
        assert!(!infer(&dir, &gateway, &session, model, cap).status.success());
    }
    assert_eq!(gateway.posts(), 0);
    let b = budget(&dir, &session);
    assert_eq!(b["charged"], 0);
    assert_eq!(b["reserved"], 0);
}
#[test]
fn metadata_skips_hosted_credentials_and_state() {
    let dir = TempDir::new().unwrap();
    for action in ["schema", "--help", "--version"] {
        let out = cli(&dir)
            .args([
                "--hosted-model",
                "fixture",
                "--hosted-host",
                "not-a-url",
                "--hosted-token-env",
                "NATIVE_HOSTED_KEY",
                action,
            ])
            .env_remove("NATIVE_HOSTED_KEY")
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(!dir.path().join("state.db").exists());
    }
}

#[test]
fn missing_model_and_unrepresentable_price_never_admit_inference() {
    let dir = TempDir::new().unwrap();
    let gateway = Gateway::new(false, false);
    let session = session(&dir);
    gateway.catalog.lock().unwrap()["data"][0]["id"] = json!("different");
    assert!(
        !infer(&dir, &gateway, &session, "fixture", 32)
            .status
            .success()
    );
    {
        let mut catalog = gateway.catalog.lock().unwrap();
        catalog["data"][0]["id"] = json!("fixture");
        catalog["data"][0]["pricing"]["input_per_million_usd"] = json!(1.25);
        *gateway.raw_catalog.lock().unwrap() =
            Some(catalog.to_string().replace("1.25", "1.00000000000000001"));
    }
    assert!(
        !infer(&dir, &gateway, &session, "fixture", 32)
            .status
            .success()
    );
    assert_eq!(gateway.posts(), 0);
    let b = budget(&dir, &session);
    assert_eq!(b["charged"], 0);
    assert_eq!(b["reserved"], 0);
    // The same command ID remains usable once metadata is valid: failures did
    // not create a durable paid-effect admission.
    *gateway.raw_catalog.lock().unwrap() = None;
    assert!(
        infer(&dir, &gateway, &session, "fixture", 32)
            .status
            .success()
    );
    assert_eq!(gateway.posts(), 1);
}

#[test]
fn model_listing_preserves_exact_decimal_bytes() {
    let dir = TempDir::new().unwrap();
    let gateway = Gateway::new(false, false);
    *gateway.raw_catalog.lock().unwrap() = Some(
        gateway
            .catalog
            .lock()
            .unwrap()
            .to_string()
            .replace("1.25", "1.00000000000000001"),
    );
    let out = cli(&dir)
        .args([
            "hosted",
            "--host",
            &gateway.host,
            "--token-env",
            "NATIVE_HOSTED_KEY",
            "models",
        ])
        .env("NATIVE_HOSTED_KEY", "fixture-secret")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("1.00000000000000001"));
    assert!(!dir.path().join("state.db").exists());
    assert_eq!(gateway.posts(), 0);
}
