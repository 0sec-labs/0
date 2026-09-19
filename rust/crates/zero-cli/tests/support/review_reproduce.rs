//! Actual CLI review/archive/host-reproduction route with a process lifecycle
//! backend fixture. This does not claim real Docker execution or isolation.
use super::*;
use base64::Engine as _;
use std::os::unix::fs::PermissionsExt;

async fn setup() -> (Fixture, PathBuf) {
    let f = Fixture::new().await;
    std::fs::write(f.source.join("unselected.bin"), [0, 255, 128]).unwrap();
    let pin = zero_executor::pin_snapshot(&f.source).unwrap();
    let digest = &pin
        .files
        .iter()
        .find(|v| v.path == "app.rs")
        .unwrap()
        .digest;
    let reviewed = submit_cited(&f, f.run("source"), digest).await;
    let id = reviewed["review"]["review"]["id"].as_str().unwrap();
    let store = zero_store::Store::open_read_only(&f.state).unwrap();
    let record = store.review_by_command("source").unwrap().unwrap();
    let root = store.get_operation(&record.root_operation_id).unwrap();
    let request: zero_protocol::agent::AgentRequest =
        serde_json::from_value(root.payload["request"].clone()).unwrap();
    let report = zero_engine::read_review_report(&f.state, id).unwrap();
    let source = report.source.unwrap();
    let manifest = store.review_source_archive_manifest(id).unwrap().unwrap();
    let plan = json!({"schema_version":1,"review_id":id,"source_operation_id":record.root_operation_id,
    "archive_manifest_sha256":format!("sha256:{}",zero_plugin::sha256(&manifest.canonical_bytes().unwrap())),
    "deadline_ms":30000,"max_executions":4,"plan":{
        "schema_version":1,"oracle_version":"zero-verification-exact-output-v1",
        "hypothesis_id":source.review.hypotheses[0].id,"source_bundle_digest":source.review.bundle_sha256,
        "snapshot":request.snapshot_request().unwrap().snapshot,
        "backend":{"type":"docker","image":format!("sha256:{}","a".repeat(64))},
        "limits":{"timeout_ms":5000,"memory_mb":128,"cpus":1,"max_output_bytes":4096},"repeats":2,
        "cases":[
            {"id":"attack","mode":"attack","argv":["/bin/cat"],"stdin":"attack\n","expected":{"exit_code":0,"stdout":base64::engine::general_purpose::STANDARD.encode(b"attack\n"),"stderr":base64::engine::general_purpose::STANDARD.encode(b"fixture diagnostic\n")}},
            {"id":"control","mode":"legitimate_control","argv":["/bin/cat"],"stdin":"control\n","expected":{"exit_code":0,"stdout":base64::engine::general_purpose::STANDARD.encode(b"control\n"),"stderr":base64::engine::general_purpose::STANDARD.encode(b"fixture diagnostic\n")}}
        ]
    }});
    drop(store);
    let plan_path = f._dir.path().join("host-plan.json");
    std::fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
    let probe = r#"
    import sqlite3,hashlib
    db=sqlite3.connect('file:'+str(root/'state.db')+'?mode=ro',uri=True)
    rows=db.execute("select id from operations where status='running' and json_extract(payload,'$.kind')='reproduction_case'").fetchall()
    assert len(rows)==1, rows
    operation=rows[0][0]
    receipt=db.execute("select payload from events where kind='native_reproduction_effect_started' and json_extract(payload,'$.operation_id')=?",(operation,)).fetchone()
    assert receipt is not None
    raw,digest=db.execute("select b.bytes,a.digest from operation_artifacts a join artifacts b on b.digest=a.digest where a.operation_id=? and a.name='native_reproduction.effect_start'",(operation,)).fetchone()
    assert 'sha256:'+hashlib.sha256(raw).hexdigest()==digest
    assert json.loads(raw)==json.loads(receipt[0])
    mount=args[args.index('--mount')+1]
    source=pathlib.Path(mount.split('src=')[1].split(',')[0])
    assert (source/'unselected.bin').read_bytes()==bytes([0,255,128])
    assert b'retained review marker' in (source/'app.rs').read_bytes()
    with (root/'mounts.jsonl').open('a') as log: log.write(json.dumps(str(source))+'\n')
    db.close()
"#;
    let fake = include_str!("../../../zero-executor/tests/fixtures/fake-docker.py").replace(
        "elif args[0] == \"create\":",
        &format!("elif args[0] == \"create\":{probe}"),
    );
    std::fs::write(f._dir.path().join("docker"), fake).unwrap();
    std::fs::set_permissions(
        f._dir.path().join("docker"),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    std::fs::write(f._dir.path().join("scenario.txt"), "echo").unwrap();
    std::fs::remove_dir_all(&f.source).unwrap();
    std::fs::remove_file(&f.providers).unwrap();
    std::fs::remove_file(&f.profiles).unwrap();
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
            "reproduce",
            "--command-id",
            "native-matrix",
            "--plan",
        ])
        .arg(plan)
        .env_remove("REVIEW_CLI_KEY")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    c
}
fn inspect(f: &Fixture, selector: &str, id: &str, format: &str) -> Command {
    // These global configuration paths have already been removed by setup.
    let mut c = f.cli();
    c.args(["review", "reproduction", selector, id, "--format", format]);
    c
}
fn cleaned(f: &Fixture) {
    assert!(!f._dir.path().join("container.json").exists());
    for line in std::fs::read_to_string(f._dir.path().join("mounts.jsonl"))
        .unwrap()
        .lines()
    {
        let path: String = serde_json::from_str(line).unwrap();
        assert!(
            !std::path::Path::new(&path).exists(),
            "guest snapshot not removed"
        );
    }
}

