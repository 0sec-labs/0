//! Actual CLI archive→reproduction→repair path. The deterministic process backend
//! exercises physical lifecycle and durable gates, not Docker isolation.
use super::*;
use base64::Engine as _;
use std::os::unix::fs::PermissionsExt;

const REPLACEMENT: &str = "fn main() {\n    println!(\"fixed review marker\");\n}\n";

async fn setup() -> (Fixture, PathBuf) {
    let (f, baseline_path) = review_reproduce::setup().await;
    let mut baseline: Value =
        serde_json::from_slice(&std::fs::read(&baseline_path).unwrap()).unwrap();
    baseline["plan"]["cases"][0]["safe_expected"] = json!({
        "exit_code":0,"stdout":base64::engine::general_purpose::STANDARD.encode(b"safe\n"),
        "stderr":base64::engine::general_purpose::STANDARD.encode(b"fixture diagnostic\n")
    });
    std::fs::write(&baseline_path, serde_json::to_vec(&baseline).unwrap()).unwrap();
    let out = finish(
        review_reproduce::command(&f, &baseline_path)
            .spawn()
            .unwrap(),
    )
    .await;
    assert!(
        out.status.success(),
        "{}; {}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    let result = decoded(&out);
    assert_eq!(
        result["result"]["assessment"]["disposition"],
        "observed_for_plan"
    );
    let snapshot = &baseline["plan"]["snapshot"];
    let preimage = snapshot["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"] == "app.rs")
        .unwrap()["digest"]
        .clone();
    let plan = json!({"schema_version":1,"reproduction_id":result["operation"]["payload"]["reproduction_id"],
    "deadline_ms":30000,"max_executions":8,"materialize":{
        "baseline":snapshot,"target":"app.rs","allowed_paths":["app.rs"],"protected_paths":[],
        "expected_preimage_sha256":preimage,"replacement":REPLACEMENT
    }});
    let plan_path = f._dir.path().join("repair-plan.json");
    std::fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
    std::fs::remove_file(&baseline_path).unwrap();
    let probe = r#"
    import sqlite3
    db=sqlite3.connect('file:'+str(root/'state.db')+'?mode=ro',uri=True)
    rows=db.execute("select id from operations where status='running' and json_extract(payload,'$.kind')='reproduction_case'").fetchall()
    assert len(rows)==1, rows
    operation=rows[0][0]
    receipt=db.execute("select payload from events where kind='native_repair_effect_started' and json_extract(payload,'$.operation_id')=?",(operation,)).fetchone()
    assert receipt is not None, operation
    mount=args[args.index('--mount')+1]
    source=pathlib.Path(mount.split('src=')[1].split(',')[0])
    assert (source/'unselected.bin').read_bytes()==bytes([0,255,128])
    assert b'fixed review marker' in (source/'app.rs').read_bytes()
    with (root/'mounts.jsonl').open('a') as log: log.write(json.dumps(str(source))+'\n')
    db.close()
"#;
    let fake = include_str!("../../../zero-executor/tests/fixtures/fake-docker.py")
        .replace("elif args[0] == \"create\":", &format!("elif args[0] == \"create\":{probe}"))
        .replace("sys.stdout.buffer.write(sys.stdin.buffer.read())", "data=sys.stdin.buffer.read()\n        sys.stdout.buffer.write(b'safe\\n' if data==b'attack\\n' and scenario!='unchanged' else data)");
    std::fs::write(f._dir.path().join("docker"), fake).unwrap();
    std::fs::set_permissions(
        f._dir.path().join("docker"),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    std::fs::create_dir(f._dir.path().join("repair-tmp")).unwrap();
    (f, plan_path)
}
fn command(f: &Fixture, plan: &std::path::Path) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    c.arg("--state")
        .arg(&f.state)
        .arg("--docker-bin")
        .arg(f._dir.path().join("docker"))
        .args([
            "review",
            "repair",
            "--command-id",
            "native-repair",
            "--plan",
        ])
        .arg(plan)
        .env("TMPDIR", f._dir.path().join("repair-tmp"))
        .env_remove("REVIEW_CLI_KEY")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    c
}
fn inspect(f: &Fixture, route: &str, selector: &str, id: &str) -> Command {
    let mut c = f.cli();
    c.args(["review", route, selector, id]);
    c
}
fn assert_success(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "{}; {}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    decoded(out)
}

