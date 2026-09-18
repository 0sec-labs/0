#![cfg(target_os = "linux")]
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use zero_executor::{DockerExecutor, pin_snapshot};
use zero_protocol::{CleanupStatus, ExecutionEvent, ExecutionRequest, ExecutionStatus};

struct Fixture {
    dir: tempfile::TempDir,
    request: ExecutionRequest,
    executor: DockerExecutor,
}
impl Fixture {
    fn new(scenario: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("docker");
        fs::write(&binary, include_str!("fixtures/fake-docker.py")).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(dir.path().join("scenario.txt"), scenario).unwrap();
        let source = dir.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("main.txt"), b"original").unwrap();
        let request = ExecutionRequest {
            execution_id: "test".into(),
            image: "local:test".into(),
            snapshot: pin_snapshot(&source).unwrap(),
            argv: vec!["cat".into()],
            build_argv: None,
            stdin: Some("hello\n".into()),
            timeout_ms: 2000,
            memory_mb: 128,
            cpus: 0.5,
            max_output_bytes: 1024,
        };
        Self {
            dir,
            request,
            executor: DockerExecutor::with_binary(binary),
        }
    }
    fn root() -> bool {
        nix::unistd::Uid::current().is_root()
    }
    fn assert_no_child(&self) {
        let path = self.dir.path().join("child.pid");
        if let Ok(pid) = fs::read_to_string(path) {
            if let Ok(stat) = fs::read_to_string(format!("/proc/{}/stat", pid.trim())) {
                assert!(
                    stat.rsplit_once(')')
                        .unwrap()
                        .1
                        .trim_start()
                        .starts_with('Z'),
                    "descendant still running: {pid}"
                );
            }
        }
    }
}

#[tokio::test]
async fn success_preserves_bytes_hardening_and_cleanup() {
    if Fixture::root() {
        return;
    }
    let f = Fixture::new("echo");
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let result = f
        .executor
        .execute(
            f.request.clone(),
            CancellationToken::new(),
            Arc::new(move |e| sink.lock().unwrap().push(e)),
        )
        .await;
    assert_eq!(result.status, ExecutionStatus::Exited, "{result:?}");
    assert_eq!(result.exit_code, Some(0));
    assert_eq!(result.stdout, b"hello\n");
    assert_eq!(result.cleanup, CleanupStatus::Confirmed);
    assert!(result.recovery_dir.is_none());
    let calls = fs::read_to_string(f.dir.path().join("calls.jsonl")).unwrap();
    for required in [
        "no-new-privileges:true",
        "--read-only",
        "--cap-drop",
        "--network",
        "none",
        "--pull",
        "never",
        "0.5",
    ] {
        assert!(calls.contains(required), "missing {required}");
    }
    assert!(!f.dir.path().join("container.json").exists());
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, ExecutionEvent::Output { .. }))
    );
}

#[tokio::test]
async fn nonzero_and_arbitrary_bytes_are_results() {
    if Fixture::root() {
        return;
    }
    for (scenario, code) in [("nonzero", 7), ("raw", 0)] {
        let f = Fixture::new(scenario);
        let result = f
            .executor
            .execute(f.request, CancellationToken::new(), Arc::new(|_| {}))
            .await;
        assert_eq!(result.status, ExecutionStatus::Exited, "{result:?}");
        assert_eq!(result.exit_code, Some(code));
        assert_eq!(result.cleanup, CleanupStatus::Confirmed);
        if scenario == "raw" {
            assert_eq!(result.stdout, [255, 240, 159, 152, 128]);
        }
    }
}

#[tokio::test]
async fn timeout_cancel_and_output_overflow_remove_container_and_children() {
    if Fixture::root() {
        return;
    }
    for scenario in ["hang", "cancel", "flood"] {
        let mut f = Fixture::new(scenario);
        f.request.timeout_ms = 300;
        let cancel = CancellationToken::new();
        let on_output = cancel.clone();
        let result = f
            .executor
            .execute(
                f.request.clone(),
                cancel,
                Arc::new(move |event| {
                    if scenario == "cancel" && matches!(event, ExecutionEvent::Output { .. }) {
                        on_output.cancel();
                    }
                }),
            )
            .await;
        assert_eq!(
            result.status,
            match scenario {
                "cancel" => ExecutionStatus::Cancelled,
                "flood" => ExecutionStatus::OutputLimit,
                _ => ExecutionStatus::TimedOut,
            },
            "{result:?}"
        );
        assert_eq!(result.cleanup, CleanupStatus::Confirmed, "{result:?}");
        assert!(result.stdout.len() <= 1024);
        assert!(!f.dir.path().join("container.json").exists());
        tokio::time::sleep(Duration::from_millis(20)).await;
        f.assert_no_child();
    }
}

