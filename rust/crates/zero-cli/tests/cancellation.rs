#![cfg(target_os = "linux")]

use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, process::Stdio, time::Duration};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};

async fn send(stdin: &mut ChildStdin, id: u64, method: &str, params: Option<Value>) {
    let command = params.map_or_else(
        || json!({"method":method}),
        |params| json!({"method":method,"params":params}),
    );
    let message = json!({"protocol_version":1,"id":id,"command":command});
    stdin
        .write_all(format!("{message}\n").as_bytes())
        .await
        .unwrap();
    stdin.flush().await.unwrap();
}

async fn receive(stdout: &mut BufReader<ChildStdout>) -> Value {
    let mut line = String::new();
    let count = tokio::time::timeout(Duration::from_secs(15), stdout.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_ne!(count, 0, "app-server closed before expected response");
    serde_json::from_str(&line).unwrap()
}

// This fixture tests CLI cancellation orchestration, not real Docker isolation.
enum Stop {
    Admission,
    Request,
    Eof,
    Signal,
}

async fn exercise(stop: Stop) {
    let uid = std::process::Command::new("id").arg("-u").output().unwrap();
    if String::from_utf8_lossy(&uid.stdout).trim() == "0" {
        eprintln!("requires the executor's qualified nonroot Linux host");
        return;
    }
    let dir = TempDir::new().unwrap();
    let docker = dir.path().join("fake-docker");
    let script = format!(
        r#"#!/bin/sh
case "$1" in
  image) printf '%s\n' 'sha256:{}' ;;
  create) printf '%s\n' '{}' ;;
  start) exec sleep 30 ;;
  rm) touch "$(dirname "$0")/removed"; printf '%s\n' "$3" ;;
  container) exit 0 ;;
  *) exit 2 ;;
esac
"#,
        "a".repeat(64),
        "b".repeat(64)
    );
    std::fs::write(&docker, script).unwrap();
    std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o700)).unwrap();
    let source = dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("fixture.txt"), b"fixture\n").unwrap();
    let request = json!({
        "execution_id":"cancel-test", "image":"fixture:local", "argv":["sleep","30"],
        "snapshot":{
            "id":"fixture", "root":source,
            "digest":"sha256:e9284db8bac2a3335424fa3b88b08c5357bb83c9f404221b5aa43658dc7c53ea",
            "files":[{"path":"fixture.txt","bytes":8,"digest":"sha256:e80b71cd14d3cbd65f4173abcbfcf01a545dbca32a72d575108b553a648cc96f"}]
        },
        "timeout_ms":60000, "memory_mb":128,"cpus":0.5,"max_output_bytes":1024
    });
    let request_path = dir.path().join("request.json");
    std::fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(dir.path().join("state.db"))
        .arg("--docker-bin")
        .arg(&docker)
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    send(&mut input, 1, "initialize", None).await;
    assert_eq!(receive(&mut output).await["reply"]["type"], "initialized");
    send(
        &mut input,
        2,
        "session_create",
        Some(json!({"generation":"test","budget_limit":100})),
    )
    .await;
    let session = receive(&mut output).await["reply"]["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    send(
        &mut input,
        3,
        "execute",
        Some(json!({"session_id":session,"command_id":"command","request":request})),
    )
    .await;
    let admitted = receive(&mut output).await;
    assert_eq!(admitted["event"]["type"], "admitted", "{admitted}");
    assert_eq!(admitted["event"]["session_id"], session);
    assert_eq!(admitted["event"]["command_id"], "command");
    assert_eq!(admitted["event"]["execution_id"], "cancel-test");
    assert!(
        !admitted["event"]["operation_id"]
            .as_str()
            .unwrap()
            .is_empty()
    );
    if !matches!(stop, Stop::Admission) {
        let started = receive(&mut output).await;
        assert_eq!(started["event"]["type"], "started", "{started}");
    }
    if matches!(stop, Stop::Request | Stop::Admission) {
        send(
            &mut input,
            4,
            "cancel",
            Some(json!({"session_id":session,"execution_id":"cancel-test"})),
        )
        .await;
        let mut cancelled = false;
        let mut finished = false;
        while !cancelled || !finished {
            let message = receive(&mut output).await;
            if message["id"] == 4 {
                assert_eq!(message["reply"]["accepted"], true);
                cancelled = true;
            }
            if message["id"] == 3 {
                assert_eq!(message["reply"]["result"]["status"], "cancelled");
                assert_eq!(
                    message["reply"]["operation"]["id"],
                    admitted["event"]["operation_id"]
                );
                assert_eq!(message["reply"]["operation"]["status"], "cancelled");
                let cleanup = message["reply"]["result"]["cleanup"]["status"]
                    .as_str()
                    .unwrap();
                if matches!(stop, Stop::Admission) {
                    assert!(matches!(cleanup, "not_created" | "confirmed"));
                } else {
                    assert_eq!(cleanup, "confirmed");
                }
                finished = true;
            }
        }
        drop(input);
    } else {
        if matches!(stop, Stop::Signal) {
            assert!(
                Command::new("kill")
                    .args(["-TERM", &child.id().unwrap().to_string()])
                    .status()
                    .await
                    .unwrap()
                    .success()
            );
        }
        // For the signal path retain stdin until the terminal reply, so EOF
        // cannot accidentally be the shutdown trigger under test.
        let retained = if matches!(stop, Stop::Eof) {
            drop(input);
            None
        } else {
            Some(input)
        };
        let finished = receive(&mut output).await;
        assert_eq!(finished["id"], 3);
        assert_eq!(finished["reply"]["result"]["status"], "cancelled");
        assert_eq!(
            finished["reply"]["result"]["cleanup"]["status"],
            "confirmed"
        );
        drop(retained);
    }
    let status = tokio::time::timeout(Duration::from_secs(15), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success());
    if !matches!(stop, Stop::Admission) {
        assert!(dir.path().join("removed").exists());
    }
    // Transport reconnection must not replay the cancelled external effect.
    let retry = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(dir.path().join("state.db"))
        .arg("--docker-bin")
        .arg(dir.path().join("deliberately-missing-docker"))
        .args([
            "exec",
            "--session",
            &session,
            "--command-id",
            "command",
            "--request",
        ])
        .arg(request_path)
        .output()
        .await
        .unwrap();
    assert!(!retry.status.success());
    let retried: Value = serde_json::from_slice(&retry.stdout).unwrap();
    assert_eq!(retried["duplicate"], true);
    assert_eq!(retried["operation"]["status"], "cancelled");
}

#[tokio::test]
async fn cancellation_remains_responsive_during_execution() {
    exercise(Stop::Request).await;
}

#[tokio::test]
async fn eof_cancels_execution_and_waits_for_confirmed_cleanup() {
    exercise(Stop::Eof).await;
}

#[tokio::test]
async fn sigterm_cancels_execution_before_exiting() {
    exercise(Stop::Signal).await;
}

#[tokio::test]
async fn cancellation_after_durable_admission_is_accepted_and_settled() {
    exercise(Stop::Admission).await;
}
