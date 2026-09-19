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
fn physical_cli_iterates_private_edits_tests_and_exports_offline() {
    exercise(false);
}
#[test]
#[ignore = "requires installed immutable Docker image; no pulls or paid models"]
fn actual_docker_private_edit_test_export() {
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
    let script=include_str!("../../zero-executor/tests/fixtures/fake-docker.py").replace("state.write_text(json.dumps({\"name\": name, \"id\": container_id}))","state.write_text(json.dumps({\"name\": name, \"id\": container_id, \"args\": args}))").replace("elif args[0] == \"start\":","elif args[0] == \"start\":\n    import shlex\n    saved = json.loads(state.read_text())[\"args\"]\n    mount = saved[saved.index(\"--mount\") + 1]\n    source = mount.split(\"src=\",1)[1].split(\",\",1)[0]\n    command = shlex.split(saved[-1].splitlines()[-1])[1:]\n    result = subprocess.run(command, cwd=source)\n    sys.exit(result.returncode)");
    std::fs::write(&fake, script).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(dir.path().join("scenario.txt"), "workspace").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let mut generations = vec![];
        for turn in 0..11 {
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
            let argv = json!(["python3", "app.py"]);
            let output = match turn {
                0 => tool(
                    turn,
                    "workspace_list",
                    json!({"prefix":"","after":"","max_results":100}),
                ),
                1 => tool(
                    turn,
                    "workspace_read",
                    json!({"path":"app.py","offset":0,"max_bytes":4096}),
                ),
                2 => tool(
                    turn,
                    "workspace_search",
                    json!({"query":"old","prefix":"","max_results":10}),
                ),
                3 => tool(
                    turn,
                    "execute_workspace",
                    json!({"expected_generation":generation,"argv":argv}),
                ),
                4 => {
                    assert_eq!(outputs.last().unwrap()["stdout_text"], "old\n");
                    tool(
                        turn,
                        "write_file",
                        json!({"path":"notes.txt","expected_generation":generation,"content":"note\n"}),
                    )
                }
                5 => tool(
                    turn,
                    "str_replace",
                    json!({"path":"app.py","expected_generation":generation,"old_string":"'old'","new_string":"'middle'","replace_all":false}),
                ),
                6 => tool(
                    turn,
                    "execute_workspace",
                    json!({"expected_generation":generation,"argv":argv}),
                ),
                7 => {
                    assert_eq!(outputs.last().unwrap()["stdout_text"], "middle\n");
                    tool(
                        turn,
                        "apply_patch",
                        json!({"expected_generation":generation,"patch":"*** Begin Patch\n*** Update File: app.py\n@@ print\n-print('middle')\n+print('final')\n*** Replace File: notes.txt\n+final note\n*** End Patch\n"}),
                    )
                }
                8 => tool(
                    turn,
                    "execute_workspace",
                    json!({"expected_generation":generation,"argv":argv}),
                ),
                9 => {
                    assert_eq!(outputs.last().unwrap()["stdout_text"], "final\n");
                    tool(
                        turn,
                        "workspace_read",
                        json!({"path":"app.py","offset":0,"max_bytes":4096}),
                    )
                }
                10 => {
                    assert_eq!(outputs.last().unwrap()["text"], "print('final')\n");
                    json!([{"type":"message","content":[{"type":"output_text","text":"candidate prepared, unverified"}]}])
                }
                _ => unreachable!(),
            };
            let body = complete(output);
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        assert!(generations.windows(2).filter(|v| v[0] != v[1]).count() >= 3);
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
    let request = json!({"provider":"fixture","model":"fixture","instructions":"use workspace tools","prompt":"edit and test","max_turns":12,"reservation_per_turn":10,"workspace_policy":{"paths":[{"path":"app.py","baseline_sha256":app_sha,"executable":false},{"path":"notes.txt","baseline_sha256":null,"executable":false}],"max_edits":8,"max_changed_bytes":65536,"max_test_runs":4,"deadline_ms":60000},"execution":{"execution_id":"workspace-profile","image":image,"snapshot":snapshot,"argv":["true"],"timeout_ms":5000,"memory_mb":128,"cpus":0.5,"max_output_bytes":4096}});
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
    assert_eq!(reply["result"]["tool_calls"], 10);
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
        std::env::var_os("ZERO_WORKSPACE_EXPORT_PROOF")
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
    assert_eq!(bundle["changes"].as_array().unwrap().len(), 2);
    assert_eq!(bundle["tests"].as_array().unwrap().len(), 3);
    assert!(bundle["tests"].as_array().unwrap().iter().all(
        |v| v["assessment"] == "unverified" && v["outcome"]["cleanup"]["status"] == "confirmed"
    ));
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
