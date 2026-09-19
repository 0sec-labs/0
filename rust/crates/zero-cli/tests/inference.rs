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

#[derive(Clone, Copy, PartialEq, Eq)]
enum FixtureProvider {
    Default,
    Azure,
    Copilot,
    Google,
}

fn exercise_inference(truncated: bool, provider: FixtureProvider) {
    let dir = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let path = if provider == FixtureProvider::Google {
        "/models/fixture:streamGenerateContent"
    } else {
        "/responses"
    };
    let url = format!("http://{}{path}", listener.local_addr().unwrap());
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
        let headers = String::from_utf8_lossy(&bytes);
        if provider == FixtureProvider::Google {
            assert!(headers.starts_with("POST /models/fixture:streamGenerateContent?alt=sse "));
            assert!(headers.contains("x-goog-api-key: fixture-secret"));
            assert!(!headers.to_ascii_lowercase().contains("authorization:"));
        } else if provider == FixtureProvider::Azure {
            assert!(headers.contains("api-key: fixture-secret"));
            assert!(!headers.to_ascii_lowercase().contains("authorization:"));
        } else {
            assert!(headers.contains("Bearer fixture-secret"));
        }
        if provider == FixtureProvider::Copilot {
            assert!(headers.contains("copilot-integration-id: vscode-chat"));
            assert!(headers.contains("x-initiator: user"));
            assert!(!headers.contains("x-api-key:"));
        }
        let event = json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":2,"output_tokens":1}}});
        let body = if provider == FixtureProvider::Google {
            let mut event = json!({"responseId":"g1","candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]}}]});
            if !truncated {
                event["candidates"][0]["finishReason"] = json!("STOP");
                event["usageMetadata"] =
                    json!({"promptTokenCount":2,"candidatesTokenCount":1,"totalTokenCount":3});
            }
            format!("data: {event}\n\n")
        } else if provider == FixtureProvider::Copilot {
            let initial = json!({"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":if truncated { serde_json::Value::Null } else { json!("stop") }}]});
            if truncated {
                format!("data: {initial}\n\n")
            } else {
                format!(
                    "data: {initial}\n\ndata: {}\n\ndata: [DONE]\n\n",
                    json!({"id":"c1","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}})
                )
            }
        } else if truncated {
            "data: {\"type\":\"response.created\"}\n\n".to_owned()
        } else {
            format!("data: {event}\n\n")
        };
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        // Return listener alive to detect a second request during durable retry.
        listener
    });
    let config = dir.path().join("providers.json");
    let mut profiles = json!({"fixture":{"url":url,"api_key_env":"FIXTURE_PROVIDER_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":1000,"max_response_bytes":8192}});
    if provider == FixtureProvider::Azure {
        profiles["fixture"]["authentication"] = json!("azure_api_key");
    }
    if provider == FixtureProvider::Copilot {
        profiles["fixture"]["authentication"] = json!("github_copilot");
        profiles["fixture"]["wire_api"] = json!("chat_completions");
    }
    if provider == FixtureProvider::Google {
        profiles["fixture"]["wire_api"] = json!("google_generate_content");
    }
    std::fs::write(&config, profiles.to_string()).unwrap();
    let request = dir.path().join("request.json");
    std::fs::write(&request, json!({"model":"fixture","instructions":"test","input":[{"role":"user","content":"test"}],"tools":[],"max_output_tokens":32}).to_string()).unwrap();
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
    exercise_inference(false, FixtureProvider::Default);
}

#[test]
fn unknown_inference_reconciles_charge_without_retrying_provider() {
    exercise_inference(true, FixtureProvider::Default);
}

#[test]
fn azure_inference_charges_once_and_retries_without_second_request() {
    exercise_inference(false, FixtureProvider::Azure);
}

#[test]
fn azure_unknown_inference_preserves_hold_until_reconciled() {
    exercise_inference(true, FixtureProvider::Azure);
}

#[test]
fn copilot_inference_uses_explicit_auth_and_charges_exactly_once() {
    exercise_inference(false, FixtureProvider::Copilot);
}

#[test]
fn copilot_unknown_inference_retains_billing_hold_without_replay() {
    exercise_inference(true, FixtureProvider::Copilot);
}

#[test]
fn google_native_cli_accounting_and_exact_retry() {
    exercise_inference(false, FixtureProvider::Google);
    exercise_inference(true, FixtureProvider::Google);
}
