use super::*;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

// This Python source is retained as the actual plugin artifact. The deterministic
// launcher executes it as a transport fixture; this test does not qualify Docker
// isolation, which has a separate opt-in runner test using a real installed image.
const WORKER: &str = r#"import json,sys,os
print(json.dumps({'type':'ready','version':1}),flush=True)
count=0
for line in sys.stdin:
    frame=json.loads(line)
    if frame['type']=='shutdown': break
    assert frame['type']=='invoke'
    count+=1
    print(json.dumps({'type':'result','id':frame['id'],'result':{'count':count,'pid':os.getpid()}}),flush=True)
"#;
fn policy() -> Value {
    json!({"schema_version":1,"operations":[],"max_calls":4,"max_callbacks":8})
}
fn configured(f: &Fixture) -> Value {
    let mut config: Value = serde_json::from_slice(&std::fs::read(&f.config).unwrap()).unwrap();
    config["workers"] = json!({"fixture":policy()});
    config["launch"]["backend"]["image"] = json!(format!("sha256:{}", "a".repeat(64)));
    config["launch"]["interpreter"] = json!(["python3"]);
    config["launch"]["timeout_ms"] = json!(15_000);
    config
}
fn write(f: &Fixture, config: &Value) {
    std::fs::write(&f.config, serde_json::to_vec(config).unwrap()).unwrap();
}
#[test]
fn worker_configuration_rejects_widening_and_unsupported_launch_before_dispatch() {
    for failure in [
        "unknown",
        "disabled",
        "capability",
        "version",
        "calls",
        "callbacks",
        "duplicate",
        "extra",
        "mutable",
        "smolvm",
        "count",
        "null",
    ] {
        let f = Fixture::new("");
        let mut config = configured(&f);
        match failure {
            "unknown" => config["workers"] = json!({"missing":policy()}),
            "disabled" => config["plugins"]["fixture"]["enabled"] = json!(false),
            "capability" => config["workers"]["fixture"]["operations"] = json!(["http_request"]),
            "version" => config["workers"]["fixture"]["schema_version"] = json!(2),
            "calls" => config["workers"]["fixture"]["max_calls"] = json!(33),
            "callbacks" => config["workers"]["fixture"]["max_callbacks"] = json!(0),
            "duplicate" => {
                config["workers"]["fixture"]["operations"] =
                    json!(["read_source_lines", "read_source_lines"])
            }
            "extra" => config["workers"]["fixture"]["allow_host_exec"] = json!(true),
            "mutable" => config["launch"]["backend"]["image"] = json!("python:latest"),
            "smolvm" => {
                config["launch"]["backend"] = json!({"type":"smolvm","image_archive":"/missing.tar","archive_digest":format!("sha256:{}","a".repeat(64)),"storage_gb":1})
            }
            "count" => {
                config["workers"] =
                    json!({"a":policy(),"b":policy(),"c":policy(),"d":policy(),"e":policy()})
            }
            "null" => config["workers"] = Value::Null,
            _ => unreachable!(),
        }
        write(&f, &config);
        let output = f.cli().args(["session", "create-pinned"]).output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(2),
            "{failure}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!f.dir.path().join("calls.jsonl").exists(), "{failure}");
        let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
        assert!(store.list_sessions().unwrap().is_empty(), "{failure}");
    }
}
#[test]
fn empty_worker_map_preserves_mutable_one_shot_launch() {
    let f = Fixture::new("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"legacy\":true}}\n");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&f.config).unwrap()).unwrap();
    config["workers"] = json!({});
    write(&f, &config);
    let session = f.session(true);
    let reply = f.call(&session);
    assert!(
        reply.status.success(),
        "{}",
        String::from_utf8_lossy(&reply.stderr)
    );
    let value: Value = serde_json::from_slice(&reply.stdout).unwrap();
    assert_eq!(value["result"]["untrusted_reply"]["type"], "result");
    let call: Value =
        serde_json::from_slice(&std::fs::read(f.dir.path().join("request.json")).unwrap()).unwrap();
    assert_eq!(call["jsonrpc"], "2.0");
    assert!(call.get("type").is_none());
}
async fn request(stream: &mut tokio::net::TcpStream) -> Value {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 8192];
        let n = stream.read(&mut chunk).await.unwrap();
        assert_ne!(n, 0);
        bytes.extend_from_slice(&chunk[..n]);
        assert!(bytes.len() <= 256 * 1024);
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..end]);
            let size: usize = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            if bytes.len() >= end + 4 + size {
                return serde_json::from_slice(&bytes[end + 4..end + 4 + size]).unwrap();
            }
        }
    }
}
#[tokio::test]
async fn explicit_cli_policy_runs_one_python_worker_for_two_actor_calls_and_retries_offline() {
    let f = Fixture::with_script("", WORKER.as_bytes());
    write(&f, &configured(&f));
    std::fs::write(f.dir.path().join("worker.py"), WORKER).unwrap();
    let fake = include_str!("../../../zero-executor/tests/fixtures/fake-docker.py").replace(
        "sys.stdout.buffer.write(sys.stdin.buffer.read())",
        "exec((root / 'worker.py').read_text())",
    );
    std::fs::write(&f.docker, fake).unwrap();
    let session = f.session(true);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let profiles = f.dir.path().join("providers.json");
    std::fs::write(&profiles,json!({"fixture":{"url":format!("http://{}/responses",listener.local_addr().unwrap()),"api_key_env":"WORKER_CLI_FIXTURE_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":15000,"max_response_bytes":8192}}).to_string()).unwrap();
    let server = tokio::spawn(async move {
        let mut worker_pid = Value::Null;
        for turn in 0..3 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let body = request(&mut stream).await;
            assert!(
                body["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["name"] == "inspect_plugin")
            );
            if turn > 0 {
                let output = body["input"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .rev()
                    .find(|v| v["type"] == "function_call_output")
                    .unwrap();
                let reply: Value =
                    serde_json::from_str(output["output"].as_str().unwrap()).unwrap();
                assert_eq!(reply["provisional"], true);
                let value = &reply["untrusted_plugin_data"]["value"];
                assert_eq!(value["count"], turn);
                if turn == 1 {
                    worker_pid = value["pid"].clone();
                } else {
                    assert_eq!(value["pid"], worker_pid);
                }
            }
            let output = if turn < 2 {
                json!([{"type":"function_call","call_id":format!("call-{turn}"),"name":"inspect_plugin","arguments":"{}"}])
            } else {
                json!([{"type":"message","content":[{"type":"output_text","text":"Untrusted plugin observations only"}]}])
            };
            let event = json!({"type":"response.completed","response":{"id":format!("model-{turn}"),"status":"completed","output":output,"usage":{"input_tokens":2,"output_tokens":1}}});
            let body = format!("data: {event}\n\n");
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    let source = f.dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("input.txt"), b"bounded fixture source").unwrap();
    let snapshot = zero_executor::pin_snapshot(&source).unwrap();
    let request_path = f.dir.path().join("agent.json");
    std::fs::write(&request_path,json!({"provider":"fixture","model":"fixture","instructions":"Use only authorized plugin tools","prompt":"Invoke twice","max_turns":3,"reservation_per_turn":10,"execution":{"execution_id":"unused-native-tool","image":format!("sha256:{}","a".repeat(64)),"snapshot":snapshot,"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024},"plugin_tools":[{"alias":"inspect_plugin","plugin":"fixture","tool":"inspect"}]}).to_string()).unwrap();
    let command = || {
        let mut command = tokio::process::Command::from(f.cli());
        command
            .arg("--providers")
            .arg(&profiles)
            .args([
                "agent",
                "--session",
                &session,
                "--command-id",
                "worker-actor",
                "--request",
            ])
            .arg(&request_path)
            .env("WORKER_CLI_FIXTURE_KEY", "local-fixture-only")
            .kill_on_drop(true);
        command
    };
    let output = tokio::time::timeout(Duration::from_secs(30), command().output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
    let first: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(first["result"]["status"], "completed");
    assert_eq!(first["result"]["tool_calls"], 2);
    assert_eq!(
        first["operation"]["payload"]["plugin_context"]["workers"]["fixture"],
        policy()
    );
    let budget = zero_store::Store::open_read_only(f.dir.path().join("state.db"))
        .unwrap()
        .budget(&session)
        .unwrap();
    assert_eq!(budget.charged, 9);
    assert_eq!(budget.reserved, 0);
    let calls = std::fs::read(f.dir.path().join("calls.jsonl")).unwrap();
    let records: Vec<Value> = String::from_utf8_lossy(&calls)
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(records.iter().filter(|v| v[0] == "create").count(), 1);
    assert_eq!(records.iter().filter(|v| v[0] == "start").count(), 1);
    std::fs::remove_file(&f.docker).unwrap();
    std::fs::remove_dir_all(&source).unwrap();
    let retry = tokio::time::timeout(Duration::from_secs(10), command().output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        retry.status.success(),
        "{}",
        String::from_utf8_lossy(&retry.stderr)
    );
    let retry: Value = serde_json::from_slice(&retry.stdout).unwrap();
    assert_eq!(retry["duplicate"], true);
    assert_eq!(retry["result"], first["result"]);
    assert_eq!(
        std::fs::read(f.dir.path().join("calls.jsonl")).unwrap(),
        calls
    );
}
