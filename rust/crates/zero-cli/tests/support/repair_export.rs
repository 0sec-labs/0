//! Extends the real CLI source -> reproduction -> two-matrix repair fixture.
use super::*;

pub(super) fn not_validated(f: &Fixture, request: &zero_protocol::repair::RepairValidationRequest) {
    let mut unsafe_request = request.clone();
    unsafe_request.materialize.replacement = "// unchanged attack behavior\n".into();
    fs::write(
        f.dir.path().join("unsafe.json"),
        serde_json::to_vec(&unsafe_request).unwrap(),
    )
    .unwrap();
    let output = f
        .cli()
        .args([
            "source-repair",
            "--session",
            &f.session,
            "--command-id",
            "unsafe-repair",
            "--request",
            "unsafe.json",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let repair: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(repair["result"]["status"], "not_validated");
    let rejected = f
        .cli()
        .args([
            "source-repair-export",
            "--session",
            &f.session,
            "--operation",
            &f.request.source_operation_id,
            "--reproduction",
            &request.reproduction_operation_id,
            "--repair",
            repair["operation"]["id"].as_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!rejected.status.success());
    assert!(rejected.stdout.is_empty());
}

pub(super) fn check(
    f: &Fixture,
    baseline: &Value,
    repair: &Value,
    original: &[u8],
    replacement: &str,
) {
    let id = repair["operation"]["id"].as_str().unwrap();
    let export = |state: &str, reproduction: &str| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        command
            .current_dir(f.dir.path())
            .args([
                "--state",
                state,
                "--providers",
                "absent.json",
                "--docker-bin",
                "absent-executor",
                "source-repair-export",
                "--session",
                &f.session,
                "--operation",
                &f.request.source_operation_id,
                "--reproduction",
                reproduction,
                "--repair",
                id,
            ])
            .env_remove("REPRO_TEST_KEY")
            .output()
            .unwrap()
    };
    fs::remove_file(f.dir.path().join("providers.json")).unwrap();
    let reproduction = baseline["operation"]["id"].as_str().unwrap();
    let output = export("state.db", reproduction);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output
            .stdout
            .starts_with(b"--- a/app.js\t\n+++ b/app.js\t\n")
    );
    let destination = f.dir.path().join("operator-copy");
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("app.js"), original).unwrap();
    fs::write(f.dir.path().join("export.patch"), &output.stdout).unwrap();
    let applied = Command::new("patch")
        .current_dir(&destination)
        .args(["--batch", "-p1", "-i"])
        .arg(f.dir.path().join("export.patch"))
        .output()
        .unwrap();
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    assert_eq!(
        fs::read(destination.join("app.js")).unwrap(),
        replacement.as_bytes()
    );
    // Correlation errors and partial/forged evidence emit no misleading patch prefix.
    let wrong = export("state.db", id);
    assert!(!wrong.status.success());
    assert!(wrong.stdout.is_empty());
    for mutation in ["partial", "replacement", "preimage"] {
        let script = r#"
import sqlite3,sys,json
source,dest,operation,kind=sys.argv[1:]
a=sqlite3.connect(source); b=sqlite3.connect(dest); a.backup(b); a.close()
outcome=json.loads(b.execute('select outcome from operations where id=?',(operation,)).fetchone()[0])
if kind=='partial':
    outcome['phases']=outcome['phases'][:1]
    b.execute('update operations set outcome=? where id=?',(json.dumps(outcome),operation))
else:
    if kind=='replacement': digest=outcome['artifacts']['repair.replacement']
    else: digest=b.execute("select digest from operation_artifacts where name='source.bundle' limit 1").fetchone()[0]
    b.execute('update artifacts set bytes=? where digest=?',(b'corrupt retained bytes',digest))
b.commit();b.close()
"#;
        let file = format!("{mutation}.db");
        let mutated = Command::new("python3")
            .current_dir(f.dir.path())
            .args(["-c", script, "state.db", &file, id, mutation])
            .output()
            .unwrap();
        assert!(
            mutated.status.success(),
            "{}",
            String::from_utf8_lossy(&mutated.stderr)
        );
        let rejected = export(&file, reproduction);
        assert!(!rejected.status.success(), "{mutation} accepted");
        assert!(rejected.stdout.is_empty());
    }
}