/// Exercise the exported archive through the public offline host CLI, without
/// opening Engine state or consulting source/provider/backend configuration.
#[cfg(target_os = "linux")]
pub(super) async fn checked_bundle_roundtrip(
    f: &Fixture,
    selector: &str,
    id: &str,
    checkout: &std::path::Path,
    before: &[u8],
    after: &[u8],
) {
    let bundle = f._dir.path().join("checked-repair-bundle");
    let mut export = inspect(f, "repair-export", selector, id);
    export.arg("--output-dir").arg(&bundle);
    assert_success(&finish(export.spawn().unwrap()).await);
    let manifest = std::fs::read(bundle.join("bundle.json")).unwrap();
    let value: Value = serde_json::from_slice(&manifest).unwrap();
    assert_eq!(value["schema_version"], 1);
    assert_eq!(value["assessment"], "unverified");
    assert_eq!(value["host_apply"], "not_performed");
    // A repeated publication must not replace an existing destination.
    let sentinel = bundle.join("user-note");
    std::fs::write(&sentinel, b"preserve export destination").unwrap();
    let mut collision = inspect(f, "repair-export", selector, id);
    collision.arg("--output-dir").arg(&bundle);
    let denied = finish(collision.spawn().unwrap()).await;
    assert_eq!(denied.status.code(), Some(2));
    assert!(denied.stdout.is_empty());
    assert_eq!(std::fs::read(bundle.join("bundle.json")).unwrap(), manifest);
    assert_eq!(
        std::fs::read(&sentinel).unwrap(),
        b"preserve export destination"
    );
    std::fs::remove_file(sentinel).unwrap();
    let untouched = checkout.join("unrelated-user-work.txt");
    std::fs::write(&untouched, b"local unsaved work").unwrap();
    let state = f._dir.path().join("host-apply-must-not-open.db");
    let journal = f._dir.path().join("repair-apply-journal");
    let host = |route: &str| {
        let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        c.arg("--state")
            .arg(&state)
            .args(["--providers", "/absent", "workspace-apply", route])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        c
    };
    let mut preview = host("preview");
    preview
        .arg("--bundle")
        .arg(&bundle)
        .arg("--root")
        .arg(checkout);
    assert_success(&finish(preview.spawn().unwrap()).await);
    assert_eq!(std::fs::read(checkout.join("app.rs")).unwrap(), before);
    assert!(!journal.exists());
    let mut apply = host("run");
    apply
        .arg("--bundle")
        .arg(&bundle)
        .arg("--root")
        .arg(checkout)
        .arg("--journal")
        .arg(&journal);
    assert_eq!(
        assert_success(&finish(apply.spawn().unwrap()).await)["phase"],
        "completed"
    );
    assert_eq!(std::fs::read(checkout.join("app.rs")).unwrap(), after);
    assert_eq!(std::fs::read(&untouched).unwrap(), b"local unsaved work");
    // Recovery is independent of the exported bundle as well as original source.
    std::fs::remove_dir_all(&bundle).unwrap();
    let mut rollback = host("rollback");
    rollback.arg("--journal").arg(&journal);
    assert_eq!(
        assert_success(&finish(rollback.spawn().unwrap()).await)["phase"],
        "rolled_back"
    );
    assert_eq!(std::fs::read(checkout.join("app.rs")).unwrap(), before);
    assert_eq!(std::fs::read(&untouched).unwrap(), b"local unsaved work");
    assert!(!state.exists());
    std::fs::remove_file(untouched).unwrap();
}

