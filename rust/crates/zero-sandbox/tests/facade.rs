#![cfg(target_os = "linux")]
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;
use zero_executor::{DockerExecutor, pin_snapshot};
use zero_protocol::{ExecutionStatus, OutputStream};
use zero_sandbox::*;
use zero_smolvm::SmolvmConfig;
fn setup() -> (tempfile::TempDir, SandboxRequest) {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("source")).unwrap();
    fs::write(dir.path().join("source/main.js"), b"trusted pinned bytes").unwrap();
    let request = SandboxRequest {
        execution_id: "facade-test".into(),
        backend: SandboxBackend::Docker {
            image: "local:test".into(),
        },
        snapshot: pin_snapshot(&dir.path().join("source")).unwrap(),
        argv: vec!["node".into(), "main.js".into(), "quote' ; $(false)".into()],
        build_argv: None,
        stdin: Some("literal input".into()),
        timeout_ms: 2000,
        memory_mb: 128,
        cpus: 0.5,
        max_output_bytes: 1024,
    };
    (dir, request)
}
#[tokio::test]
async fn docker_delegation_preserves_identity_events_and_cleanup() {
    let (dir, request) = setup();
    let binary = dir.path().join("docker");
    fs::write(
        &binary,
        include_bytes!("../../zero-executor/tests/fixtures/fake-docker.py"),
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(dir.path().join("scenario.txt"), "raw").unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let capture = events.clone();
    let executor = SandboxExecutor::with_backends(
        DockerExecutor::with_binary(binary),
        SmolvmConfig::default(),
    );
    let result = executor
        .execute(
            request,
            CancellationToken::new(),
            Arc::new(move |event| capture.lock().unwrap().push(event)),
        )
        .await;
    assert_eq!(result.status, ExecutionStatus::Exited, "{result:?}");
    assert!(
        matches!(result.cleanup, SandboxCleanup::Confirmed),
        "{result:?}"
    );
    assert!(matches!(
        result.artifact,
        SandboxArtifact::Docker {
            resolved_image_id: Some(_),
            ..
        }
    ));
    assert!(events.lock().unwrap().iter().any(|e| matches!(
        e,
        SandboxEvent::Output {
            stream: OutputStream::Stdout,
            ..
        }
    )));
}
#[tokio::test]
async fn fractional_microvm_cpu_is_rejected_before_launch_and_no_docker_fallback() {
    let (_dir, mut request) = setup();
    request.backend = SandboxBackend::Smolvm {
        image_archive: "/missing/local.tar".into(),
        archive_digest: format!("sha256:{}", "0".repeat(64)),
        storage_gb: 1,
    };
    let result = SandboxExecutor::new()
        .execute(request, CancellationToken::new(), Arc::new(|_| {}))
        .await;
    assert_eq!(result.status, ExecutionStatus::Failed);
    assert!(result.error.unwrap().contains("integer CPUs"));
    assert!(matches!(result.cleanup, SandboxCleanup::NotCreated));
}
#[tokio::test]
#[ignore = "fake launcher still requires qualified nonroot Linux/KVM; run under already-authorized KVM group"]
async fn microvm_private_snapshot_and_buffered_bytes() {
    let (dir, mut request) = setup();
    let binary = dir.path().join("fake-smolvm");
    fs::write(
        &binary,
        r#"#!/usr/bin/python3
import sys,os,json,time
if sys.argv[1:]==['--version']:
 print('smolvm 1.14.6');sys.exit(0)
args=sys.argv[1:]
source,target,mode=args[args.index('--volume')+1].rsplit(':',2)
assert target=='/snapshot' and mode=='ro'
assert open(source+'/main.js','rb').read()==b'trusted pinned bytes'
assert os.stat(source+'/main.js').st_mode & 0o222 == 0
script=args[-1]
assert 'mktemp -d /tmp/0sec-work.' in script
assert 'cp -R /snapshot/. .' in script and ' >&2' in script
assert "quote'\\'' ; $(false)" in script
assert sys.stdin.buffer.read()==b'literal input'
sys.stderr.write('Starting ephemeral machine (vm-abc123)...\n');sys.stderr.flush()
fixture=os.path.dirname(os.path.realpath(sys.argv[0]))
scenario=open(fixture+'/scenario').read() if os.path.exists(fixture+'/scenario') else ''
if scenario=='tamper': open(fixture+'/source/main.js','wb').write(b'changed after staging')
if scenario=='hang':
 open(fixture+'/started.tmp','w').write(source);os.rename(fixture+'/started.tmp',fixture+'/started');time.sleep(30)
sys.stdout.write(json.dumps({'source':source}));sys.stdout.flush()
os.write(2,b'\xff\x00')
"#,
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let archive = dir.path().join("image.tar");
    fs::write(&archive, b"archive").unwrap();
    use sha2::{Digest, Sha256};
    request.backend = SandboxBackend::Smolvm {
        image_archive: archive,
        archive_digest: format!("sha256:{:x}", Sha256::digest(b"archive")),
        storage_gb: 1,
    };
    request.cpus = 1.0;
    request.build_argv = Some(vec!["true".into()]);
    let events = Arc::new(Mutex::new(Vec::new()));
    let capture = events.clone();
    let executor = SandboxExecutor::with_backends(
        DockerExecutor::with_binary("/must-not-run-docker".into()),
        SmolvmConfig {
            binary,
            setpriv: "/usr/bin/setpriv".into(),
        },
    );
    let result = executor
        .execute(
            request.clone(),
            CancellationToken::new(),
            Arc::new(move |e| capture.lock().unwrap().push(e)),
        )
        .await;
    assert_eq!(result.status, ExecutionStatus::Exited, "{result:?}");
    assert_eq!(result.exit_code, Some(0), "{result:?}");
    assert!(
        matches!(result.cleanup, SandboxCleanup::Confirmed),
        "{result:?}"
    );
    assert_eq!(result.stderr, b"\xff\0");
    let value: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert!(!std::path::Path::new(value["source"].as_str().unwrap()).exists());
    assert!(
        !events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, SandboxEvent::Started { .. }))
    );
    fs::write(dir.path().join("scenario"), "hang").unwrap();
    let owned = executor.clone();
    let pending = request.clone();
    let task = tokio::spawn(async move {
        owned
            .execute(pending, CancellationToken::new(), Arc::new(|_| {}))
            .await
    });
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    while !dir.path().join("started").exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "fake guest did not start"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let staged = fs::read_to_string(dir.path().join("started")).unwrap();
    task.abort();
    let _ = task.await;
    while std::path::Path::new(&staged).exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "dropped caller leaked staged snapshot"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    fs::write(dir.path().join("scenario"), "tamper").unwrap();
    let changed = executor
        .execute(request, CancellationToken::new(), Arc::new(|_| {}))
        .await;
    assert_eq!(changed.status, ExecutionStatus::Failed, "{changed:?}");
    assert!(
        changed
            .error
            .unwrap()
            .contains("post-execution snapshot verification failed")
    );
    assert!(matches!(changed.cleanup, SandboxCleanup::Confirmed));
}
#[tokio::test]
async fn interactive_microvm_is_unsupported_before_any_launcher_or_filesystem_access() {
    let (_dir, mut request) = setup();
    request.cpus = 1.0;
    request.backend = SandboxBackend::Smolvm {
        image_archive: "/missing/local.tar".into(),
        archive_digest: format!("sha256:{}", "0".repeat(64)),
        storage_gb: 1,
    };
    let (_tx, input) = zero_executor::interactive_input();
    let result = SandboxExecutor::new()
        .execute_interactive(request, CancellationToken::new(), Arc::new(|_| {}), input)
        .await;
    assert_eq!(result.status, ExecutionStatus::Failed);
    assert_eq!(
        result.error.as_deref(),
        Some("interactive transport requires Docker")
    );
    assert!(matches!(result.cleanup, SandboxCleanup::NotCreated));
}
