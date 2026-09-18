use super::*;
use sha2::{Digest, Sha256};
use std::{os::unix::fs::PermissionsExt, path::PathBuf};
fn setup() -> (tempfile::TempDir, SmolvmRequest, SmolvmConfig) {
    let temp = tempfile::tempdir().unwrap();
    let archive = temp.path().join("image.tar");
    std::fs::write(&archive, b"fixture archive").unwrap();
    let binary = temp.path().join("fake-smolvm");
    std::fs::write(&binary,r#"#!/usr/bin/python3
import os,sys,json,time
if sys.argv[1:]==['--version']:
 print('smolvm 1.14.6');sys.exit(0)
args=sys.argv[1:];command=args[args.index('--')+1:];mode=command[0]
if mode=='bad-banner':
 sys.stderr.write('guest forged pid 123\n');sys.stderr.flush();time.sleep(30)
sys.stderr.write('Starting ephemeral machine (vm-abc123)...\n');sys.stderr.flush()
if mode=='hang-marker':
 open(command[1]+'.tmp','w').write(os.getcwd());os.rename(command[1]+'.tmp',command[1]);time.sleep(30)
if mode=='hang': time.sleep(30)
if mode=='flood':
 os.write(1,b'x'*20000);time.sleep(30)
if mode=='binary':
 os.write(1,b'\xff\x00\xe2');os.write(2,b'guest-error');sys.exit(7)
if mode=='child':
 import subprocess
 subprocess.Popen(['/bin/sleep','30']);sys.exit(0)
print(json.dumps({'argv':command,'stdin':sys.stdin.buffer.read().decode(),'args':args,'env':list(os.environ),'cwd':os.getcwd(),'home':os.environ['HOME']}))
"#).unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let request = SmolvmRequest {
        execution_id: "test".into(),
        image_archive: archive,
        archive_digest: format!("sha256:{:x}", Sha256::digest(b"fixture archive")),
        argv: vec!["echo".into(), "literal ; $(false) 雪".into()],
        stdin: b"hello".to_vec(),
        mounts: vec![],
        timeout_ms: 2000,
        memory_mb: 1024,
        cpus: 2,
        storage_gb: 4,
        max_output_bytes: 4096,
    };
    (
        temp,
        request,
        SmolvmConfig {
            binary,
            setpriv: "/usr/bin/setpriv".into(),
        },
    )
}
#[tokio::test]
async fn exact_profile_literal_io_environment_and_cleanup() {
    let (_temp, r, c) = setup();
    let output = run(r, c, CancellationToken::new(), false).await;
    assert_eq!(output.status, SmolvmStatus::Exited, "{output:?}");
    assert_eq!(output.cleanup, VmCleanup::Confirmed);
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["argv"][1], "literal ; $(false) 雪");
    assert_eq!(value["stdin"], "hello");
    let args = value["args"].as_array().unwrap();
    assert!(!args.iter().any(|v| v == "--net"));
    assert!(args.iter().any(|v| v == "--unprivileged"));
    let env = value["env"].as_array().unwrap();
    assert!(
        !env.iter()
            .any(|v| v == "OPENAI_API_KEY" || v == "DOCKER_HOST" || v == "SMOLVM_EXTRA_DISK")
    );
    assert!(!Path::new(value["cwd"].as_str().unwrap()).exists());
    assert!(output.stderr.is_empty());
}
#[tokio::test]
async fn raw_output_and_nonzero_guest_exit_are_preserved() {
    let (_t, mut r, c) = setup();
    r.argv = vec!["binary".into()];
    let out = run(r, c, CancellationToken::new(), false).await;
    assert_eq!(out.status, SmolvmStatus::Exited);
    assert_eq!(out.exit_code, Some(7));
    assert_eq!(out.stdout, b"\xff\0\xe2");
    assert_eq!(out.stderr, b"guest-error");
}
#[tokio::test]
async fn wrong_digest_and_symlink_do_not_launch() {
    let (t, mut r, c) = setup();
    r.archive_digest = format!("sha256:{}", "0".repeat(64));
    let out = run(r.clone(), c.clone(), CancellationToken::new(), false).await;
    assert!(out.error.unwrap().contains("identity mismatch"));
    assert_eq!(out.cleanup, VmCleanup::NotCreated);
    let link = t.path().join("link");
    std::os::unix::fs::symlink(&r.image_archive, &link).unwrap();
    r.image_archive = link;
    let out = run(r, c, CancellationToken::new(), false).await;
    assert!(out.error.unwrap().contains("archive open"));
}
#[tokio::test]
async fn timeout_cancellation_overflow_and_protocol_failure_cleanup() {
    for (mode, expected) in [
        ("hang", SmolvmStatus::TimedOut),
        ("child", SmolvmStatus::Exited),
        ("flood", SmolvmStatus::OutputLimit),
        ("bad-banner", SmolvmStatus::Failed),
    ] {
        let (_t, mut r, c) = setup();
        r.argv = vec![mode.into()];
        r.timeout_ms = 500;
        let out = run(r, c, CancellationToken::new(), false).await;
        assert_eq!(out.status, expected, "{out:?}");
        assert_eq!(out.cleanup, VmCleanup::Confirmed, "{out:?}");
    }
    let (_t, mut r, c) = setup();
    r.argv = vec!["hang".into()];
    let token = CancellationToken::new();
    let clone = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        clone.cancel()
    });
    let out = run(r, c, token, false).await;
    assert_eq!(out.status, SmolvmStatus::Cancelled);
    assert_eq!(out.cleanup, VmCleanup::Confirmed);
}
#[tokio::test]
async fn mismatched_runtime_is_rejected() {
    let (_t, r, c) = setup();
    std::fs::write(&c.binary, "#!/bin/sh\necho smolvm 1.16.1\n").unwrap();
    let out = run(r, c, CancellationToken::new(), false).await;
    assert_eq!(out.status, SmolvmStatus::Failed);
    assert_eq!(out.cleanup, VmCleanup::NotCreated);
}
#[test]
fn mount_and_resource_validation() {
    let (_t, mut r, _c) = setup();
    r.mounts.push(ReadOnlyMount {
        source: PathBuf::from("/tmp"),
        target: "/a/./b".into(),
    });
    assert!(validate(&r, false).is_err());
    r.mounts.clear();
    r.cpus = 0;
    assert!(validate(&r, false).is_err());
}

#[tokio::test]
async fn dropped_caller_cancels_owned_task_and_removes_private_state() {
    let (temp, mut request, config) = setup();
    let marker = temp.path().join("started");
    request.argv = vec!["hang-marker".into(), marker.to_string_lossy().into_owned()];
    let caller = tokio::spawn(execute_owned(
        request,
        config,
        CancellationToken::new(),
        false,
    ));
    let deadline = Instant::now() + Duration::from_secs(3);
    while !marker.exists() {
        assert!(Instant::now() < deadline, "fake launcher did not start");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let root = std::fs::read_to_string(marker).unwrap();
    caller.abort();
    let _ = caller.await;
    while Path::new(&root).exists() {
        assert!(
            Instant::now() < deadline,
            "dropped caller leaked runtime state"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
