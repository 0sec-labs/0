//! Opt-in actual isolation test; requires a locally installed Node image.
//! Never pulls. Run `cargo test -p zero-executor --test docker_smoke -- --ignored`.
#![cfg(target_os = "linux")]
use std::{fs, sync::Arc};
use tokio_util::sync::CancellationToken;
use zero_executor::{DockerExecutor, pin_snapshot};
use zero_protocol::{CleanupStatus, ExecutionEvent, ExecutionRequest, ExecutionStatus};

#[tokio::test]
#[ignore = "requires nonroot Linux and a local Docker Node image; never pulls"]
async fn real_isolation_build_and_cancellation() {
    assert!(!nix::unistd::Uid::current().is_root());
    let source = tempfile::tempdir().unwrap();
    let script = r#"
const fs = require('fs'), os = require('os'), assert = require('assert');
assert(process.getuid() !== 0);
assert.strictEqual(fs.readFileSync('built','utf8'),'built');
assert.strictEqual(process.argv[2], "quote' ; $(touch /tmp/should-not-exist)");
assert(!fs.existsSync('/tmp/should-not-exist'));
for (const path of ['/0sec-write-test','/snapshot/forbidden']) {
  let denied=false; try {fs.writeFileSync(path,'x')} catch(e) {denied=true}
  assert(denied,path+' must not be writable');
}
fs.writeFileSync('/tmp/allowed','ok');
const status=fs.readFileSync('/proc/self/status','utf8');
assert(/^CapEff:\s+0+$/m.test(status)); assert(/^NoNewPrivs:\s+1$/m.test(status));
assert(Object.values(os.networkInterfaces()).flat().every(i=>i.internal));
assert(!process.env.OPENAI_API_KEY && !process.env.GITHUB_TOKEN && !process.env.DOCKER_HOST);
const memory=fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim();
const pids=fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim();
assert.strictEqual(memory,'134217728'); assert.strictEqual(pids,'64');
console.log(JSON.stringify({uid:process.getuid(),network:'loopback-only',rootfs:'readonly',memory,pids,build:'ok'}));
"#;
    fs::write(source.path().join("main.js"), script).unwrap();
    let mut request = ExecutionRequest {
        execution_id: "real-smoke".into(),
        image: std::env::var("ZERO_DOCKER_SMOKE_IMAGE").unwrap_or_else(|_| "node:24-alpine".into()),
        snapshot: pin_snapshot(source.path()).unwrap(),
        argv: vec![
            "node".into(),
            "main.js".into(),
            "quote' ; $(touch /tmp/should-not-exist)".into(),
        ],
        build_argv: Some(vec![
            "node".into(),
            "-e".into(),
            "require('fs').writeFileSync('built','built')".into(),
        ]),
        stdin: None,
        timeout_ms: 15000,
        memory_mb: 128,
        cpus: 0.5,
        max_output_bytes: 8192,
    };
    let executor = DockerExecutor::new();
    let result = executor
        .execute(request.clone(), CancellationToken::new(), Arc::new(|_| {}))
        .await;
    assert_eq!(result.status, ExecutionStatus::Exited, "{result:?}");
    assert_eq!(
        result.exit_code,
        Some(0),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(result.cleanup, CleanupStatus::Confirmed, "{result:?}");
    let proof: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(proof["uid"], nix::unistd::Uid::current().as_raw());
    assert_eq!(
        fs::read_to_string(source.path().join("main.js")).unwrap(),
        script
    );
    eprintln!("actual Docker isolation proof: {proof}");
    request.argv = vec![
        "node".into(),
        "-e".into(),
        "console.log('ready');setInterval(()=>{},1000)".into(),
    ];
    request.build_argv = None;
    let token = CancellationToken::new();
    let stop = token.clone();
    let cancelled = executor
        .execute(
            request,
            token,
            Arc::new(move |e| {
                if matches!(e, ExecutionEvent::Output { .. }) {
                    stop.cancel();
                }
            }),
        )
        .await;
    assert_eq!(
        cancelled.status,
        ExecutionStatus::Cancelled,
        "{cancelled:?}"
    );
    assert_eq!(cancelled.cleanup, CleanupStatus::Confirmed, "{cancelled:?}");
}
