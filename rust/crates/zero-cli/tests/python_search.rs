#![cfg(target_os = "linux")]
#[path = "../../zero-evaluation/tests/support/python_fixture.rs"]
mod fixture;
use fixture::*;
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Output},
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
            "search",
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
        serde_json::to_vec(&json!({"schema_version":1,"proposal":f.plan,"max_rounds":4,"max_proposal_spend":40,"max_development_attempts":8})).unwrap(),
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
    rounds: Vec<(&'static str, Value, Option<u64>)>,
) -> std::thread::JoinHandle<TcpListener> {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    files(
        f,
        &format!("http://{}/responses", listener.local_addr().unwrap()),
    );
    std::thread::spawn(move || {
        for (index, (tool, args, charge)) in rounds.into_iter().enumerate() {
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut socket = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "provider round {index} absent");
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
                let n = socket.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            let (n, v) = line.split_once(':')?;
                            n.eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break bytes[end + 4..end + 4 + length].to_vec();
                    }
                }
            };
            let request = String::from_utf8(body).unwrap();
            assert!(!request.contains("HELDOUT_PRIVATE_SENTINEL"));
            assert!(!request.contains("NEGATIVE_PRIVATE_SENTINEL"));
            let wire: Value = serde_json::from_str(&request).unwrap();
            let public: Value =
                serde_json::from_str(wire["input"][0]["content"][0]["text"].as_str().unwrap())
                    .unwrap();
            assert_eq!(public["round"], index);
            assert_eq!(
                public["measured_development_feedback"]
                    .as_array()
                    .unwrap()
                    .len(),
                index
            );
            if index > 0 {
                assert_eq!(
                    public["measured_development_feedback"][index - 1]["settled"],
                    2
                );
                assert_eq!(
                    public["measured_development_feedback"][index - 1]["completed"],
                    true
                );
            }
            let mut event = json!({"type":"response.completed","response":{"id":format!("search-{index}"),"status":"completed","output":[{"type":"function_call","call_id":format!("call-{index}"),"name":tool,"arguments":args.to_string()}]}});
            if let Some(charge) = charge {
                event["response"]["usage"] = json!({"input_tokens":charge-1,"output_tokens":1});
            }
            let body = format!("data: {event}\n\n");
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        listener
    })
}
fn experiment(source: &str) -> (&'static str, Value, Option<u64>) {
    (
        "experiment_python_candidate",
        json!({"source_utf8":source,"rationale":"test hypothesis"}),
        Some(3),
    )
}
fn select(source: &str) -> (&'static str, Value, Option<u64>) {
    (
        "submit_python_candidate",
        json!({"action":"propose","source_utf8":source,"rationale":"select measured implementation"}),
        Some(3),
    )
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
fn qualify(real: bool) {
    let mut f = Fixture::new();
    if real {
        f.plan.launch.backend = zero_protocol::sandbox::SandboxBackend::Docker {
            image: std::env::var("ZERO_PYTHON_EVOLUTION_DOCKER_IMAGE").unwrap(),
        };
        f.plan.launch.timeout_ms = 5000;
    }
    let before = f.source.current().unwrap();
    let server = provider(
        &f,
        vec![experiment(CHEAT), experiment(CANDIDATE), select(CANDIDATE)],
    );
    let mut command = run_command(&f);
    if real {
        let original = command;
        command = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        for arg in original.get_args() {
            if arg == f.dir.path().join("docker").as_os_str() {
                command.arg("docker");
            } else {
                command.arg(arg);
            }
        }
        command.env("PYTHON_FIXTURE_KEY", "fixture-only");
    }
    let out = command.output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let measured = report(&out);
    assert_eq!(measured["phase"], "completed");
    assert_eq!(measured["charged"], 9);
    assert_eq!(measured["rounds"], 3);
    assert_eq!(measured["development_attempts"], 4);
    assert_eq!(measured["evaluation"]["report"]["decision"], "eligible");
    assert_eq!(measured["evaluation"]["report"]["settled"], 12);
    let listener = server.join().unwrap();
    assert!(listener.accept().is_err());
    assert_eq!(f.source.current().unwrap(), before);
    fs::remove_file(f.dir.path().join("providers.json")).unwrap();
    let out = run_command(&f)
        .env_remove("PYTHON_FIXTURE_KEY")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(report(&out), measured);
    assert!(listener.accept().is_err());
}
#[test]
fn model_chooses_experiments_then_selects_once_with_public_feedback() {
    qualify(false);
}
#[test]
fn uncertain_accounting_and_final_overrun_stop_before_new_guest_effects() {
    for missing_usage in [true, false] {
        let f = Fixture::new();
        let rounds = if missing_usage {
            let mut e = experiment(CANDIDATE);
            e.2 = None;
            vec![e]
        } else {
            let mut s = select(CANDIDATE);
            s.2 = Some(11);
            vec![experiment(CANDIDATE), s]
        };
        let server = provider(&f, rounds);
        if !missing_usage {
            let mut plan: Value =
                serde_json::from_slice(&fs::read(f.dir.path().join("plan.json")).unwrap()).unwrap();
            plan["max_proposal_spend"] = json!(13);
            fs::write(
                f.dir.path().join("plan.json"),
                serde_json::to_vec(&plan).unwrap(),
            )
            .unwrap();
        }
        let out = run_command(&f).output().unwrap();
        assert!(!out.status.success());
        let r = report(&out);
        assert_eq!(
            r["phase"],
            if missing_usage {
                "inference_failed"
            } else {
                "budget_limit"
            }
        );
        assert!(!f.root().join("evaluation").exists());
        if missing_usage {
            assert!(!f.dir.path().join("calls.jsonl").exists());
            let budget = f.store.budget(&f.context.session_id).unwrap();
            assert_eq!(budget.reserved, 10);
        }
        assert!(server.join().unwrap().accept().is_err());
    }
}
#[test]
#[ignore = "requires explicit existing immutable local Python Docker image; never pulls"]
fn real_docker_model_directed_python_search() {
    qualify(true);
}
