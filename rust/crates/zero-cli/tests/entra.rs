#![cfg(unix)]
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use tempfile::TempDir;
fn command(state: &std::path::Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    cmd.arg("--state").arg(state);
    cmd
}
fn read(socket: &mut TcpStream) -> String {
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = vec![];
    loop {
        let mut chunk = [0; 4096];
        let n = socket.read(&mut chunk).unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&chunk[..n]);
        assert!(bytes.len() < 1024 * 1024);
        if let Some(end) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
            let header = String::from_utf8_lossy(&bytes[..end]);
            let size: usize = header
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                        .map(|(_, v)| v.trim().parse().unwrap())
                })
                .unwrap();
            if bytes.len() >= end + 4 + size {
                return String::from_utf8(bytes).unwrap();
            }
        }
    }
}
fn accept(listener: &TcpListener) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        match listener.accept() {
            Ok((socket, _)) => return socket,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline, "fixture request timeout");
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => panic!("{e}"),
        }
    }
}
fn respond(socket: &mut TcpStream, status: &str, kind: &str, body: &str) {
    write!(socket,"HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
}
fn run_fixture(fail_refresh: bool) {
    let dir = TempDir::new().unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let endpoint = format!("{base}/responses");
    let credential = dir.path().join("entra.json");
    std::fs::write(&credential,json!({"schema_version":1,"session_id":"00000000-0000-0000-0000-000000000001","tenant_id":"00000000-0000-0000-0000-000000000002","client_id":"00000000-0000-0000-0000-000000000003","account_id":"fixture","endpoint":endpoint,"scope":"https://cognitiveservices.azure.com/.default","revision":0,"refresh_token":"original-refresh-secret","access_token":null,"expires_at_ms":null}).to_string()).unwrap();
    std::fs::set_permissions(&credential, std::fs::Permissions::from_mode(0o600)).unwrap();
    let profiles = dir.path().join("providers.json");
    std::fs::write(&profiles,json!({"entra":{"url":endpoint,"authentication":"azure_entra","entra_credentials_file":credential,"entra_token_endpoint":format!("{base}/token"),"rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":3000,"max_response_bytes":8192}}).to_string()).unwrap();
    let request = dir.path().join("request.json");
    std::fs::write(&request,json!({"model":"fixture","instructions":"inspect","input":[],"tools":[],"max_output_tokens":32}).to_string()).unwrap();
    let mut sessions = vec![];
    for i in 0..if fail_refresh { 1 } else { 2 } {
        let state = dir.path().join(format!("state-{i}.db"));
        let created = command(&state)
            .args(["session", "create", "--budget-limit", "100"])
            .output()
            .unwrap();
        assert!(created.status.success());
        let reply: Value = serde_json::from_slice(&created.stdout).unwrap();
        sessions.push((state, reply["session"]["id"].as_str().unwrap().to_owned()));
    }
    let proof_path = credential.clone();
    let server = std::thread::spawn(move || {
        let mut socket = accept(&listener);
        let auth = read(&mut socket);
        assert!(auth.starts_with("POST /token "));
        assert!(auth.contains("refresh_token=original-refresh-secret"));
        if fail_refresh {
            respond(
                &mut socket,
                "400 Bad Request",
                "application/json",
                "{\"error\":\"original-refresh-secret\"}",
            );
            return listener;
        }
        // Both native processes start against the original revision; the second
        // waits for the shared credential lock rather than issuing another refresh.
        std::thread::sleep(Duration::from_millis(100));
        respond(&mut socket,"200 OK","application/json",&json!({"token_type":"Bearer","access_token":"rotated-access-secret","refresh_token":"rotated-refresh-secret","expires_in":3600}).to_string());
        drop(socket);
        for _ in 0..2 {
            let mut socket = accept(&listener);
            let inference = read(&mut socket);
            assert!(inference.starts_with("POST /responses "));
            assert!(inference.contains("authorization: Bearer rotated-access-secret"));
            let proof: Value =
                serde_json::from_slice(&std::fs::read(&proof_path).unwrap()).unwrap();
            assert_eq!(proof["revision"], 1);
            assert_eq!(proof["refresh_token"], "rotated-refresh-secret");
            let body = format!(
                "data: {}\n\n",
                json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":1}}})
            );
            respond(&mut socket, "200 OK", "text/event-stream", &body);
        }
        listener
    });
    let infer = |state: &std::path::Path, session: &str| {
        let mut cmd = command(state);
        cmd.arg("--providers")
            .arg(&profiles)
            .args([
                "infer",
                "--session",
                session,
                "--command-id",
                "once",
                "--provider",
                "entra",
                "--reservation",
                "10",
                "--request",
            ])
            .arg(&request);
        cmd
    };
    let children: Vec<_> = sessions
        .iter()
        .map(|(state, session)| {
            infer(state, session)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    for child in children {
        let output = child.wait_with_output().unwrap();
        assert_eq!(
            output.status.success(),
            !fail_refresh,
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains("secret"));
        let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            reply["operation"]["status"],
            if fail_refresh { "unknown" } else { "succeeded" }
        );
    }
    let listener = server.join().unwrap();
    for (state, session) in sessions {
        let retry = infer(&state, &session).output().unwrap();
        let reply: Value = serde_json::from_slice(&retry.stdout).unwrap();
        assert_eq!(reply["duplicate"], true);
        assert!(matches!(listener.accept(),Err(e)if e.kind()==std::io::ErrorKind::WouldBlock));
        let budget = command(&state)
            .args(["session", "budget", &session])
            .output()
            .unwrap();
        let budget: Value = serde_json::from_slice(&budget.stdout).unwrap();
        assert_eq!(
            budget["budget"]["charged"],
            if fail_refresh { 0 } else { 3 }
        );
        assert_eq!(
            budget["budget"]["reserved"],
            if fail_refresh { 10 } else { 0 }
        );
    }
    let persisted: Value = serde_json::from_slice(&std::fs::read(&credential).unwrap()).unwrap();
    assert_eq!(persisted["revision"], if fail_refresh { 0 } else { 1 });
}
#[test]
fn native_processes_share_durable_rotation_and_charge_without_inference_replay() {
    run_fixture(false);
}
#[test]
fn refresh_failure_keeps_usage_unknown_and_never_contacts_model() {
    run_fixture(true);
}
