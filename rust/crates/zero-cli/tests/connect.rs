use std::{
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    time::{Duration, Instant},
};
use tempfile::TempDir;

fn cli(dir: &TempDir) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    command
        .arg("--state")
        .arg(dir.path().join("never/state.db"))
        .arg("--providers")
        .arg(dir.path().join("missing-provider.json"));
    command
}

fn enrollment_fixture() -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let task = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "native connect made no enrollment request");
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("{error}"),
            }
        };
        socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut request = Vec::new();
        loop {
            let mut buffer = [0; 2048];
            let read = socket.read(&mut buffer).unwrap();
            assert_ne!(read, 0);
            request.extend_from_slice(&buffer[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let body = r#"{"authenticated":true,"org":{"id":"org-1","name":"Example","slug":"example"},"installation":{"installed":true},"repoAccessible":true}"#;
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        String::from_utf8(request).unwrap()
    });
    (host, task)
}

fn dispatch_fixture() -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let task = std::thread::spawn(move || {
        let responses = [
            (
                "GET /api/enrollment/status?",
                r#"{"authenticated":true,"org":{"id":"org-1","name":"Example","slug":"example"},"installation":{"installed":true},"repoAccessible":true}"#,
            ),
            ("GET /api/scan-schedules?", r#"{"schedules":[]}"#),
            ("POST /api/scans ", r#"{"id":"scan-1","targetId":"target-1"}"#),
            (
                "POST /api/scan-schedules ",
                r#"{"id":"schedule-1","nextRunAt":null}"#,
            ),
        ];
        let mut requests = Vec::new();
        for (expected, body) in responses {
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "native connect omitted {expected}");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut request = Vec::new();
            loop {
                let mut buffer = [0; 2048];
                let read = socket.read(&mut buffer).unwrap();
                assert_ne!(read, 0);
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with(expected), "{request}");
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            requests.push(request);
        }
        requests
    });
    (host, task)
}

#[test]
fn connect_defaults_to_enrollment_get_without_dispatch() {
    let dir = TempDir::new().unwrap();
    let (host, fixture) = enrollment_fixture();
    let output = cli(&dir)
        .args([
            "connect",
            "--host",
            &host,
            "--token-env",
            "CONNECT_FIXTURE_TOKEN",
            "https://github.com/example/repo",
        ])
        .env("CONNECT_FIXTURE_TOKEN", "fixture-secret")
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["state"], "ready");
    assert_eq!(reply["org"]["slug"], "example");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("fixture-secret"));
    let request = fixture.join().unwrap();
    assert!(request.starts_with("GET /api/enrollment/status?target="));
    assert!(!request.contains("POST "));
    assert!(!dir.path().join("never").exists());
}

#[test]
fn connect_rejects_conflicting_or_implicit_dispatch_flags_before_network() {
    let dir = TempDir::new().unwrap();
    for arguments in [
        vec!["connect", "--setup-only", "--run", "https://github.com/example/repo"],
        vec!["connect", "--schedule", "https://github.com/example/repo"],
        vec!["connect", "--cron", "0 3 * * *", "https://github.com/example/repo"],
    ] {
        let output = cli(&dir).args(arguments).output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(!dir.path().join("never").exists());
    }
}

#[test]
fn connect_explicit_run_and_schedule_dispatches_exactly_one_of_each() {
    let dir = TempDir::new().unwrap();
    let (host, fixture) = dispatch_fixture();
    let output = cli(&dir)
        .args([
            "connect",
            "--host",
            &host,
            "--token-env",
            "CONNECT_FIXTURE_TOKEN",
            "--run",
            "--schedule",
            "--test-command",
            "cargo test",
            "https://github.com/example/repo",
        ])
        .env("CONNECT_FIXTURE_TOKEN", "fixture-secret")
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["state"], "ready");
    assert_eq!(reply["scanId"], "scan-1");
    assert_eq!(reply["scheduleId"], "schedule-1");
    assert_eq!(reply["scanUrl"], "/example/scans/scan-1");
    let requests = fixture.join().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(!String::from_utf8_lossy(&output.stdout).contains("fixture-secret"));
    assert!(!dir.path().join("never").exists());
}
