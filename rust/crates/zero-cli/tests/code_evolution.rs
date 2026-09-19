#![cfg(target_os = "linux")]
#[path = "../../zero-evaluation/tests/support/python_fixture.rs"]
mod fixture;
use fixture::*;
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};
fn cli(f: &Fixture) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    command
        .arg("--state")
        .arg(f.dir.path().join("state.sqlite"));
    command
}
fn run_command(f: &Fixture) -> Command {
    let mut command = cli(f);
    command
        .arg("--providers")
        .arg(f.dir.path().join("providers.json"))
        .arg("--docker-bin")
        .arg(f.dir.path().join("docker"))
        .args([
            "evolve-python",
            "run",
            "--session",
            &f.context.session_id,
            "--command-id",
            &f.context.command_id,
            "--source-registry",
        ])
        .arg(f.dir.path().join("production.sqlite"))
        .arg("--plan")
        .arg(f.dir.path().join("plan.json"))
        .arg("--grants")
        .arg(f.dir.path().join("grants.json"))
        .arg("--output-dir")
        .arg(f.root())
        .env("PYTHON_FIXTURE_KEY", "fixture-only");
    command
}
fn files(f: &Fixture, url: &str) {
    fs::write(
        f.dir.path().join("plan.json"),
        serde_json::to_vec(&f.plan).unwrap(),
    )
    .unwrap();
    fs::write(
        f.dir.path().join("grants.json"),
        json!({"fixture":{"enabled":true,"trusted":false,"grants":["compute"]}}).to_string(),
    )
    .unwrap();
    fs::write(f.dir.path().join("providers.json"),json!({"fixture":{"url":url,"api_key_env":"PYTHON_FIXTURE_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":5000,"max_response_bytes":65536}}).to_string()).unwrap();
}
fn provider(
    f: &Fixture,
    output: Value,
    usage: bool,
    delay: Duration,
) -> std::thread::JoinHandle<TcpListener> {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    files(
        f,
        &format!("http://{}/responses", listener.local_addr().unwrap()),
    );
    let request_path = f.dir.path().join("provider-request.json");
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "provider admission absent");
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("{e}"),
            }
        };
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = vec![];
        let body = loop {
            let mut buf = [0; 4096];
            let count = socket.read(&mut buf).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buf[..count]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
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
                    break bytes[end + 4..end + 4 + length].to_vec();
                }
            }
        };
        fs::write(request_path, &body).unwrap();
        let request = String::from_utf8(body).unwrap();
        assert!(!request.contains("HELDOUT_PRIVATE_SENTINEL"));
        assert!(!request.contains("NEGATIVE_PRIVATE_SENTINEL"));
        let mut event = json!({"type":"response.completed","response":{"id":"python-fixture","status":"completed","output":[{"type":"function_call","call_id":"candidate-call","name":"submit_python_candidate","arguments":output.to_string()}]}});
        if usage {
            event["response"]["usage"] = json!({"input_tokens":2,"output_tokens":1});
        }
        let body = format!("data: {event}\n\n");
        std::thread::sleep(delay);
        let _ = write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        listener
    })
}
fn proposal(source: &str) -> Value {
    json!({"action":"propose","source_utf8":source,"rationale":"Preserve the input value"})
}
fn report(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|e| {
        panic!(
            "{e}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}
#[test]
fn actual_model_proposal_runs_python_evaluator_and_exact_retry_needs_no_credentials() {
    let f = Fixture::new();
    let before = f.source.current().unwrap();
    let server = provider(&f, proposal(CANDIDATE), true, Duration::ZERO);
    let output = run_command(&f).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let measured = report(&output);
    assert_eq!(measured["phase"], "completed");
    assert_eq!(measured["evaluation"]["report"]["decision"], "eligible");
    assert_eq!(measured["evaluation"]["report"]["settled"], 12);
    assert_eq!(measured["exposure"]["proposal_charge"], 3);
    let listener = server.join().unwrap();
    let calls = fs::read(f.dir.path().join("calls.jsonl")).unwrap();
    let providers = fs::read(f.dir.path().join("providers.json")).unwrap();
    // A fresh physical controller with the same session/command must not replay.
    let alternate = run_command(&f);
    let args: Vec<_> = alternate.get_args().map(|v| v.to_os_string()).collect();
    let envs: Vec<_> = alternate
        .get_envs()
        .map(|(k, v)| (k.to_os_string(), v.map(|v| v.to_os_string())))
        .collect();
    let mut alternate = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    for arg in args {
        if arg == f.root().as_os_str() {
            alternate.arg(f.dir.path().join("second-controller"));
        } else {
            alternate.arg(arg);
        }
    }
    for (key, value) in envs {
        if let Some(value) = value {
            alternate.env(key, value);
        }
    }
    let other = alternate.output().unwrap();
    assert!(!other.status.success());
    assert!(listener.accept().is_err());
    assert_eq!(fs::read(f.dir.path().join("calls.jsonl")).unwrap(), calls);
    fs::write(f.dir.path().join("providers.json"), providers).unwrap();
    fs::remove_file(f.dir.path().join("providers.json")).unwrap();
    let retry = run_command(&f)
        .env_remove("PYTHON_FIXTURE_KEY")
        .output()
        .unwrap();
    assert!(
        retry.status.success(),
        "{}",
        String::from_utf8_lossy(&retry.stderr)
    );
    assert_eq!(report(&retry), measured);
    assert!(listener.accept().is_err());
    assert_eq!(fs::read(f.dir.path().join("calls.jsonl")).unwrap(), calls);
    assert_eq!(f.source.current().unwrap(), before);
    let status = cli(&f)
        .args(["evolve-python", "status", "--directory"])
        .arg(f.root())
        .output()
        .unwrap();
    assert!(status.status.success());
    assert_eq!(report(&status), measured);
    let mut altered = f.plan.clone();
    altered.objective.push_str("different");
    fs::write(
        f.dir.path().join("plan.json"),
        serde_json::to_vec(&altered).unwrap(),
    )
    .unwrap();
    assert!(!run_command(&f).output().unwrap().status.success());
}
#[test]
fn missing_final_usage_holds_budget_and_prevents_all_candidate_execution() {
    let f = Fixture::new();
    let server = provider(&f, proposal(CANDIDATE), false, Duration::ZERO);
    let output = run_command(&f).output().unwrap();
    assert!(!output.status.success());
    let r = report(&output);
    assert_eq!(r["phase"], "proposal_rejected");
    assert!(r["candidate"].is_null());
    assert!(r["exposure"].is_null());
    assert!(!f.dir.path().join("calls.jsonl").exists());
    assert_eq!(f.store.budget(&f.context.session_id).unwrap().reserved, 10);
    assert!(server.join().unwrap().accept().is_err());
}
#[test]
fn model_stop_and_self_certification_never_execute_or_consume_holdout() {
    for (value, phase, ok) in [
        (
            json!({"action":"stop","reason":"No sound change"}),
            "model_stop",
            true,
        ),
        (
            json!({"action":"propose","source_utf8":CANDIDATE,"rationale":"trust me","eligible":true}),
            "proposal_rejected",
            false,
        ),
    ] {
        let f = Fixture::new();
        let server = provider(&f, value, true, Duration::ZERO);
        let output = run_command(&f).output().unwrap();
        assert_eq!(
            output.status.success(),
            ok,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let r = report(&output);
        assert_eq!(r["phase"], phase);
        assert!(r["exposure"].is_null());
        assert!(!f.dir.path().join("calls.jsonl").exists());
        server.join().unwrap();
        assert_eq!(f.store.budget(&f.context.session_id).unwrap().charged, 3);
    }
}
#[test]
fn spent_budget_blocks_proposal_before_provider_contact() {
    let mut f = Fixture::new();
    let op = f
        .store
        .admit_command(&f.context.session_id, "prior", &json!({"kind":"fixture"}))
        .unwrap()
        .operation;
    f.store.begin_operation(&op.id, "fixture-owner").unwrap();
    f.store
        .reserve_budget(&f.context.session_id, &op.id, 100)
        .unwrap();
    f.store
        .settle_budget(&f.context.session_id, &op.id, 100)
        .unwrap();
    f.store
        .settle_operation(
            &op.id,
            "fixture-owner",
            zero_protocol::OperationStatus::Succeeded,
            &json!({}),
        )
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    files(
        &f,
        &format!("http://{}/responses", listener.local_addr().unwrap()),
    );
    let output = run_command(&f).output().unwrap();
    assert!(!output.status.success());
    assert_eq!(report(&output)["phase"], "inference_failed");
    assert!(listener.accept().is_err());
    assert!(!f.dir.path().join("calls.jsonl").exists());
}
#[test]
fn absolute_deadline_cancels_paid_proposal_without_guest_dispatch() {
    let mut f = Fixture::new();
    f.plan.expires_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 500;
    let server = provider(&f, proposal(CANDIDATE), true, Duration::from_millis(1500));
    let start = Instant::now();
    let output = run_command(&f).output().unwrap();
    assert!(!output.status.success());
    assert!(start.elapsed() < Duration::from_secs(4));
    assert_eq!(report(&output)["phase"], "cancelled");
    assert!(!f.dir.path().join("calls.jsonl").exists());
    assert_eq!(f.store.budget(&f.context.session_id).unwrap().reserved, 10);
    server.join().unwrap();
}
#[test]
fn cancellation_drains_owned_guest_and_retry_does_not_reset_exposure() {
    let mut f = Fixture::new();
    f.plan.launch.timeout_ms = 15000;
    fs::write(f.dir.path().join("scenario.txt"), "cancel").unwrap();
    let server = provider(&f, proposal(CANDIDATE), true, Duration::ZERO);
    let mut child = run_command(&f)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f.dir.path().join("child.pid").exists() {
        assert!(
            child.try_wait().unwrap().is_none(),
            "controller exited before guest"
        );
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        Command::new("kill")
            .args(["-INT", &child.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    while child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "cancellation did not drain");
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    let r = report(&output);
    assert_eq!(r["evaluation"]["report"]["decision"], "inconclusive");
    assert!(!r["exposure"].is_null());
    assert!(!f.dir.path().join("container.json").exists());
    let calls = fs::read(f.dir.path().join("calls.jsonl")).unwrap();
    server.join().unwrap();
    let retry = run_command(&f)
        .env_remove("PYTHON_FIXTURE_KEY")
        .output()
        .unwrap();
    assert!(!retry.status.success());
    assert_eq!(report(&retry), r);
    assert_eq!(fs::read(f.dir.path().join("calls.jsonl")).unwrap(), calls);
}

#[test]
#[ignore = "requires explicitly selected existing local Python Docker image; never pulls"]
fn real_docker_loopback_model_proposal_qualification() {
    let image = std::env::var("ZERO_PYTHON_EVOLUTION_DOCKER_IMAGE").unwrap();
    let mut f = Fixture::new();
    f.plan.launch.backend = zero_protocol::sandbox::SandboxBackend::Docker { image };
    f.plan.launch.timeout_ms = 5000;
    let server = provider(&f, proposal(CANDIDATE), true, Duration::ZERO);
    let original = run_command(&f);
    let mut command = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    for arg in original.get_args() {
        if arg == f.dir.path().join("docker").as_os_str() {
            command.arg("docker");
        } else {
            command.arg(arg);
        }
    }
    command.env("PYTHON_FIXTURE_KEY", "fixture-only");
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let measured = report(&output);
    assert_eq!(measured["phase"], "completed");
    assert_eq!(measured["evaluation"]["report"]["settled"], 12);
    assert_eq!(measured["evaluation"]["report"]["decision"], "eligible");
    assert!(server.join().unwrap().accept().is_err());
}