#[tokio::test]
async fn interrupted_create_and_failed_cleanup_never_claim_confirmed() {
    if Fixture::root() {
        return;
    }
    for scenario in ["create-hang", "cleanup-fail"] {
        let mut f = Fixture::new(scenario);
        f.request.timeout_ms = 250;
        let result = f
            .executor
            .execute(
                f.request.clone(),
                CancellationToken::new(),
                Arc::new(|_| {}),
            )
            .await;
        assert!(
            matches!(result.cleanup, CleanupStatus::Unconfirmed { .. }),
            "{result:?}"
        );
        let recovery = result.recovery_dir.expect("retained snapshot");
        assert!(std::path::Path::new(&recovery).exists());
        fs::remove_dir_all(recovery).unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        f.assert_no_child();
    }
}

#[tokio::test]
async fn invalid_pin_precancel_and_image_error_cannot_start_container() {
    if Fixture::root() {
        return;
    }
    for scenario in ["tampered", "precancel", "image-fail"] {
        let f = Fixture::new(scenario);
        let cancel = CancellationToken::new();
        if scenario == "tampered" {
            fs::write(
                std::path::Path::new(&f.request.snapshot.root).join("main.txt"),
                b"changed!",
            )
            .unwrap();
        }
        if scenario == "precancel" {
            cancel.cancel();
        }
        let result = f
            .executor
            .execute(f.request, cancel, Arc::new(|_| {}))
            .await;
        assert_ne!(result.status, ExecutionStatus::Exited);
        assert_eq!(result.cleanup, CleanupStatus::NotCreated);
        let calls = fs::read_to_string(f.dir.path().join("calls.jsonl")).unwrap_or_default();
        assert!(!calls.contains("\"create\""));
    }
}

#[tokio::test]
async fn changed_source_after_start_invalidates_success() {
    if Fixture::root() {
        return;
    }
    let f = Fixture::new("echo");
    let path = std::path::PathBuf::from(&f.request.snapshot.root).join("main.txt");
    let result = f
        .executor
        .execute(
            f.request,
            CancellationToken::new(),
            Arc::new(move |e| {
                if matches!(e, ExecutionEvent::Started { .. }) {
                    fs::write(&path, b"changed!").unwrap();
                }
            }),
        )
        .await;
    assert_eq!(result.status, ExecutionStatus::Failed);
    assert_eq!(result.cleanup, CleanupStatus::Confirmed);
    assert!(
        result
            .error
            .unwrap()
            .contains("snapshot verification failed")
    );
}

#[tokio::test]
async fn dropped_caller_future_still_cleans_up() {
    if Fixture::root() {
        return;
    }
    let f = Fixture::new("hang");
    let executor = f.executor.clone();
    let request = f.request.clone();
    let ready = Arc::new(tokio::sync::Notify::new());
    let notify = ready.clone();
    let task = tokio::spawn(async move {
        executor
            .execute(
                request,
                CancellationToken::new(),
                Arc::new(move |e| {
                    if matches!(e, ExecutionEvent::Output { .. }) {
                        notify.notify_one();
                    }
                }),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), ready.notified())
        .await
        .unwrap();
    assert!(f.dir.path().join("container.json").exists());
    task.abort();
    assert!(task.await.is_err());
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let calls = fs::read_to_string(f.dir.path().join("calls.jsonl")).unwrap_or_default();
            if !f.dir.path().join("container.json").exists() && calls.contains("\"ls\"") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    f.assert_no_child();
}

#[tokio::test]
async fn control_timeout_and_exited_supervisor_cannot_leave_pipe_holders() {
    if Fixture::root() {
        return;
    }
    for scenario in ["image-hang", "orphan-pipes"] {
        let mut f = Fixture::new(scenario);
        f.request.timeout_ms = 300;
        let result = f
            .executor
            .execute(
                f.request.clone(),
                CancellationToken::new(),
                Arc::new(|_| {}),
            )
            .await;
        if scenario == "image-hang" {
            assert_eq!(result.status, ExecutionStatus::TimedOut, "{result:?}");
            assert_eq!(result.cleanup, CleanupStatus::NotCreated);
        } else {
            assert_eq!(result.status, ExecutionStatus::Exited, "{result:?}");
            assert_eq!(result.cleanup, CleanupStatus::Confirmed);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        f.assert_no_child();
    }
}
