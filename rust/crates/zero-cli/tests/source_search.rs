#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    time::{Duration, Instant},
};

#[test]
fn regex_source_tools_keep_citations_and_retry_without_source_or_http() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("source");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("app.rs"), "let Token = 42;\r\nlet token = 7;\n").unwrap();
    let snapshot = zero_executor::pin_snapshot(&root).unwrap();
    let digest = snapshot.files[0].digest.clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/responses", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        for turn in 0..2 {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "missing provider request {turn}");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let request: Value = loop {
                let mut chunk = [0; 4096];
                let n = stream.read(&mut chunk).unwrap();
                assert_ne!(n, 0);
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let size: usize = headers
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + size {
                        break serde_json::from_slice(&bytes[end + 4..end + 4 + size]).unwrap();
                    }
                }
                assert!(bytes.len() < 1024 * 1024);
            };
            let output = if turn == 0 {
                let tool = request["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|t| t["name"] == "search_source_text")
                    .unwrap();
                assert!(tool["parameters"]["properties"]["mode"].is_object());
                json!([{"type":"function_call","id":"fc-search","call_id":"search","name":"search_source_text","arguments":json!({"query":"^let token = [0-9]+;$","mode":"regex","case_sensitive":false,"prefix":"app.rs","max_results":10}).to_string()}])
            } else {
                let item = request["input"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|v| v["type"] == "function_call_output" && v["call_id"] == "search")
                    .unwrap();
                let result: Value = serde_json::from_str(item["output"].as_str().unwrap()).unwrap();
                assert_eq!(result["truncated"], false);
                assert_eq!(result["matches"].as_array().unwrap().len(), 2);
                for (index, text) in ["let Token = 42;\r\n", "let token = 7;\n"]
                    .iter()
                    .enumerate()
                {
                    let hit = &result["matches"][index];
                    assert_eq!(hit["text"], *text);
                    assert_eq!(hit["citation"]["path"], "app.rs");
                    assert_eq!(hit["citation"]["sha256"], digest);
                    assert_eq!(hit["citation"]["start_line"], index + 1);
                    assert_eq!(hit["citation"]["end_line"], index + 1);
                }
                json!([{"type":"message","content":[{"type":"output_text","text":"Two cited matching lines; no security conclusion."}]}])
            };
            let event = json!({"type":"response.completed","response":{"id":format!("search-{turn}"),"status":"completed","output":output,"usage":{"input_tokens":2,"output_tokens":1}}});
            let body = format!("data: {event}\n\n");
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        listener
    });
    let state = dir.path().join("state.db");
    let cli = || {
        let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        c.arg("--state").arg(&state);
        c
    };
    let profiles = dir.path().join("providers.json");
    std::fs::write(&profiles,json!({"fixture":{"url":url,"api_key_env":"SEARCH_TEST_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":10000,"max_response_bytes":32768}}).to_string()).unwrap();
    let created = cli()
        .args(["session", "create", "--budget-limit", "100"])
        .output()
        .unwrap();
    assert!(created.status.success());
    let created: Value = serde_json::from_slice(&created.stdout).unwrap();
    let session = created["session"]["id"].as_str().unwrap();
    let request = dir.path().join("request.json");
    std::fs::write(&request,json!({"provider":"fixture","model":"fixture","instructions":"Search pinned source","prompt":"Find token assignments","max_turns":2,"reservation_per_turn":10,"source_snapshot_tools":true,"execution":{"execution_id":"source-search","image":"fixture:local","snapshot":snapshot,"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024}}).to_string()).unwrap();
    let mut operation = None;
    for duplicate in [false, true] {
        let mut command = cli();
        command
            .arg("--providers")
            .arg(&profiles)
            .env("SEARCH_TEST_KEY", "fixture-secret");
        let output = command
            .args([
                "agent",
                "--session",
                session,
                "--command-id",
                "search-one",
                "--request",
            ])
            .arg(&request)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(reply["duplicate"], duplicate);
        assert_eq!(reply["operation"]["status"], "succeeded");
        if duplicate {
            assert_eq!(operation.as_ref().unwrap(), &reply["operation"]["id"]);
        } else {
            operation = Some(reply["operation"]["id"].clone());
            std::fs::remove_dir_all(&root).unwrap();
        }
    }
    let listener = server.join().unwrap();
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}
