//! Opt-in native workflow qualification against a preinstalled immutable image.
//! The host wrapper only records argv and execs the real Docker CLI unchanged.
use super::*;
use base64::Engine as _;
use std::{collections::BTreeSet, os::unix::fs::PermissionsExt, path::Path};
const IMAGE: &str = "sha256:0461844e338a379bd3379976a753e5467dce5361a471fbecff593fa477e3d7f6";
const BASELINE: &str = "import sys\nvalue = sys.stdin.read().strip()\nprint('old marker' if value == 'marker' else 'HELLO')\n";
const REPLACEMENT: &str = "import sys\nvalue = sys.stdin.read().strip()\nprint('new marker' if value == 'marker' else 'HELLO')\n";
fn success(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "{}; {}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    decoded(out)
}
async fn run(mut command: Command) -> Output {
    tokio::time::timeout(Duration::from_secs(90), command.output())
        .await
        .expect("bounded actual Docker workflow")
        .unwrap()
}
fn native(f: &Fixture, docker: &Path, route: &str) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    c.arg("--state")
        .arg(&f.state)
        .arg("--docker-bin")
        .arg(docker)
        .args(["review", route])
        .env("TMPDIR", f._dir.path().join("workflow-tmp"))
        .env_remove("REVIEW_CLI_KEY")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    c
}
fn calls(log: &Path) -> Vec<Vec<String>> {
    std::fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}
