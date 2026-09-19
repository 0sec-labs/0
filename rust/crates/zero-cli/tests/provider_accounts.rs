#![cfg(unix)]
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    process::Command,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
const SECRET: &str = "fixture-selected-account-secret";
struct Fixture {
    dir: tempfile::TempDir,
    listener: TcpListener,
    profile: Value,
    store: Value,
    session: String,
}
impl Fixture {
    fn new(copilot: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let id = if copilot { "copilot" } else { "openai" };
        let account = if copilot {
            json!({"kind":"oauth","tokens":{"accessToken":SECRET,"refreshToken":"unused-refresh-secret","tokenType":"Bearer","expiresAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64+600000}})
        } else {
            json!({"kind":"api_key","secret":SECRET})
        };
        let store = json!({"version":2,"providers":{id:{"activeAccountId":"other","accounts":{"chosen":account,"other":{"kind":"api_key","secret":"wrong-active-secret"}}}}});
        let profile = json!({"fixture":{"url":format!("http://{}/inference",listener.local_addr().unwrap()),"wire_api":if copilot{"chat_completions"}else{"responses"},"authentication":if copilot{"github_copilot"}else{"wire_default"},"credential_account":{"file":dir.path().join("credentials.json"),"provider_id":id,"account_id":"chosen"},"rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":3000,"max_response_bytes":8192}});
        let created = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(dir.path().join("state.db"))
            .args(["session", "create", "--budget-limit", "100"])
            .output()
            .unwrap();
        assert!(created.status.success());
        let value: Value = serde_json::from_slice(&created.stdout).unwrap();
        let session = value["session"]["id"].as_str().unwrap().to_owned();
        fs::write(dir.path().join("request.json"),json!({"model":"fixture","instructions":"inspect","input":[],"tools":[],"max_output_tokens":32}).to_string()).unwrap();
        let f = Self {
            dir,
            listener,
            profile,
            store,
            session,
        };
        f.save();
        f
    }
    fn save(&self) {
        fs::write(
            self.dir.path().join("credentials.json"),
            self.store.to_string(),
        )
        .unwrap();
        fs::set_permissions(
            self.dir.path().join("credentials.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        fs::write(
            self.dir.path().join("providers.json"),
            self.profile.to_string(),
        )
        .unwrap();
    }
    fn command(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        c.arg("--state")
            .arg(self.dir.path().join("state.db"))
            .arg("--providers")
            .arg(self.dir.path().join("providers.json"))
            .args([
                "infer",
                "--session",
                &self.session,
                "--command-id",
                "once",
                "--provider",
                "fixture",
                "--reservation",
                "10",
                "--request",
            ])
            .arg(self.dir.path().join("request.json"))
            .env("OPENAI_API_KEY", "ambient-not-selected")
            .env("0SEC_COPILOT_GITHUB_TOKEN", "ambient-not-selected");
        c
    }
}
#[test]
fn exact_connected_account_drives_native_inference_without_store_mutation() {
    for copilot in [false, true] {
        let f = Fixture::new(copilot);
        let before = fs::read(f.dir.path().join("credentials.json")).unwrap();
        let listener = f.listener.try_clone().unwrap();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(8);
            let mut stream = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline);
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]);
                    let size: usize = header
                        .lines()
                        .find_map(|l| {
                            l.split_once(':')
                                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                                .map(|(_, v)| v.trim().parse().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + size {
                        break;
                    }
                }
            }
            let request = String::from_utf8(bytes).unwrap();
            assert!(request.contains(&format!("authorization: Bearer {SECRET}")));
            assert!(!request.contains("wrong-active-secret"));
            assert!(!request.contains("unused-refresh-secret"));
            assert!(!request.contains("ambient-not-selected"));
            if copilot {
                assert!(request.contains("copilot-integration-id: vscode-chat"));
            }
            let body = if copilot {
                format!(
                    "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                    json!({"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}),
                    json!({"id":"c1","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}})
                )
            } else {
                format!(
                    "data: {}\n\n",
                    json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":1}}})
                )
            };
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        });
        let out = f.command().output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let value: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(value["operation"]["status"], "succeeded");
        server.join().unwrap();
        assert_eq!(
            before,
            fs::read(f.dir.path().join("credentials.json")).unwrap()
        );
        for data in [&out.stdout, &out.stderr] {
            assert!(!String::from_utf8_lossy(data).contains(SECRET));
        }
        assert!(f.listener.accept().is_err());
    }
}
#[test]
fn invalid_expired_mismatched_or_insecure_accounts_fail_without_network() {
    for case in [
        "missing",
        "expired",
        "refresh_only",
        "wrong_provider",
        "wrong_wire",
        "version",
        "environment_conflict",
        "mode",
        "hardlink",
        "malformed",
    ] {
        let mut f = Fixture::new(true);
        match case {
            "missing" => f.profile["fixture"]["credential_account"]["account_id"] = json!("absent"),
            "expired" => {
                f.store["providers"]["copilot"]["accounts"]["chosen"]["tokens"]["expiresAt"] =
                    json!(1)
            }
            "refresh_only" => {
                f.store["providers"]["copilot"]["accounts"]["chosen"]["tokens"]
                    .as_object_mut()
                    .unwrap()
                    .remove("accessToken");
            }
            "wrong_provider" => {
                f.profile["fixture"]["credential_account"]["provider_id"] = json!("openai")
            }
            "wrong_wire" => f.profile["fixture"]["wire_api"] = json!("responses"),
            "version" => f.store["version"] = json!(1),
            "environment_conflict" => f.profile["fixture"]["api_key_env"] = json!("OPENAI_API_KEY"),
            _ => {}
        }
        f.save();
        let path = f.dir.path().join("credentials.json");
        match case {
            "mode" => fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(),
            "hardlink" => fs::hard_link(&path, f.dir.path().join("second-link")).unwrap(),
            "malformed" => fs::write(&path, format!("broken json {SECRET}")).unwrap(),
            _ => {}
        }
        let before = fs::read(&path).unwrap();
        let out = f.command().output().unwrap();
        assert!(!out.status.success(), "{case}");
        assert!(f.listener.accept().is_err(), "{case}");
        assert_eq!(before, fs::read(&path).unwrap());
        for data in [&out.stdout, &out.stderr] {
            assert!(!String::from_utf8_lossy(data).contains(SECRET));
        }
    }
}