#[tokio::test]
async fn native_repair_offline_retry_report_and_independently_validated_patch() {
    let (f, plan) = setup().await;
    let before = std::fs::read(f._dir.path().join("calls.jsonl")).unwrap();
    let mut unsupported = command(&f, &plan);
    unsupported.arg("--providers").arg(&f.providers);
    let denied = finish(unsupported.spawn().unwrap()).await;
    assert_eq!(denied.status.code(), Some(2));
    assert!(denied.stdout.is_empty());
    assert_eq!(
        std::fs::read(f._dir.path().join("calls.jsonl")).unwrap(),
        before
    );
    let result = assert_success(&finish(command(&f, &plan).spawn().unwrap()).await);
    assert_eq!(result["result"]["status"], "validated_candidate_for_plan");
    assert_eq!(result["result"]["vulnerability_reportable"], false);
    assert_eq!(result["result"]["phases"].as_array().unwrap().len(), 2);
    assert!(
        result["result"]["phases"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["observations"]["children"].as_array().unwrap().len() == 4)
    );
    let id = result["operation"]["payload"]["repair_id"]
        .as_str()
        .unwrap();
    review_reproduce::cleaned(&f);
    assert!(!f.source.exists());
    let calls = std::fs::read(f._dir.path().join("calls.jsonl")).unwrap();
    std::fs::remove_file(f._dir.path().join("docker")).unwrap();
    let mut retry = command(&f, &plan);
    retry.arg("--providers").arg(&f.providers);
    let cached = assert_success(&finish(retry.spawn().unwrap()).await);
    assert_eq!(cached["duplicate"], true);
    assert_eq!(cached["result"], result["result"]);
    let mut changed: Value = serde_json::from_slice(&std::fs::read(&plan).unwrap()).unwrap();
    changed["max_executions"] = json!(9);
    std::fs::write(&plan, serde_json::to_vec(&changed).unwrap()).unwrap();
    let denied = finish(command(&f, &plan).spawn().unwrap()).await;
    assert_eq!(denied.status.code(), Some(2));
    assert!(denied.stdout.is_empty());
    std::fs::remove_file(&plan).unwrap();
    for (selector, key) in [("--repair", id), ("--command-id", "native-repair")] {
        let read = assert_success(
            &finish(inspect(&f, "repair-report", selector, key).spawn().unwrap()).await,
        );
        assert_eq!(read["result"], result["result"]);
        let patch = finish(inspect(&f, "repair-export", selector, key).spawn().unwrap()).await;
        assert!(
            patch.status.success(),
            "{}",
            String::from_utf8_lossy(&patch.stderr)
        );
        let apply = f._dir.path().join(if selector == "--repair" {
            "apply-id"
        } else {
            "apply-command"
        });
        std::fs::create_dir(&apply).unwrap();
        std::fs::write(apply.join("app.rs"), SOURCE).unwrap();
        let patch_path = f._dir.path().join("candidate.patch");
        std::fs::write(&patch_path, &patch.stdout).unwrap();
        let applied = std::process::Command::new("patch")
            .current_dir(&apply)
            .args(["--batch", "-p1", "-i"])
            .arg(patch_path)
            .output()
            .unwrap();
        assert!(
            applied.status.success(),
            "{}",
            String::from_utf8_lossy(&applied.stdout)
        );
        assert_eq!(
            std::fs::read(apply.join("app.rs")).unwrap(),
            REPLACEMENT.as_bytes()
        );
    }
    #[cfg(target_os = "linux")]
    {
        let checkout = f._dir.path().join("checked-host-checkout");
        std::fs::create_dir(&checkout).unwrap();
        std::fs::write(checkout.join("app.rs"), SOURCE).unwrap();
        checked_bundle_roundtrip(
            &f,
            "--repair",
            id,
            &checkout,
            SOURCE.as_bytes(),
            REPLACEMENT.as_bytes(),
        )
        .await;
    }
    // Corrupted exact retained case bytes must reject both report and export,
    // even though the parent outcome still claims a validated candidate.
    let damaged = f._dir.path().join("damaged-repair.db");
    let corrupt=std::process::Command::new("python3").arg("-c").arg(r#"
import sqlite3,sys
src=sqlite3.connect(sys.argv[1]); dst=sqlite3.connect(sys.argv[2]); src.backup(dst); src.close()
row=dst.execute("select a.digest from operation_artifacts a join operations o on o.id=a.operation_id where json_extract(o.payload,'$.kind')='reproduction_case' and o.session_id=? and a.name='reproduction.evidence' limit 1",(sys.argv[3],)).fetchone()
assert row is not None
assert dst.execute("update artifacts set bytes=? where digest=?",(b'{}',row[0])).rowcount==1
dst.commit(); dst.close()
"#).arg(&f.state).arg(&damaged).arg(result["operation"]["session_id"].as_str().unwrap()).output().unwrap();
    assert!(
        corrupt.status.success(),
        "{}",
        String::from_utf8_lossy(&corrupt.stderr)
    );
    for route in ["repair-report", "repair-export"] {
        let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        c.arg("--state")
            .arg(&damaged)
            .args(["review", route, "--repair", id])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let denied = finish(c.spawn().unwrap()).await;
        assert_eq!(denied.status.code(), Some(2));
        assert!(
            denied.stdout.is_empty(),
            "corrupt evidence must not publish success or patch bytes"
        );
    }
    for missing in [false, true] {
        if missing {
            let removed = std::process::Command::new("python3").arg("-c").arg(
                "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute(\"delete from operation_artifacts where name='reproduction.evidence'\"); db.commit()"
            ).arg(&damaged).output().unwrap();
            assert!(removed.status.success());
        }
        let bundle = f._dir.path().join(if missing {
            "missing-evidence-bundle"
        } else {
            "corrupt-evidence-bundle"
        });
        let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        c.arg("--state")
            .arg(&damaged)
            .args(["review", "repair-export", "--repair", id, "--output-dir"])
            .arg(&bundle)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let denied = finish(c.spawn().unwrap()).await;
        assert_eq!(denied.status.code(), Some(2));
        assert!(denied.stdout.is_empty());
        assert!(
            !bundle.exists(),
            "invalid evidence must not publish a bundle directory"
        );
    }
    let mut terminal = inspect(&f, "repair-report", "--repair", id);
    terminal.args(["--format", "terminal"]);
    let out = finish(terminal.spawn().unwrap()).await;
    assert!(out.status.success());
    assert!(
        String::from_utf8(out.stdout)
            .unwrap()
            .contains("does not verify a vulnerability")
    );
    assert_eq!(
        std::fs::read(f._dir.path().join("calls.jsonl")).unwrap(),
        calls
    );
    f.no_request().await;
}

#[tokio::test]
async fn native_repair_sigterm_drains_and_live_readonly_report_cannot_claim_validation() {
    let (f, plan) = setup().await;
    std::fs::write(f._dir.path().join("scenario.txt"), "hang").unwrap();
    let mut child = command(&f, &plan).spawn().unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !f._dir.path().join("child.pid").exists() {
        assert!(tokio::time::Instant::now() < deadline);
        if child.try_wait().unwrap().is_some() {
            panic!("repair exited before backend: {:?}", finish(child).await);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let active = finish(
        inspect(&f, "repair-report", "--command-id", "native-repair")
            .spawn()
            .unwrap(),
    )
    .await;
    assert_eq!(
        active.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&active.stderr)
    );
    let active = decoded(&active);
    assert_eq!(active["operation"]["status"], "running");
    assert!(active["result"].is_null());
    assert!(child.try_wait().unwrap().is_none());
    let export = finish(
        inspect(&f, "repair-export", "--command-id", "native-repair")
            .spawn()
            .unwrap(),
    )
    .await;
    assert_eq!(export.status.code(), Some(2));
    assert!(export.stdout.is_empty());
    assert!(
        std::process::Command::new("kill")
            .args(["-TERM", &child.id().unwrap().to_string()])
            .status()
            .unwrap()
            .success()
    );
    let out = finish(child).await;
    assert_eq!(
        out.status.code(),
        Some(143),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(decoded(&out)["operation"]["status"], "cancelled");
    review_reproduce::cleaned(&f);
    let read = finish(
        inspect(&f, "repair-report", "--command-id", "native-repair")
            .spawn()
            .unwrap(),
    )
    .await;
    assert_eq!(read.status.code(), Some(2));
    assert_ne!(
        decoded(&read)["result"]["status"],
        "validated_candidate_for_plan"
    );
    let export = finish(
        inspect(&f, "repair-export", "--command-id", "native-repair")
            .spawn()
            .unwrap(),
    )
    .await;
    assert_eq!(export.status.code(), Some(2));
    assert!(export.stdout.is_empty());
    f.no_request().await;
}

#[tokio::test]
async fn native_repair_failed_safe_expectation_is_not_exportable() {
    let (f, plan) = setup().await;
    std::fs::write(f._dir.path().join("scenario.txt"), "unchanged").unwrap();
    let out = finish(command(&f, &plan).spawn().unwrap()).await;
    assert_eq!(
        out.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result = decoded(&out);
    assert_eq!(result["result"]["status"], "not_validated");
    assert_eq!(result["result"]["vulnerability_reportable"], false);
    review_reproduce::cleaned(&f);
    let export = finish(
        inspect(&f, "repair-export", "--command-id", "native-repair")
            .spawn()
            .unwrap(),
    )
    .await;
    assert_eq!(export.status.code(), Some(2));
    assert!(export.stdout.is_empty());
    f.no_request().await;
}

#[tokio::test]
async fn native_repair_backend_setup_failure_removes_both_private_sources() {
    let (f, plan) = setup().await;
    let before = std::fs::read_to_string(f._dir.path().join("calls.jsonl")).unwrap();
    std::fs::write(f._dir.path().join("scenario.txt"), "image-fail").unwrap();
    let out = finish(command(&f, &plan).spawn().unwrap()).await;
    assert_eq!(
        out.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result = decoded(&out);
    assert_eq!(result["result"]["status"], "not_validated");
    assert!(
        result["result"]["cleanup_recovery"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let phases = result["result"]["phases"].as_array().unwrap();
    assert_eq!(
        phases.len(),
        1,
        "failure must not dispatch reconstructed phase"
    );
    assert_eq!(phases[0]["name"], "candidate");
    assert_eq!(
        phases[0]["observations"]["children"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        std::fs::read_dir(f._dir.path().join("repair-tmp"))
            .unwrap()
            .count(),
        0,
        "joined failure must remove private baseline and candidate stages"
    );
    let after = std::fs::read_to_string(f._dir.path().join("calls.jsonl")).unwrap();
    let fresh: Vec<Value> = after
        .strip_prefix(&before)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(fresh.len(), 1);
    assert_eq!(fresh[0][0], "image");
    assert_eq!(fresh[0][1], "inspect");
    f.no_request().await;
}
