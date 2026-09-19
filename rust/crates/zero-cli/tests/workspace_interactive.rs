#![cfg(target_os = "linux")]
//! Local provider and real process edit/test/export lifecycle. Fake Docker is not an isolation oracle.
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::PermissionsExt,
    process::Command,
    time::{Duration, Instant},
};
fn cli(dir: &tempfile::TempDir) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    c.env("WORKSPACE_FIXTURE_KEY", "local-fixture");
    c.arg("--state").arg(dir.path().join("state.db"));
    c
}
fn invoke(mut c: Command) -> Value {
    let result = c.output().unwrap();
    assert!(
        result.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&result.stdout).unwrap()
}
fn request(s: &mut TcpStream) -> Value {
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut data = vec![];
    loop {
        let mut b = [0; 8192];
        let n = s.read(&mut b).unwrap();
        assert_ne!(n, 0);
        data.extend_from_slice(&b[..n]);
        assert!(data.len() < 2 * 1024 * 1024);
        if let Some(end) = data.windows(4).position(|p| p == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&data[..end]);
            let length = head
                .lines()
                .find_map(|v| {
                    let (k, v) = v.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            if data.len() >= end + 4 + length {
                return serde_json::from_slice(&data[end + 4..end + 4 + length]).unwrap();
            }
        }
    }
}
fn complete(output: Value) -> String {
    format!(
        "data: {}\n\n",
        json!({"type":"response.completed","response":{"id":"workspace-fixture","status":"completed","output":output,"usage":{"input_tokens":1,"output_tokens":1}}})
    )
}
fn tool(n: usize, name: &str, args: Value) -> Value {
    json!([{"type":"function_call","call_id":format!("call-{n}"),"name":name,"arguments":args.to_string()}])
}
#[test]
fn physical_generation_bound_sessions_survive_turns_and_reject_stale_writes() {
    exercise(false);
}
#[test]
#[ignore = "requires installed immutable Docker image; no pulls or paid models"]
fn actual_docker_generation_bound_sessions() {
    exercise(true);
}
fn exercise(real: bool) {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("original");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("app.py"), "print('old')\n").unwrap();
    std::fs::write(source.join("control.txt"), "unchanged\n").unwrap();
    let snapshot = zero_executor::pin_snapshot(&source).unwrap();
    let app_sha = snapshot
        .files
        .iter()
        .find(|f| f.path == "app.py")
        .unwrap()
        .digest
        .clone();
    let fake = dir.path().join("docker");
    let script=include_str!("../../zero-executor/tests/fixtures/fake-docker.py").replace("state.write_text(json.dumps({\"name\": name, \"id\": container_id}))","state.write_text(json.dumps({\"name\": name, \"id\": container_id, \"args\": args}))").replace("elif args[0] == \"start\":","elif args[0] == \"start\":\n    import shlex, shutil, tempfile, os\n    saved = json.loads(state.read_text())[\"args\"]\n    mount = saved[saved.index(\"--mount\") + 1]\n    source = mount.split(\"src=\",1)[1].split(\",\",1)[0]\n    command = shlex.split(saved[-1].split(\"\\nexec \", 1)[1])\n    with tempfile.TemporaryDirectory() as guest:\n        shutil.copytree(source, guest, dirs_exist_ok=True)\n        os.chmod(os.path.join(guest, \"control.txt\"), 0o600)\n        result = subprocess.run(command, cwd=guest)\n    sys.exit(result.returncode)");
    std::fs::write(&fake, script).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(dir.path().join("scenario.txt"), "workspace").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let mut generations = vec![];
        let mut current = String::new();
        let mut old_generation = String::new();
        let mut handle = String::new();
        for turn in 0..17 {
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut stream = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "waiting model turn{turn}");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            let input = request(&mut stream);
            assert!(
                !input["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|t| t["name"] == "execute_snapshot")
            );
            let outputs: Vec<Value> = input["input"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|v| v["output"].as_str())
                .filter_map(|v| serde_json::from_str(v).ok())
                .collect();
            let generation = outputs
                .iter()
                .filter_map(|v| v["generation"].as_str())
                .last()
                .unwrap_or("");
            if !generation.is_empty() {
                generations.push(generation.to_owned());
            }
            if matches!(turn, 1 | 2 | 8) {
                current = generation.to_owned();
            }
            if matches!(turn, 3 | 12) {
                handle = outputs.last().unwrap()["session_id"]
                    .as_str()
                    .unwrap()
                    .into();
            }
            let argv = json!([
                "python3",
                "-u",
                "-c",
                "import sys,pathlib\nfor n,line in enumerate(sys.stdin,1):\n print(str(n)+':'+pathlib.Path('app.py').read_text().strip(),flush=True)\n pathlib.Path('control.txt').write_text('guest mutation\\n')"
            ]);
            let write = || json!({"session_id":handle,"data_base64":zero_protocol::interactive::encode_bytes(b"next\n")});
            let read = || json!({"session_id":handle,"after":0,"max_bytes":4096,"wait_ms":1000});
            let text = || {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(outputs.last().unwrap()["bytes_base64"].as_str().unwrap())
                    .unwrap();
                String::from_utf8(bytes).unwrap()
            };
            let output = match turn {
                0 => tool(
                    turn,
                    "workspace_list",
                    json!({"prefix":"","after":"","max_results":100}),
                ),
                1 => tool(
                    turn,
                    "write_file",
                    json!({"path":"app.py","expected_generation":current,"content":"print('middle')\n"}),
                ),
                2 => {
                    old_generation = current.clone();
                    tool(
                        turn,
                        "interactive_create",
                        json!({"argv":argv,"expected_generation":current}),
                    )
                }
                3 | 5 | 12 => tool(turn, "interactive_write", write()),
                4 | 6 | 13 => {
                    assert_eq!(outputs.last().unwrap()["forwarded_to_launcher"], true);
                    tool(turn, "interactive_read", read())
                }
                7 => {
                    let text = text();
                    assert!(
                        text.contains("1:print('middle')") && text.contains("2:print('middle')"),
                        "{text}"
                    );
                    tool(
                        turn,
                        "write_file",
                        json!({"path":"app.py","expected_generation":current,"content":"print('final')\n"}),
                    )
                }
                8 => tool(turn, "interactive_write", write()),
                9 => {
                    assert!(
                        outputs.last().unwrap()["rejected"]
                            .as_str()
                            .unwrap()
                            .contains("stale")
                    );
                    tool(turn, "interactive_close", json!({"session_id":handle}))
                }
                10 => {
                    assert_eq!(outputs.last().unwrap()["cleanup"]["status"], "confirmed");
                    tool(
                        turn,
                        "interactive_create",
                        json!({"argv":argv,"expected_generation":old_generation}),
                    )
                }
                11 => {
                    assert!(
                        outputs.last().unwrap()["rejected"]
                            .as_str()
                            .unwrap()
                            .contains("stale")
                    );
                    tool(
                        turn,
                        "interactive_create",
                        json!({"argv":argv,"expected_generation":current}),
                    )
                }
                14 => {
                    let text = text();
                    assert!(text.contains("1:print('final')"), "{text}");
                    tool(turn, "interactive_close", json!({"session_id":handle}))
                }
                15 => tool(
                    turn,
                    "workspace_read",
                    json!({"path":"control.txt","offset":0,"max_bytes":4096}),
                ),
                16 => {
                    assert_eq!(outputs.last().unwrap()["text"], "unchanged\n");
                    json!([{"type":"message","content":[{"type":"output_text","text":"unverified sessions complete"}]}])
                }
                _ => unreachable!(),
            };
            let body = complete(output);
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        assert!(generations.windows(2).any(|v| v[0] != v[1]));
        listener
    });
    let providers = dir.path().join("providers.json");
    std::fs::write(&providers,json!({"fixture":{"url":url,"api_key_env":"WORKSPACE_FIXTURE_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":5000,"max_response_bytes":65536}}).to_string()).unwrap();
    let mut create = cli(&dir);
    create.args(["session", "create", "--budget-limit", "1000"]);
    let session = invoke(create)["session"]["id"].as_str().unwrap().to_owned();
    let image = if real {
        std::env::var("ZERO_WORKSPACE_DOCKER_IMAGE").expect("set installed immutable image")
    } else {
        format!("sha256:{}", "a".repeat(64))
    };
    let request = json!({"provider":"fixture","model":"fixture","instructions":"use workspace tools","prompt":"edit and test","max_turns":20,"reservation_per_turn":10,"interactive_policy":{"max_sessions":2,"max_writes":4,"max_input_bytes":4096,"max_read_bytes":4096,"deadline_ms":60000},"workspace_policy":{"paths":[{"path":"app.py","baseline_sha256":app_sha,"executable":false},{"path":"notes.txt","baseline_sha256":null,"executable":false}],"max_edits":8,"max_changed_bytes":65536,"max_test_runs":4,"deadline_ms":60000},"execution":{"execution_id":"workspace-profile","image":image,"snapshot":snapshot,"argv":["true"],"timeout_ms":30000,"memory_mb":128,"cpus":0.5,"max_output_bytes":4096}});
    let request_path = dir.path().join("request.json");
    std::fs::write(&request_path, request.to_string()).unwrap();
    let run = || {
        let mut c = cli(&dir);
        c.arg("--providers").arg(&providers);
        if !real {
            c.arg("--docker-bin").arg(&fake);
        }
        c.args([
            "agent",
            "--session",
            &session,
            "--command-id",
            "workspace-fixture",
            "--request",
        ])
        .arg(&request_path);
        c
    };
    let reply = invoke(run());
    assert_eq!(reply["result"]["status"], "completed");
    assert_eq!(reply["result"]["tool_calls"], 16);
    let operation = reply["operation"]["id"].as_str().unwrap();
    let listener = server.join().unwrap();
    assert_eq!(
        std::fs::read_to_string(source.join("app.py")).unwrap(),
        "print('old')\n"
    );
    assert!(!source.join("notes.txt").exists());
    std::fs::remove_dir_all(&source).unwrap();
    assert_eq!(invoke(run())["duplicate"], true);
    assert!(matches!(listener.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock));
    std::fs::remove_file(&providers).unwrap();
    let output = if real {
        std::env::var_os("ZERO_WORKSPACE_INTERACTIVE_EXPORT_PROOF")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| dir.path().join("export"))
    } else {
        dir.path().join("export")
    };
    let mut export = cli(&dir);
    export
        .args([
            "workspace-export",
            "--session",
            &session,
            "--operation",
            operation,
            "--output-dir",
        ])
        .arg(&output);
    assert_eq!(invoke(export)["host_apply"], "not_performed");
    assert_eq!(
        std::fs::read_to_string(output.join("source/app.py")).unwrap(),
        "print('final')\n"
    );
    assert_eq!(
        std::fs::read_to_string(output.join("source/control.txt")).unwrap(),
        "unchanged\n"
    );
    let bundle: Value =
        serde_json::from_slice(&std::fs::read(output.join("bundle.json")).unwrap()).unwrap();
    assert_eq!(bundle["assessment"], "unverified");
    assert_eq!(bundle["changes"].as_array().unwrap().len(), 1);
    assert_eq!(bundle["tests"].as_array().unwrap().len(), 2);
    assert!(bundle["tests"].as_array().unwrap().iter().all(
        |v| v["assessment"] == "unverified" && v["result"]["cleanup"]["status"] == "confirmed"
    ));
    for session in bundle["tests"].as_array().unwrap() {
        assert!(
            !std::path::Path::new(session["request"]["snapshot"]["root"].as_str().unwrap())
                .exists(),
            "actor must join and remove retained session stage"
        );
        assert_eq!(session["kind"], "workspace_interactive");
    }
    let mut duplicate = cli(&dir);
    duplicate
        .args([
            "workspace-export",
            "--session",
            &session,
            "--operation",
            operation,
            "--output-dir",
        ])
        .arg(&output);
    assert!(!duplicate.output().unwrap().status.success());
    assert_eq!(
        std::fs::read_to_string(output.join("source/app.py")).unwrap(),
        "print('final')\n"
    );
}
