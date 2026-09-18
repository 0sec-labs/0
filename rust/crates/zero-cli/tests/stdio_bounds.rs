#![cfg(unix)]
use std::{
    process::{Command, Stdio},
    time::Duration,
};
use tokio::io::AsyncReadExt;

#[tokio::test]
async fn snapshot_json_writer_exits_on_signal_with_reader_still_open() {
    let dir = tempfile::tempdir().unwrap();
    for index in 0..1024 {
        std::fs::write(dir.path().join(format!("file-{index:04}.txt")), b"x").unwrap();
    }
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .args(["snapshot", "pin"])
        .arg(dir.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut pipe = child.stdout.take().unwrap();
    tokio::time::timeout(Duration::from_secs(5), pipe.read_exact(&mut [0]))
        .await
        .unwrap()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(child.try_wait().unwrap().is_none());
    assert!(
        Command::new("kill")
            .args(["-TERM", &child.id().unwrap().to_string()])
            .status()
            .unwrap()
            .success()
    );
    let status = tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.code(), Some(2));
    drop(pipe);
}

#[tokio::test]
async fn request_read_can_be_interrupted_while_fifo_writer_never_connects() {
    let dir = tempfile::tempdir().unwrap();
    let fifo = dir.path().join("request.fifo");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let db = dir.path().join("state.db");
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&db)
        .args([
            "infer",
            "--session",
            "missing",
            "--command-id",
            "test",
            "--provider",
            "fixture",
            "--reservation",
            "1",
            "--request",
        ])
        .arg(&fifo)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !db.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(child.try_wait().unwrap().is_none());
    assert!(
        Command::new("kill")
            .args(["-TERM", &child.id().unwrap().to_string()])
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .unwrap()
            .unwrap()
            .code(),
        Some(2)
    );
}
