#![cfg(unix)]
// Fixture setup must fail immediately when local test prerequisites are missing.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! An unread diagnostic sink must not prevent awaited engine shutdown.
use serde_json::json;
use std::{
    io::{ErrorKind, Write},
    os::{fd::OwnedFd, unix::net::UnixStream},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

#[tokio::test]
async fn full_console_stderr_does_not_trap_signal_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("fixture.txt"), "fixture").unwrap();
    let pin = zero_executor::pin_snapshot(&source).unwrap();
    let profile = dir.path().join("profile.json");
    std::fs::write(&profile, json!({"provider":"unconfigured","model":"fixture","instructions":"","prompt":"never submitted","execution":{"execution_id":"profile","image":"none","snapshot":pin,"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":1.0,"max_output_bytes":1024},"max_turns":1,"reservation_per_turn":1}).to_string()).unwrap();
    // Fill the same kernel buffer the child uses; keep its read side open.
    let (reader, mut fill) = UnixStream::pair().unwrap();
    let child_stderr: OwnedFd = fill.try_clone().unwrap().into();
    let mut child = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(dir.path().join("state.db"))
        .args(["console", "--session", "unused", "--request"])
        .arg(profile)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(child_stderr))
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    reader.set_nonblocking(true).unwrap();
    let mut reader = BufReader::new(tokio::net::UnixStream::from_std(reader).unwrap());
    let mut banner = String::new();
    tokio::time::timeout(Duration::from_secs(3), reader.read_line(&mut banner))
        .await
        .unwrap()
        .unwrap();
    assert!(banner.contains("line console"));
    // Let the ready console enter its signal/read select before flooding it.
    tokio::time::sleep(Duration::from_millis(50)).await;
    fill.set_nonblocking(true).unwrap();
    loop {
        match fill.write(&[b'x'; 4096]) {
            Ok(0) => panic!("diagnostic sink closed before test"),
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::WouldBlock => break,
            Err(error) => panic!("cannot fill diagnostic sink: {error}"),
        }
    }
    // Duplicates share this flag: restore normal child blocking I/O.
    fill.set_nonblocking(false).unwrap();
    input
        .write_all(b"a prompt with no configured provider\n")
        .await
        .unwrap();
    input.flush().await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        Command::new("kill")
            .args(["-TERM", &child.id().unwrap().to_string()])
            .status()
            .await
            .unwrap()
            .success()
    );
    let status = tokio::time::timeout(Duration::from_secs(9), child.wait())
        .await
        .expect("blocked stderr must not trap shutdown; stdin and stderr remain open")
        .unwrap();
    assert!(matches!(status.code(), Some(1 | 2)), "{status}");
    drop(input);
    drop(fill);
    drop(reader);
}