fn names(log: &Path) -> Vec<String> {
    calls(log)
        .into_iter()
        .filter(|c| c.first().is_some_and(|s| s == "create"))
        .map(|c| {
            let at = c.iter().position(|s| s == "--name").unwrap();
            let n = c[at + 1].clone();
            assert!(
                n.starts_with("0sec-rust-")
                    && n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            );
            n
        })
        .collect()
}
struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        if self.0.exists() {
            for name in names(&self.0) {
                let _ = std::process::Command::new("/usr/bin/timeout")
                    .args(["10", "/usr/bin/docker", "rm", "-f", &name])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
    }
}
fn assert_matrix(
    store: &zero_store::Store,
    outcome: &Value,
    expected_marker: &[u8],
    roots: &mut BTreeSet<String>,
) {
    assert_eq!(outcome["assessment"]["disposition"], "observed_for_plan");
    let children = outcome["children"].as_array().unwrap();
    assert_eq!(children.len(), 4);
    for child in children {
        let id = child.as_str().unwrap();
        let op = store.get_operation(id).unwrap();
        assert_eq!(op.status, zero_protocol::OperationStatus::Succeeded);
        let refs = store.operation_artifacts(id).unwrap();
        let bytes = store.artifact(&refs["reproduction.evidence"]).unwrap();
        let evidence: zero_protocol::verification::Evidence =
            serde_json::from_slice(&bytes).unwrap();
        assert_eq!(evidence.result.exit_code, Some(0));
        assert!(matches!(
            evidence.result.cleanup,
            zero_protocol::sandbox::SandboxCleanup::Confirmed
        ));
        assert_eq!(
            evidence.result.stdout,
            if evidence.case_id == "marker" {
                expected_marker
            } else {
                b"HELLO\n"
            }
        );
        assert!(evidence.result.stderr.is_empty());
        roots.insert(evidence.request.snapshot.root.clone());
    }
}
#[tokio::test]
#[ignore = "requires local Docker and the pinned preinstalled Python image; never pulls"]
async fn actual_docker_native_review_archive_reproduction_repair_and_export() {
    let inspected = tokio::time::timeout(
        Duration::from_secs(10),
        Command::new("/usr/bin/docker")
            .args(["image", "inspect", IMAGE, "--format", "{{.Id}}"])
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        inspected.status.success(),
        "Install the documented image outside this test; no pull is attempted"
    );
    assert_eq!(String::from_utf8(inspected.stdout).unwrap().trim(), IMAGE);
    let f = Fixture::new().await;
    std::fs::write(f.source.join("app.rs"), BASELINE).unwrap();
    std::fs::create_dir(f.source.join("public")).unwrap();
    std::fs::write(f.source.join("public/hello.txt"), b"HELLO\n").unwrap();
    std::fs::write(f.source.join("unchanged.txt"), b"old marker\n").unwrap();
    std::fs::write(f.source.join("unselected.bin"), [0, 255, 128]).unwrap();
    let checkout = f._dir.path().join("checkout");
    std::fs::create_dir(&checkout).unwrap();
    std::fs::create_dir(checkout.join("public")).unwrap();
    for p in [
        "app.rs",
        "public/hello.txt",
        "unchanged.txt",
        "unselected.bin",
    ] {
        std::fs::copy(f.source.join(p), checkout.join(p)).unwrap();
    }
    let pristine = zero_executor::pin_snapshot(&checkout).unwrap();
    let mut profile: Value = serde_json::from_slice(&std::fs::read(&f.profiles).unwrap()).unwrap();
    profile["local"]["execution"]["backend"]["image"] = json!(IMAGE);
    std::fs::write(&f.profiles, serde_json::to_vec(&profile).unwrap()).unwrap();
    let digest = pristine
        .files
        .iter()
        .find(|v| v.path == "app.rs")
        .unwrap()
        .digest
        .clone();
    let reviewed = submit_cited(&f, f.run("docker-source"), &digest).await;
    let review_id = reviewed["review"]["review"]["id"].as_str().unwrap();
    let store = zero_store::Store::open_read_only(&f.state).unwrap();
    let record = store.review_by_command("docker-source").unwrap().unwrap();
    let root = store.get_operation(&record.root_operation_id).unwrap();
    let request: zero_protocol::agent::AgentRequest =
        serde_json::from_value(root.payload["request"].clone()).unwrap();
    let snapshot = request.snapshot_request().unwrap().snapshot.clone();
    assert!(!Path::new(&snapshot.root).exists());
    let report = zero_engine::read_review_report(&f.state, review_id)
        .unwrap()
        .source
        .unwrap();
    let manifest = store
        .review_source_archive_manifest(review_id)
        .unwrap()
        .unwrap();
    drop(store);
    let expected = |bytes: &[u8]| json!({"exit_code":0,"stdout":base64::engine::general_purpose::STANDARD.encode(bytes),"stderr":""});
    let baseline = json!({"schema_version":1,"review_id":review_id,"source_operation_id":record.root_operation_id,"archive_manifest_sha256":format!("sha256:{}",zero_plugin::sha256(&manifest.canonical_bytes().unwrap())),"deadline_ms":60000,"max_executions":4,"plan":{"schema_version":1,"oracle_version":"zero-verification-exact-output-v1","hypothesis_id":report.review.hypotheses[0].id,"source_bundle_digest":report.review.bundle_sha256,"snapshot":snapshot,"backend":{"type":"docker","image":IMAGE},"limits":{"timeout_ms":10000,"memory_mb":128,"cpus":1,"max_output_bytes":4096},"repeats":2,"cases":[{"id":"marker","mode":"attack","argv":["python3","app.rs"],"stdin":"marker\n","expected":expected(b"old marker\n"),"safe_expected":expected(b"new marker\n")},{"id":"control","mode":"legitimate_control","argv":["python3","app.rs"],"stdin":"control\n","expected":expected(b"HELLO\n")}]}});
    let baseline_path = f._dir.path().join("baseline.json");
    std::fs::write(&baseline_path, serde_json::to_vec(&baseline).unwrap()).unwrap();
    let log = f._dir.path().join("docker.jsonl");
    let docker = f._dir.path().join("docker");
    let _cleanup = Cleanup(log.clone());
    std::fs::write(&docker,format!("#!/usr/bin/python3\nimport os,sys,json\nwith open({},'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\nos.execv('/usr/bin/docker',['/usr/bin/docker',*sys.argv[1:]])\n",serde_json::to_string(&log.to_str().unwrap()).unwrap())).unwrap();
    std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::create_dir(f._dir.path().join("workflow-tmp")).unwrap();
    std::fs::remove_dir_all(&f.source).unwrap();
    std::fs::remove_file(&f.profiles).unwrap();
    std::fs::remove_file(&f.providers).unwrap();
    let mut c = native(&f, &docker, "reproduce");
    c.args(["--command-id", "docker-baseline", "--plan"])
        .arg(&baseline_path);
    let reproduced = success(&run(c).await);
    let repair = json!({"schema_version":1,"reproduction_id":reproduced["operation"]["payload"]["reproduction_id"],"deadline_ms":60000,"max_executions":8,"materialize":{"baseline":snapshot,"target":"app.rs","allowed_paths":["app.rs"],"protected_paths":["unchanged.txt","public","unselected.bin"],"expected_preimage_sha256":digest,"replacement":REPLACEMENT}});
    let repair_path = f._dir.path().join("repair.json");
    std::fs::write(&repair_path, serde_json::to_vec(&repair).unwrap()).unwrap();
    let mut c = native(&f, &docker, "repair");
    c.args(["--command-id", "docker-repair", "--plan"])
        .arg(&repair_path);
    let repaired = success(&run(c).await);
    assert_eq!(repaired["result"]["status"], "validated_candidate_for_plan");
    assert_eq!(repaired["result"]["vulnerability_reportable"], false);
    assert!(
        repaired["result"]["cleanup_recovery"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let store = zero_store::Store::open_read_only(&f.state).unwrap();
    let mut baseline_roots = BTreeSet::new();
    assert_matrix(
        &store,
        &reproduced["result"],
        b"old marker\n",
        &mut baseline_roots,
    );
    let phases = repaired["result"]["phases"].as_array().unwrap();
    assert_eq!(phases.len(), 2);
    let mut phase_roots = Vec::new();
    for phase in phases {
        let mut roots = BTreeSet::new();
        assert_matrix(&store, &phase["observations"], b"new marker\n", &mut roots);
        assert_eq!(roots.len(), 1);
        phase_roots.push(roots);
    }
    assert!(phase_roots[0].is_disjoint(&phase_roots[1]));
    drop(store);
    for root in baseline_roots.iter().chain(phase_roots.iter().flatten()) {
        assert!(
            !Path::new(root).exists(),
            "private workflow stage remains: {root}"
        );
    }
    assert_eq!(
        std::fs::read_dir(f._dir.path().join("workflow-tmp"))
            .unwrap()
            .count(),
        0
    );
    let physical = calls(&log);
    assert_eq!(names(&log).len(), 12);
    assert!(
        physical
            .iter()
            .all(|a| a.first().is_none_or(|s| s != "pull"))
    );
    for name in names(&log) {
        let result = Command::new("/usr/bin/docker")
            .args(["container", "inspect", &name])
            .output()
            .await
            .unwrap();
        assert!(!result.status.success(), "owned container remains: {name}");
    }
    for args in physical
        .iter()
        .filter(|a| a.first().is_some_and(|s| s == "create"))
    {
        let at = args.iter().position(|s| s == "--entrypoint").unwrap();
        assert_eq!(args[at + 1], "/bin/sh");
    }
    std::fs::remove_file(&docker).unwrap();
    std::fs::remove_file(&baseline_path).unwrap();
    let mut c = native(&f, &docker, "repair");
    c.args(["--command-id", "docker-repair", "--plan"])
        .arg(&repair_path);
    assert_eq!(success(&run(c).await)["duplicate"], true);
    std::fs::remove_file(&repair_path).unwrap();
    let mut c = native(&f, &docker, "repair-report");
    c.args(["--command-id", "docker-repair"]);
    assert_eq!(success(&run(c).await)["result"], repaired["result"]);
    let mut c = native(&f, &docker, "repair-export");
    c.args(["--command-id", "docker-repair"]);
    let patch = run(c).await;
    assert!(
        patch.status.success(),
        "{}",
        String::from_utf8_lossy(&patch.stderr)
    );
    let applied = f._dir.path().join("applied");
    std::fs::create_dir(&applied).unwrap();
    std::fs::write(applied.join("app.rs"), BASELINE).unwrap();
    let patch_path = f._dir.path().join("candidate.patch");
    std::fs::write(&patch_path, patch.stdout).unwrap();
    let result = Command::new("patch")
        .current_dir(&applied)
        .args(["--batch", "-p1", "-i"])
        .arg(patch_path)
        .output()
        .await
        .unwrap();
    assert!(result.status.success());
    assert_eq!(
        std::fs::read_to_string(applied.join("app.rs")).unwrap(),
        REPLACEMENT
    );
    #[cfg(target_os = "linux")]
    review_repair::checked_bundle_roundtrip(
        &f,
        "--command-id",
        "docker-repair",
        &checkout,
        BASELINE.as_bytes(),
        REPLACEMENT.as_bytes(),
    )
    .await;
    assert_eq!(
        zero_executor::pin_snapshot(&checkout).unwrap().digest,
        pristine.digest
    );
    assert_eq!(calls(&log), physical);
    f.no_request().await;
}
