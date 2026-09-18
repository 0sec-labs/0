use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    time::Duration,
};
use tempfile::TempDir;

fn cli(dir: &TempDir) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    command.arg("--state").arg(dir.path().join("state.db"));
    command
}

#[test]
fn metadata_commands_skip_provider_files_and_credentials() {
    let dir = TempDir::new().unwrap();
    for action in ["schema", "--help", "--version"] {
        let output = cli(&dir)
            .arg("--providers")
            .arg(dir.path().join("nonexistent.json"))
            .arg(action)
            .env_remove("FIXTURE_PROVIDER_KEY")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(!dir.path().join("state.db").exists());
    }
}

fn exercise_inference(truncated: bool) {
    let dir = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(std::time::Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("{error}"),
            }
        };
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut buf = [0; 4096];
            let count = socket.read(&mut buf).unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&buf[..count]);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        assert!(String::from_utf8_lossy(&bytes).contains("Bearer fixture-secret"));
        let event = json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":2,"output_tokens":1}}});
        let body = if truncated {
            "data: {\"type\":\"response.created\"}\n\n".to_owned()
        } else {
            format!("data: {event}\n\n")
        };
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        // Return listener alive to detect a second request during durable retry.
        listener
    });
    let config = dir.path().join("providers.json");
    std::fs::write(&config, json!({"fixture":{"url":url,"api_key_env":"FIXTURE_PROVIDER_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":1000,"max_response_bytes":8192}}).to_string()).unwrap();
    let request = dir.path().join("request.json");
    std::fs::write(&request, json!({"model":"fixture","instructions":"test","input":[],"tools":[],"max_output_tokens":32}).to_string()).unwrap();
    let created = cli(&dir)
        .args(["session", "create", "--budget-limit", "100"])
        .output()
        .unwrap();
    assert!(created.status.success());
    let created: Value = serde_json::from_slice(&created.stdout).unwrap();
    let session = created["session"]["id"].as_str().unwrap();
    for duplicate in [false, true] {
        let output = cli(&dir)
            .arg("--providers")
            .arg(&config)
            .args([
                "infer",
                "--session",
                session,
                "--command-id",
                "inference-one",
                "--provider",
                "fixture",
                "--reservation",
                "10",
                "--request",
            ])
            .arg(&request)
            .env("FIXTURE_PROVIDER_KEY", "fixture-secret")
            .output()
            .unwrap();
        assert!(
            output.status.success() != truncated,
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains("fixture-secret"));
        let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(reply["duplicate"], duplicate);
        assert_eq!(
            reply["operation"]["status"],
            if truncated { "unknown" } else { "succeeded" }
        );
        if truncated && !duplicate {
            let initial = cli(&dir)
                .args(["session", "budget", session])
                .output()
                .unwrap();
            let initial: Value = serde_json::from_slice(&initial.stdout).unwrap();
            assert_eq!(initial["budget"]["reserved"], 10);
            assert_eq!(initial["budget"]["charged"], 0);
            let operation = reply["operation"]["id"].as_str().unwrap();
            let reconciled = cli(&dir)
                .args([
                    "session",
                    "reconcile-usage",
                    session,
                    "--operation",
                    operation,
                    "--charged",
                    "3",
                    "--evidence",
                    "operator receipt fixture; not cryptographically verified",
                ])
                .output()
                .unwrap();
            assert!(
                reconciled.status.success(),
                "{} {}",
                String::from_utf8_lossy(&reconciled.stdout),
                String::from_utf8_lossy(&reconciled.stderr)
            );
            let reconciled: Value = serde_json::from_slice(&reconciled.stdout).unwrap();
            assert_eq!(reconciled["budget"]["reserved"], 0);
            assert_eq!(reconciled["budget"]["charged"], 3);
            let events = cli(&dir)
                .args(["session", "events", session])
                .output()
                .unwrap();
            assert!(events.status.success());
            let events: Value = serde_json::from_slice(&events.stdout).unwrap();
            assert!(
                events["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["payload"]["evidence"]
                        == "operator receipt fixture; not cryptographically verified")
            );
        }
    }
    let listener = server.join().unwrap();
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
    );
    let budget = cli(&dir)
        .args(["session", "budget", session])
        .output()
        .unwrap();
    let budget: Value = serde_json::from_slice(&budget.stdout).unwrap();
    assert_eq!(budget["budget"]["charged"], 3);
    assert_eq!(budget["budget"]["reserved"], 0);
}

#[test]
fn inference_persists_exact_retry_without_second_http_request() {
    exercise_inference(false);
}

#[test]
fn unknown_inference_reconciles_charge_without_retrying_provider() {
    exercise_inference(true);
}
