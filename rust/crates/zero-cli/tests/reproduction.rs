#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};
use zero_protocol::verification::{
    Case, ExactOutput, Limits, Mode, Plan, SourceReproductionRequest,
};

#[path = "support/repair_export.rs"]
mod repair_export;

struct Fixture {
    dir: tempfile::TempDir,
    session: String,
    listener: TcpListener,
    request: SourceReproductionRequest,
    real: bool,
}
impl Fixture {
    fn new(image: Option<String>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join("app.js"),
            b"process.stdout.write(require('fs').readFileSync(0));\n",
        )
        .unwrap();
        let snapshot = zero_executor::pin_snapshot(&source).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/responses", listener.local_addr().unwrap());
        let digest = snapshot.files[0].digest.clone();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline);
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buf = [0; 4096];
                let n = socket.read(&mut buf).unwrap();
                assert_ne!(n, 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                    let h = String::from_utf8_lossy(&bytes[..end]);
                    let len: usize = h
                        .lines()
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            k.eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            let arguments=json!({"hypotheses":[{"title":"Echo fixture hypothesis","claimed_severity":"low","explanation":"Requires explicit oracle observation","citations":[{"path":"app.js","sha256":digest,"start_line":1,"end_line":1}]}]}).to_string();
            let event = json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"function_call","id":"fc1","call_id":"submit-1","name":"submit_source_hypotheses","arguments":arguments}],"usage":{"input_tokens":1,"output_tokens":1}}});
            let body = format!("data: {event}\n\n");
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            listener
        });
        fs::write(dir.path().join("providers.json"),json!({"fixture":{"url":url,"api_key_env":"REPRO_TEST_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":3000,"max_response_bytes":32768}}).to_string()).unwrap();
        fs::write(dir.path().join("review.json"),json!({"provider":"fixture","model":"fixture","reservation":10,"source":{"snapshot":snapshot,"selected_files":["app.js"],"question":"Assess fixture","max_hypotheses":1}}).to_string()).unwrap();
        let base = || {
            let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
            c.current_dir(dir.path()).args(["--state", "state.db"]);
            c
        };
        let created = parsed(
            &base()
                .args(["session", "create", "--budget-limit", "100"])
                .output()
                .unwrap(),
        );
        let session = created["session"]["id"].as_str().unwrap().to_owned();
        let reviewed = parsed(
            &base()
                .args([
                    "--providers",
                    "providers.json",
                    "source-review",
                    "--session",
                    &session,
                    "--command-id",
                    "review",
                    "--request",
                    "review.json",
                ])
                .env("REPRO_TEST_KEY", "fixture-secret")
                .output()
                .unwrap(),
        );
        let listener = server.join().unwrap();
        let real = image.is_some();
        let stderr = if real {
            vec![]
        } else {
            b"fixture diagnostic\n".to_vec()
        };
        let plan = Plan {
            schema_version: 1,
            oracle_version: "zero-verification-exact-output-v1".into(),
            hypothesis_id: reviewed["result"]["review"]["hypotheses"][0]["id"]
                .as_str()
                .unwrap()
                .into(),
            source_bundle_digest: reviewed["result"]["review"]["bundle_sha256"]
                .as_str()
                .unwrap()
                .into(),
            snapshot,
            backend: zero_protocol::sandbox::SandboxBackend::Docker {
                image: image.unwrap_or_else(|| format!("sha256:{}", "a".repeat(64))),
            },
            limits: Limits {
                timeout_ms: if real { 30000 } else { 3000 },
                memory_mb: 128,
                cpus: 0.5,
                max_output_bytes: 4096,
            },
            repeats: 2,
            cases: vec![
                Case {
                    id: "attack".into(),
                    mode: Mode::Attack,
                    argv: vec!["node".into(), "app.js".into()],
                    stdin: Some("attack\n".into()),
                    expected: ExactOutput {
                        exit_code: 0,
                        stdout: b"attack\n".to_vec(),
                        stderr: stderr.clone(),
                    },
                    safe_expected: None,
                },
                Case {
                    id: "control".into(),
                    mode: Mode::LegitimateControl,
                    argv: vec!["node".into(), "app.js".into()],
                    stdin: Some("control\n".into()),
                    expected: ExactOutput {
                        exit_code: 0,
                        stdout: b"control\n".to_vec(),
                        stderr,
                    },
                    safe_expected: None,
                },
            ],
        };
        let request = SourceReproductionRequest {
            source_operation_id: reviewed["operation"]["id"].as_str().unwrap().into(),
            plan,
        };
        fs::write(
            dir.path().join("docker"),
            include_str!("../../zero-executor/tests/fixtures/fake-docker.py"),
        )
        .unwrap();
        fs::set_permissions(dir.path().join("docker"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(dir.path().join("scenario.txt"), "echo").unwrap();
        let f = Self {
            dir,
            session,
            listener,
            request,
            real,
        };
        f.save();
        f
    }
    fn save(&self) {
        fs::write(
            self.dir.path().join("reproduction.json"),
            serde_json::to_vec(&self.request).unwrap(),
        )
        .unwrap();
    }
    fn cli(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        c.current_dir(self.dir.path()).args(["--state", "state.db"]);
        if !self.real {
            c.args(["--docker-bin", "./docker"]);
        }
        if matches!(
            self.request.plan.backend,
            zero_protocol::sandbox::SandboxBackend::Smolvm { .. }
        ) {
            c.arg("--smolvm-bin")
                .arg(std::env::var("ZERO_REPRODUCTION_SMOLVM_BIN").unwrap());
        }
        c
    }
    fn command(&self) -> Command {
        let mut c = self.cli();
        c.args([
            "source-reproduce",
            "--session",
            &self.session,
            "--command-id",
            "reproduce",
            "--request",
            "reproduction.json",
        ]);
        c
    }
    fn report(&self, reproduction: &Value, repair: Option<&Value>, format: &str) -> Output {
        let mut command = self.cli();
        command.args([
            "--providers",
            "absent.json",
            "--harness-config",
            "absent-harness.json",
            "source-report",
            "--session",
            &self.session,
            "--operation",
            &self.request.source_operation_id,
            "--reproduction",
            reproduction["operation"]["id"].as_str().unwrap(),
            "--format",
            format,
        ]);
        if let Some(repair) = repair {
            command.args(["--repair", repair["operation"]["id"].as_str().unwrap()]);
        }
        command.env_remove("REPRO_TEST_KEY").output().unwrap()
    }
    fn assert_report(&self, reproduction: &Value, repair: Option<&Value>) {
        let calls = self.calls();
        for format in ["json", "markdown", "html"] {
            let output = self.report(reproduction, repair, format);
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let text = String::from_utf8(output.stdout).unwrap();
            assert!(!text.contains(self.dir.path().to_str().unwrap()));
            assert!(!text.contains("fixture-secret"));
            assert!(!text.contains("SAFE_REPLACEMENT"));
            assert!(text.contains(reproduction["operation"]["id"].as_str().unwrap()));
            assert!(text.contains("unverified"));
            if format == "json" {
                let report: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(report["schema_version"], 2);
                assert_eq!(report["security_conclusion"], "not_established");
                assert_eq!(
                    report["reproductions"][0]["assessment"],
                    reproduction["result"]["assessment"]
                );
                assert_eq!(
                    report["reproductions"][0]["operation_status"],
                    reproduction["operation"]["status"]
                );
                if let Some(repair) = repair {
                    assert_eq!(report["repairs"][0]["status"], repair["result"]["status"]);
                    assert_eq!(report["repairs"][0]["phases"].as_array().unwrap().len(), 2);
                }
                let _: zero_protocol::source::SourceReport = serde_json::from_str(&text).unwrap();
            }
        }
        assert_eq!(calls, self.calls());
        assert_eq!(
            self.listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
    fn calls(&self) -> Vec<u8> {
        fs::read(self.dir.path().join("calls.jsonl")).unwrap_or_default()
    }
    fn retry_without_effects(&self, first: &Value, expected_success: bool) {
        let calls = self.calls();
        fs::remove_dir_all(self.dir.path().join("source")).unwrap();
        let out = self.command().output().unwrap();
        assert_eq!(out.status.success(), expected_success);
        let retry: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(retry["duplicate"], true);
        assert_eq!(retry["operation"]["id"], first["operation"]["id"]);
        assert_eq!(retry["result"], first["result"]);
        assert_eq!(calls, self.calls());
        assert_eq!(
            self.listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
fn parsed(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "{} {}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
fn observed(image: Option<String>) {
    let f = Fixture::new(image);
    let result = parsed(&f.command().output().unwrap());
    assert_eq!(
        result["result"]["assessment"]["disposition"],
        "observed_for_plan"
    );
    assert_eq!(
        result["result"]["assessment"]["vulnerability_reportable"],
        false
    );
    assert_eq!(result["result"]["assessment"]["observed_attempts"], 4);
    assert_eq!(result["result"]["children"].as_array().unwrap().len(), 4);
    let operation = result["operation"]["id"].as_str().unwrap();
    let list = parsed(
        &f.cli()
            .args([
                "--providers",
                "absent.json",
                "artifact",
                "list",
                "--session",
                &f.session,
                "--operation",
                operation,
            ])
            .output()
            .unwrap(),
    );
    assert_eq!(
        list["artifacts"]["reproduction.assessment"],
        result["result"]["artifacts"]["reproduction.assessment"]
    );
    let export = parsed(
        &f.cli()
            .args([
                "artifact",
                "export",
                "--session",
                &f.session,
                "--operation",
                operation,
                "--name",
                "reproduction.assessment",
                "--output",
                "assessment.json",
            ])
            .output()
            .unwrap(),
    );
    assert!(export["digest"].as_str().unwrap().starts_with("sha256:"));
    let assessment: Value =
        serde_json::from_slice(&fs::read(f.dir.path().join("assessment.json")).unwrap()).unwrap();
    assert_eq!(assessment, result["result"]["assessment"]);
    if f.real {
        assert!(f.calls().is_empty());
    }
    f.retry_without_effects(&result, true);
    f.assert_report(&result, None);
}
#[test]
fn frozen_observations_and_artifact_export_survive_restart_without_effects() {
    observed(None);
}
#[test]
fn stable_attack_mismatch_is_completed_assessment_with_success_exit() {
    let mut f = Fixture::new(None);
    f.request.plan.cases[0].expected.stdout = b"different".to_vec();
    f.save();
    let result = parsed(&f.command().output().unwrap());
    assert_eq!(
        result["result"]["assessment"]["disposition"],
        "not_observed"
    );
    assert_eq!(
        result["result"]["assessment"]["vulnerability_reportable"],
        false
    );
    f.retry_without_effects(&result, true);
    f.assert_report(&result, None);
}
#[test]
fn control_mismatch_is_inconclusive_and_nonzero() {
    let mut f = Fixture::new(None);
    f.request.plan.cases[1].expected.stdout = b"different".to_vec();
    f.save();
    let out = f.command().output().unwrap();
    assert!(!out.status.success());
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        result["result"]["assessment"]["disposition"],
        "inconclusive"
    );
    f.retry_without_effects(&result, false);
    f.assert_report(&result, None);
}
#[test]
fn signal_waits_for_child_cleanup_and_retry_does_not_restart_matrix() {
    let f = Fixture::new(None);
    fs::write(f.dir.path().join("scenario.txt"), "hang").unwrap();
    let mut child = f
        .command()
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f.dir.path().join("child.pid").exists() {
        assert!(Instant::now() < deadline);
        assert!(child.try_wait().unwrap().is_none());
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    while child.try_wait().unwrap().is_none() {
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("reproduction cancellation did not settle");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let out = child.wait_with_output().unwrap();
    assert!(!out.status.success());
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(result["operation"]["status"], "cancelled");
    assert!(!f.dir.path().join("container.json").exists());
    f.retry_without_effects(&result, false);
    f.assert_report(&result, None);
}
#[test]
#[ignore = "requires preloaded local Node image in ZERO_REPRODUCTION_DOCKER_IMAGE; never pulls"]
fn real_local_docker_source_review_to_observed_plan_and_artifact() {
    let image = std::env::var("ZERO_REPRODUCTION_DOCKER_IMAGE").unwrap();
    assert!(image.starts_with("sha256:") && image.len() == 71);
    observed(Some(image));
}

fn validate_candidate(image: Option<String>, microvm: bool) {
    let mut f = Fixture::new(image);
    if microvm {
        f.request.plan.backend = zero_protocol::sandbox::SandboxBackend::Smolvm {
            image_archive: std::env::var("ZERO_SMOLVM_SMOKE_ARCHIVE").unwrap().into(),
            archive_digest:
                "sha256:2bda0b195b4a451d7e3c516a2c08178024f4407e60e7abfed831eb5f06444c48".into(),
            storage_gb: 4,
        };
        f.request.plan.limits.memory_mb = 2048;
        f.request.plan.limits.cpus = 2.0;
    }
    f.request.plan.cases[0].safe_expected = Some(ExactOutput {
        exit_code: 0,
        stdout: b"safe\n".to_vec(),
        stderr: if f.real {
            vec![]
        } else {
            b"fixture diagnostic\n".to_vec()
        },
    });
    if !f.real {
        let path = f.dir.path().join("docker");
        let fake = fs::read_to_string(&path).unwrap()
            .replace("state.write_text(json.dumps({\"name\": name, \"id\": container_id}))", "state.write_text(json.dumps({\"name\": name, \"id\": container_id}))\n    mount = args[args.index('--mount')+1]\n    source = pathlib.Path(mount.split('src=')[1].split(',')[0])\n    (root / 'candidate-source.txt').write_text((source / 'app.js').read_text())")
            .replace("sys.stdout.buffer.write(sys.stdin.buffer.read())", "data = sys.stdin.buffer.read()\n        code = (root / 'candidate-source.txt').read_text()\n        if data == b'attack\\n' and 'SAFE_REPLACEMENT' in code: data = b'safe\\n'\n        sys.stdout.buffer.write(data)");
        fs::write(path, fake).unwrap();
    }
    f.save();
    let baseline_output = f.command().output().unwrap();
    if !baseline_output.status.success() {
        let failed: Value = serde_json::from_slice(&baseline_output.stdout).unwrap();
        let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
        if let Some(children) = failed["result"]["children"].as_array() {
            for child in children {
                let artifacts = store.operation_artifacts(child.as_str().unwrap()).unwrap();
                let evidence: Value = serde_json::from_slice(
                    &store.artifact(&artifacts["reproduction.evidence"]).unwrap(),
                )
                .unwrap();
                eprintln!("baseline observation: {}", evidence["result"]);
            }
        }
    }
    let baseline = parsed(&baseline_output);
    let replacement = "// SAFE_REPLACEMENT\nconst s = require('fs').readFileSync(0, 'utf8'); process.stdout.write(s === 'attack\\n' ? 'safe\\n' : s);\n";
    let request = zero_protocol::repair::RepairValidationRequest {
        reproduction_operation_id: baseline["operation"]["id"].as_str().unwrap().into(),
        materialize: zero_protocol::repair::MaterializeRequest {
            baseline: f.request.plan.snapshot.clone(),
            target: "app.js".into(),
            allowed_paths: vec!["app.js".into()],
            protected_paths: vec!["tests".into()],
            expected_preimage_sha256: f.request.plan.snapshot.files[0].digest.clone(),
            replacement: replacement.into(),
        },
    };
    fs::write(
        f.dir.path().join("repair.json"),
        serde_json::to_vec(&request).unwrap(),
    )
    .unwrap();
    let run = || {
        f.cli()
            .args([
                "source-repair",
                "--session",
                &f.session,
                "--command-id",
                "repair",
                "--request",
                "repair.json",
            ])
            .output()
            .unwrap()
    };
    let original = fs::read(f.dir.path().join("source/app.js")).unwrap();
    let result = parsed(&run());
    assert_eq!(result["result"]["status"], "validated_candidate_for_plan");
    assert_eq!(result["result"]["vulnerability_reportable"], false);
    let phases = result["result"]["phases"].as_array().unwrap();
    assert_eq!(phases.len(), 2);
    for phase in phases {
        assert_eq!(
            phase["observations"]["children"].as_array().unwrap().len(),
            4
        );
        assert_eq!(
            phase["observations"]["assessment"]["disposition"],
            "observed_for_plan"
        );
    }
    assert_eq!(
        original,
        fs::read(f.dir.path().join("source/app.js")).unwrap()
    );
    if !f.real {
        repair_export::not_validated(&f, &request);
    }
    let calls = f.calls();
    fs::remove_dir_all(f.dir.path().join("source")).unwrap();
    let retry = parsed(&run());
    assert_eq!(retry["duplicate"], true);
    assert_eq!(retry["result"], result["result"]);
    f.assert_report(&baseline, Some(&result));
    if !f.real {
        repair_export::check(&f, &baseline, &result, &original, replacement);
    }
    assert_eq!(calls, f.calls());
    assert_eq!(
        f.listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}
#[test]
fn source_repair_validates_private_candidate_and_reconstruction() {
    validate_candidate(None, false);
}
#[test]
#[ignore = "requires preloaded local Node image in ZERO_REPRODUCTION_DOCKER_IMAGE; never pulls"]
fn real_local_docker_candidate_and_fresh_reconstruction() {
    validate_candidate(
        Some(std::env::var("ZERO_REPRODUCTION_DOCKER_IMAGE").unwrap()),
        false,
    );
}

#[test]
#[ignore = "real nonroot KVM/smolvm1.14.6; requires local ZERO_SMOLVM_SMOKE_ARCHIVE and ZERO_REPRODUCTION_SMOLVM_BIN; no pulls"]
fn real_microvm_candidate_and_fresh_reconstruction() {
    validate_candidate(Some(format!("sha256:{}", "a".repeat(64))), true);
}
