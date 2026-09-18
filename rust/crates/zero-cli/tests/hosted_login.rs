#![cfg(unix)]
#![allow(clippy::unwrap_used)]
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};
struct Fixture {
    home: tempfile::TempDir,
    listener: TcpListener,
}
impl Fixture {
    fn new() -> Self {
        Self {
            home: tempfile::tempdir().unwrap(),
            listener: TcpListener::bind("127.0.0.1:0").unwrap(),
        }
    }
    fn cli(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        c.env("HOME", self.home.path())
            .env_remove("0SEC_CLOUD_TOKEN")
            .env_remove("0SEC_CLOUD_HOST")
            .args(["--state"])
            .arg(self.home.path().join("unused.db"))
            .args([
                "--providers",
                "/absent-provider",
                "--harness-config",
                "/absent-harness",
                "hosted",
                "--host",
                &format!("http://{}", self.listener.local_addr().unwrap()),
                "login",
            ]);
        c
    }
    fn credentials(&self) -> std::path::PathBuf {
        self.home.path().join(".0sec/cloud.env")
    }
    fn old(&self) {
        fs::create_dir(self.home.path().join(".0sec")).unwrap();
        fs::set_permissions(
            self.home.path().join(".0sec"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        fs::write(self.credentials(), b"0SEC_CLOUD_TOKEN=old-secret\n").unwrap();
        fs::set_permissions(self.credentials(), fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn response(&self, status: u16, body: &str) -> std::thread::JoinHandle<String> {
        let listener = self.listener.try_clone().unwrap();
        listener.set_nonblocking(true).unwrap();
        let body = body.to_owned();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline);
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                let mut buf = [0; 1024];
                let n = socket.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
            }
            let header = String::from_utf8(bytes).unwrap();
            assert!(!header.to_lowercase().contains("authorization:"));
            write!(socket,"HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            header
        })
    }
    fn clean_output(&self, out: &Output) {
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(!text.contains("fixture-secret"));
        assert!(!text.contains("old-secret"));
        assert!(!text.contains("override-secret"));
        assert!(!self.home.path().join("unused.db").exists());
    }
}
#[test]
fn ready_atomically_replaces_private_file_and_reports_environment_precedence() {
    let f = Fixture::new();
    f.old();
    let server = f.response(
        200,
        r#"{"status":"ready","token":"fixture-secret=allowed"}"#,
    );
    let out = f
        .cli()
        .env("0SEC_CLOUD_TOKEN", "override-secret")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    f.clean_output(&out);
    let result: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(result["logged_in"], true);
    assert_eq!(result["environment_override"], true);
    let contents = fs::read_to_string(f.credentials()).unwrap();
    assert!(contents.contains("0SEC_CLOUD_TOKEN=fixture-secret=allowed\n"));
    assert!(!contents.contains("old-secret"));
    assert_eq!(
        fs::metadata(f.credentials()).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let header = server.join().unwrap();
    let session = header
        .split("/cli-auth/sessions/")
        .nth(1)
        .unwrap()
        .split(' ')
        .next()
        .unwrap();
    assert!(String::from_utf8_lossy(&out.stderr).contains(&format!("/cli-auth?session={session}")));
    assert_eq!(
        fs::read_dir(f.home.path().join(".0sec")).unwrap().count(),
        1
    );
}
#[test]
fn first_login_creates_only_private_default_directory_after_ready() {
    let f = Fixture::new();
    let server = f.response(200, r#"{"status":"ready","access_token":"fixture-secret"}"#);
    let out = f.cli().output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    server.join().unwrap();
    f.clean_output(&out);
    assert_eq!(
        fs::metadata(f.home.path().join(".0sec"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(f.credentials()).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
#[test]
fn expired_rate_limited_and_invalid_token_leave_existing_credentials_unchanged() {
    for (status, body) in [
        (410, "fixture-secret"),
        (429, "fixture-secret"),
        (200, r#"{"status":"pending","token":"fixture-secret"}"#),
        (
            200,
            r#"{"status":"ready","token":"fixture-secret\nINJECT=value"}"#,
        ),
    ] {
        let f = Fixture::new();
        f.old();
        let server = f.response(status, body);
        let out = f.cli().output().unwrap();
        assert!(!out.status.success());
        server.join().unwrap();
        f.clean_output(&out);
        assert_eq!(
            fs::read(f.credentials()).unwrap(),
            b"0SEC_CLOUD_TOKEN=old-secret\n"
        );
    }
}
#[test]
fn timeout_and_signal_before_ready_leave_credentials_unchanged() {
    for signal in [false, true] {
        let f = Fixture::new();
        if signal {
            f.old();
        }
        let mut c = f.cli();
        if !signal {
            c.args(["--timeout-ms", "30"]);
        }
        let mut child = c
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        if signal {
            std::thread::sleep(Duration::from_millis(100));
            assert!(
                Command::new("kill")
                    .args(["-TERM", &child.id().to_string()])
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("login did not stop");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let out = child.wait_with_output().unwrap();
        assert!(!out.status.success());
        f.clean_output(&out);
        if signal {
            assert_eq!(
                fs::read(f.credentials()).unwrap(),
                b"0SEC_CLOUD_TOKEN=old-secret\n"
            );
        } else {
            assert!(!f.home.path().join(".0sec").exists());
        }
    }
}
#[test]
fn symlink_target_or_parent_and_nonprivate_file_are_never_replaced() {
    for mode in ["file-link", "directory-link", "public-file"] {
        let f = Fixture::new();
        f.old();
        let outside = f.home.path().join("outside");
        fs::write(&outside, b"outside-secret").unwrap();
        match mode {
            "file-link" => {
                fs::remove_file(f.credentials()).unwrap();
                std::os::unix::fs::symlink(&outside, f.credentials()).unwrap();
            }
            "directory-link" => {
                fs::rename(f.home.path().join(".0sec"), f.home.path().join("private")).unwrap();
                std::os::unix::fs::symlink(
                    f.home.path().join("private"),
                    f.home.path().join(".0sec"),
                )
                .unwrap();
            }
            _ => fs::set_permissions(f.credentials(), fs::Permissions::from_mode(0o644)).unwrap(),
        };
        let server = f.response(200, r#"{"status":"ready","token":"fixture-secret"}"#);
        let out = f.cli().output().unwrap();
        assert!(!out.status.success());
        server.join().unwrap();
        f.clean_output(&out);
        assert_eq!(fs::read(&outside).unwrap(), b"outside-secret");
        if mode != "file-link" {
            assert_eq!(
                fs::read(f.credentials()).unwrap(),
                b"0SEC_CLOUD_TOKEN=old-secret\n"
            );
        }
    }
}
#[test]
fn explicit_destination_and_login_help_do_not_use_existing_credentials() {
    let f = Fixture::new();
    fs::set_permissions(f.home.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let target = f.home.path().join("chosen.env");
    let server = f.response(200, r#"{"status":"ready","token":"fixture-secret"}"#);
    let out = f.cli().arg("--credentials").arg(&target).output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    server.join().unwrap();
    f.clean_output(&out);
    assert!(target.exists());
    assert!(!f.home.path().join(".0sec").exists());
    let help = f.cli().arg("--help").output().unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("--credentials"));
}
