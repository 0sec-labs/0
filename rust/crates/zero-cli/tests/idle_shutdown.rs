#![cfg(unix)]
//! Keep stdin open until the process has exited: EOF must not mask a signal bug.
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
async fn exercise(console: bool) {
    let dir = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    command.arg("--state").arg(dir.path().join("state.db"));
    if console {
        let source = dir.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("fixture.txt"), "fixture").unwrap();
        let pin = zero_executor::pin_snapshot(&source).unwrap();
        let profile = dir.path().join("profile.json");
        std::fs::write(&profile,json!({"provider":"unconfigured","model":"fixture","instructions":"","prompt":"never submitted","execution":{"execution_id":"profile","image":"none","snapshot":pin,"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":1.0,"max_output_bytes":1024},"max_turns":1,"reservation_per_turn":1}).to_string()).unwrap();
        command
            .args(["console", "--session", "unused", "--request"])
            .arg(profile);
    } else {
        command.arg("app-server");
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut ready = String::new();
    if console {
        let mut error = BufReader::new(child.stderr.take().unwrap());
        tokio::time::timeout(Duration::from_secs(3), error.read_line(&mut ready))
            .await
            .unwrap()
            .unwrap();
        assert!(ready.contains("line console"));
    } else {
        input
            .write_all(
                b"{\"protocol_version\":1,\"id\":1,\"command\":{\"method\":\"initialize\"}}\n",
            )
            .await
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        tokio::time::timeout(Duration::from_secs(3), output.read_line(&mut ready))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&ready).unwrap()["id"], 1);
    }
    assert!(
        Command::new("kill")
            .args(["-TERM", &child.id().unwrap().to_string()])
            .status()
            .await
            .unwrap()
            .success()
    );
    let status = tokio::time::timeout(Duration::from_secs(4), child.wait())
        .await
        .expect("stdin was still open: signal shutdown must not wait for EOF")
        .unwrap();
    assert_eq!(status.code(), Some(if console { 1 } else { 0 }));
    drop(input);
}
#[tokio::test]
async fn idle_console_signal_exits_without_stdin_eof() {
    exercise(true).await;
}
#[tokio::test]
async fn idle_app_server_signal_exits_without_stdin_eof() {
    exercise(false).await;
}
