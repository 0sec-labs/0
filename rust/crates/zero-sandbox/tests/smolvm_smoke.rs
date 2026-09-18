//! Existing archive only: ZERO_SMOLVM_SMOKE_ARCHIVE=/prepared/node.tar.
#![cfg(target_os = "linux")]
use sha2::{Digest, Sha256};
use std::{fs, io::Read, sync::Arc};
use tokio_util::sync::CancellationToken;
use zero_executor::pin_snapshot;
use zero_protocol::ExecutionStatus;
use zero_sandbox::*;
#[tokio::test]
#[ignore = "requires existing local Node archive and qualified nonroot KVM profile; never pulls"]
async fn real_microvm_snapshot_build_workdir_and_readonly_source() {
    let archive = std::env::var("ZERO_SMOLVM_SMOKE_ARCHIVE")
        .expect("explicit existing archive path required");
    let mut file = fs::File::open(&archive).unwrap();
    let mut hash = Sha256::new();
    let mut bytes = [0; 65536];
    loop {
        let n = file.read(&mut bytes).unwrap();
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    let source = tempfile::tempdir().unwrap();
    let program = r#"const fs=require('fs'),assert=require('assert');
assert.strictEqual(process.getuid(),1000);
assert.strictEqual(fs.readFileSync('built','utf8'),'yes');
assert.strictEqual(process.argv[2],"quote' ; $(false)");
assert.strictEqual(fs.readFileSync(0,'utf8'),'native snapshot input');
assert(!process.env.OPENAI_API_KEY);
assert(!fs.existsSync('/var/run/docker.sock'));
let denied=false;try{fs.writeFileSync('/snapshot/main.js','mutation')}catch(e){denied=true}assert(denied);
fs.writeFileSync('workdir-write','allowed');
console.log(JSON.stringify({uid:process.getuid(),build:'ok',snapshot:'readonly',workdir:process.cwd()}));"#;
    fs::write(source.path().join("main.js"), program).unwrap();
    let request = SandboxRequest {
        execution_id: "real-smolvm-facade".into(),
        backend: SandboxBackend::Smolvm {
            image_archive: archive.into(),
            archive_digest: format!("sha256:{:x}", hash.finalize()),
            storage_gb: 4,
        },
        snapshot: pin_snapshot(source.path()).unwrap(),
        argv: vec!["node".into(), "main.js".into(), "quote' ; $(false)".into()],
        build_argv: Some(vec![
            "node".into(),
            "-e".into(),
            "require('fs').writeFileSync('built','yes')".into(),
        ]),
        stdin: Some("native snapshot input".into()),
        timeout_ms: 120000,
        memory_mb: 2048,
        cpus: 2.0,
        max_output_bytes: 4096,
    };
    let result = SandboxExecutor::new()
        .execute(request, CancellationToken::new(), Arc::new(|_| {}))
        .await;
    assert_eq!(result.status, ExecutionStatus::Exited, "{result:?}");
    assert_eq!(
        result.exit_code,
        Some(0),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        matches!(result.cleanup, SandboxCleanup::Confirmed),
        "{result:?}"
    );
    assert_eq!(
        fs::read_to_string(source.path().join("main.js")).unwrap(),
        program
    );
    let proof: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(proof["snapshot"], "readonly");
    eprintln!("actual microVM snapshot proof: {proof}");
}