#[tokio::test]
async fn native_reproduction_cli_uses_archive_and_retries_without_source_config_or_backend() {
    let (f, plan) = setup().await;
    let mut unsupported = command(&f, &plan);
    unsupported.arg("--providers").arg(&f.providers);
    let rejected = finish(unsupported.spawn().unwrap()).await;
    assert!(!rejected.status.success());
    assert!(rejected.stdout.is_empty());
    assert!(!f._dir.path().join("calls.jsonl").exists());
    assert!(
        zero_store::Store::open_read_only(&f.state)
            .unwrap()
            .native_reproduction_by_command("native-matrix")
            .unwrap()
            .is_none()
    );
    // The retained review predates native reproduction. Only the owned fresh
    // invocation may upgrade it; the initial cached lookup must stay inert.
    let downgraded = std::process::Command::new("python3")
        .arg("-c")
        .arg("import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript('DROP INDEX native_reproduction_admission_command; DROP INDEX native_reproduction_parent_command; DROP INDEX native_reproduction_command; DROP TABLE native_reproductions; PRAGMA user_version=19;'); db.close()")
        .arg(&f.state)
        .output()
        .unwrap();
    assert!(
        downgraded.status.success(),
        "{}",
        String::from_utf8_lossy(&downgraded.stderr)
    );
    let out = finish(command(&f, &plan).spawn().unwrap()).await;
    let result = decoded(&out);
    assert!(
        out.status.success(),
        "{}; {result}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(result["operation"]["status"], "succeeded");
    assert_eq!(
        result["result"]["assessment"]["disposition"],
        "observed_for_plan"
    );
    assert_eq!(
        result["result"]["assessment"]["vulnerability_reportable"],
        false
    );
    assert_eq!(result["result"]["children"].as_array().unwrap().len(), 4);
    cleaned(&f);
    let calls = std::fs::read(f._dir.path().join("calls.jsonl")).unwrap();
    std::fs::remove_file(f._dir.path().join("docker")).unwrap();
    let mut retry = command(&f, &plan);
    retry
        .arg("--providers")
        .arg(&f.providers)
        .arg("--review-profiles")
        .arg(&f.profiles);
    let retried = finish(retry.spawn().unwrap()).await;
    assert!(retried.status.success());
    let cached = decoded(&retried);
    assert_eq!(cached["duplicate"], true);
    assert_eq!(cached["result"], result["result"]);
    // A cached terminal outcome cannot hide damaged independently retained case
    // evidence. Copy the database so this does not alter the positive fixture.
    let damaged = f._dir.path().join("damaged.db");
    let corrupt = std::process::Command::new("python3")
        .arg("-c")
        .arg(r#"
import sqlite3,sys
source=sqlite3.connect(sys.argv[1]); dest=sqlite3.connect(sys.argv[2])
source.backup(dest); source.close()
digest=dest.execute("select digest from operation_artifacts where operation_id=? and name='reproduction.evidence'",(sys.argv[3],)).fetchone()[0]
dest.execute("update artifacts set bytes=? where digest=?",(b'corrupted retained case evidence',digest))
dest.commit(); dest.close()
"#)
        .arg(&f.state).arg(&damaged)
        .arg(result["result"]["children"][0].as_str().unwrap())
        .output().unwrap();
    assert!(
        corrupt.status.success(),
        "{}",
        String::from_utf8_lossy(&corrupt.stderr)
    );
    let mut corrupt_retry = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    corrupt_retry
        .arg("--state")
        .arg(&damaged)
        .arg("--docker-bin")
        .arg(f._dir.path().join("absent-backend"))
        .args([
            "review",
            "reproduce",
            "--command-id",
            "native-matrix",
            "--plan",
        ])
        .arg(&plan)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let rejected = finish(corrupt_retry.spawn().unwrap()).await;
    assert!(!rejected.status.success());
    assert!(
        rejected.stdout.is_empty(),
        "corruption must not publish cached success"
    );
    assert!(
        String::from_utf8_lossy(&rejected.stderr).contains("artifact"),
        "{}",
        String::from_utf8_lossy(&rejected.stderr)
    );
    let mut altered: Value = serde_json::from_slice(&std::fs::read(&plan).unwrap()).unwrap();
    altered["max_executions"] = json!(5);
    std::fs::write(&plan, serde_json::to_vec(&altered).unwrap()).unwrap();
    let conflict = finish(command(&f, &plan).spawn().unwrap()).await;
    assert!(!conflict.status.success());
    assert!(conflict.stdout.is_empty());
    std::fs::remove_file(&plan).unwrap();
    let reproduction = result["operation"]["payload"]["reproduction_id"]
        .as_str()
        .unwrap();
    for (selector, id) in [
        ("--command-id", "native-matrix"),
        ("--reproduction", reproduction),
    ] {
        let out = finish(inspect(&f, selector, id, "json").spawn().unwrap()).await;
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let inspected = decoded(&out);
        assert_eq!(inspected["operation"], result["operation"]);
        assert_eq!(inspected["result"], result["result"]);
    }
    let out = finish(
        inspect(&f, "--reproduction", reproduction, "terminal")
            .spawn()
            .unwrap(),
    )
    .await;
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains(reproduction));
    assert!(text.contains("ObservedForPlan"));
    assert!(text.contains("does not verify a vulnerability"));
    let mut corrupt_inspect = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    corrupt_inspect
        .arg("--state")
        .arg(&damaged)
        .args(["review", "reproduction", "--command-id", "native-matrix"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let rejected = finish(corrupt_inspect.spawn().unwrap()).await;
    assert!(!rejected.status.success());
    assert!(rejected.stdout.is_empty());
    assert_eq!(
        std::fs::read(f._dir.path().join("calls.jsonl")).unwrap(),
        calls
    );
    f.no_request().await;
}

#[tokio::test]
async fn native_reproduction_cli_sigterm_drains_case_cleanup_before_exit() {
    let (f, plan) = setup().await;
    std::fs::write(f._dir.path().join("scenario.txt"), "hang").unwrap();
    let mut child = command(&f, &plan).spawn().unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !f._dir.path().join("child.pid").exists() {
        assert!(tokio::time::Instant::now() < deadline);
        if child.try_wait().unwrap().is_some() {
            panic!(
                "reproduction exited before held backend: {:?}",
                finish(child).await
            );
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let active = finish(
        inspect(&f, "--command-id", "native-matrix", "json")
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
    assert!(
        child.try_wait().unwrap().is_none(),
        "inspection must not stop the owner"
    );
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
    let result = decoded(&out);
    assert_eq!(result["operation"]["status"], "cancelled");
    cleaned(&f);
    let calls = std::fs::read(f._dir.path().join("calls.jsonl")).unwrap();
    let retry = finish(command(&f, &plan).spawn().unwrap()).await;
    assert!(!retry.status.success());
    assert_eq!(decoded(&retry)["duplicate"], true);
    assert_eq!(
        std::fs::read(f._dir.path().join("calls.jsonl")).unwrap(),
        calls
    );
    f.no_request().await;
}
