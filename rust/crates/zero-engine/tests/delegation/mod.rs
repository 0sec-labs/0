#![allow(dead_code)]
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinHandle,
};
use zero_engine::Engine;
use zero_protocol::{Command, ExecutionEvent, Reply, agent::AgentRequest, model::Rates};
use zero_provider::{Endpoint, ProviderClient};

pub struct Http {
    pub url: String,
    receiver: mpsc::Receiver<Incoming>,
    pub requests: Arc<Mutex<Vec<Value>>>,
    task: JoinHandle<()>,
}
pub struct Incoming {
    pub body: Value,
    socket: TcpStream,
    started: bool,
}
impl Drop for Http {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Http {
    pub async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/responses", listener.local_addr().unwrap());
        let (sender, receiver) = mpsc::channel(32);
        let requests = Arc::new(Mutex::new(vec![]));
        let captured = requests.clone();
        let task = tokio::spawn(async move {
            let mut readers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    value=listener.accept()=>{
                        let (mut socket,_)=value.unwrap(); let sender=sender.clone(); let captured=captured.clone();
                        readers.spawn(async move {
                            let body=read_request(&mut socket).await;
                            captured.lock().unwrap().push(body.clone());
                            let _=sender.send(Incoming {body,socket,started:false}).await;
                        });
                    },
                    result=readers.join_next(), if !readers.is_empty()=>{result.unwrap().unwrap();}
                }
            }
        });
        Self {
            url,
            receiver,
            requests,
            task,
        }
    }
    pub fn configure(&self, engine: &Engine) {
        self.configure_rates(engine, 1_000_000);
    }
    pub fn configure_rates(&self, engine: &Engine, input: u64) {
        self.configure_named(engine, "fixture", input);
    }
    pub fn configure_named(&self, engine: &Engine, name: &str, input: u64) {
        engine
            .configure_provider(
                name,
                ProviderClient::new(
                    Endpoint::responses(&self.url, None).unwrap(),
                    Duration::from_secs(10),
                    262144,
                )
                .unwrap(),
                Rates {
                    input,
                    cached_input: input,
                    output: 1_000_000,
                },
            )
            .unwrap();
    }
    pub async fn next(&mut self) -> Incoming {
        tokio::time::timeout(Duration::from_secs(8), self.receiver.recv())
            .await
            .expect("provider request deadline")
            .expect("HTTP fixture ended")
    }
    pub async fn quiet(&mut self) {
        assert!(
            tokio::time::timeout(Duration::from_millis(80), self.receiver.recv())
                .await
                .is_err(),
            "unexpected provider dispatch"
        );
    }
    pub fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}
async fn read_request(socket: &mut TcpStream) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut data = vec![];
        loop {
            let mut bytes = [0u8; 4096];
            let n = socket.read(&mut bytes).await.unwrap();
            assert!(n > 0);
            data.extend_from_slice(&bytes[..n]);
            assert!(data.len() < 2 * 1024 * 1024);
            if let Some(end) = data.windows(4).position(|b| b == b"\r\n\r\n") {
                let length: usize = String::from_utf8_lossy(&data[..end])
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                if data.len() >= end + 4 + length {
                    return serde_json::from_slice(&data[end + 4..end + 4 + length]).unwrap();
                }
            }
        }
    })
    .await
    .unwrap()
}
impl Incoming {
    pub fn prompt(&self) -> String {
        self.body["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["role"] == "user")
            .filter_map(|v| v["content"].as_str())
            .next_back()
            .unwrap_or("")
            .to_owned()
    }
    async fn begin(&mut self) {
        if !self.started {
            self.socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
            self.started = true;
        }
    }
    pub async fn progress(&mut self, text: &str) {
        self.begin().await;
        self.socket.write_all(format!("data: {}\n\n",json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":text})).as_bytes()).await.unwrap();
    }
    pub async fn finish(mut self, items: Value) {
        self.begin().await;
        self.socket.write_all(format!("data: {}\n\n",json!({"type":"response.completed","response":{"id":"fixture","status":"completed","output":items,"usage":{"input_tokens":1,"output_tokens":1}}})).as_bytes()).await.unwrap();
        self.socket.shutdown().await.unwrap();
    }
    pub async fn answer(self, text: &str) {
        self.finish(json!([{"type":"message","content":[{"type":"output_text","text":text}]}]))
            .await;
    }
    pub async fn truncated(mut self) {
        self.progress("partial").await;
        self.socket.shutdown().await.unwrap();
    }
}
pub fn tool(id: &str, name: &str, args: Value) -> Value {
    json!({"type":"function_call","call_id":id,"name":name,"arguments":args.to_string()})
}
pub fn delegation(tasks: Vec<(&str, &str)>) -> Value {
    tool(
        "batch",
        "delegate_tasks",
        json!({"tasks":tasks.into_iter().map(|(role,prompt)|json!({"role":role,"prompt":prompt})).collect::<Vec<_>>()}),
    )
}
pub struct Setup {
    pub dir: tempfile::TempDir,
    pub request: AgentRequest,
}
impl Setup {
    pub fn new(tools: Vec<&str>, max_children: u32, max_parallel: u32) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("file.txt"), "pinned fixture\n").unwrap();
        let docker = dir.path().join("docker");
        fs::write(&docker, include_str!("fake-docker.py")).unwrap();
        fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(dir.path().join("scenario"), "echo").unwrap();
        let request=serde_json::from_value(json!({"provider":"fixture","model":"parent","instructions":"host instructions","prompt":"parent prompt","max_turns":3,"reservation_per_turn":5,
            "execution":{"execution_id":"profile","image":"local:fixture","snapshot":zero_executor::pin_snapshot(&source).unwrap(),"argv":["unused"],"timeout_ms":5000,"memory_mb":128,"cpus":0.5,"max_output_bytes":2048},
            "delegation_policy":{"max_parallel":max_parallel,"max_children":max_children,"roles":[{"name":"investigator","provider":"fixture","model":"child","instructions":"fixed child instructions","description":"Investigate bounded tasks","tools":tools,"max_turns":3,"reservation_per_turn":5}]}
        })).unwrap();
        Self { dir, request }
    }
    pub fn engine(&self) -> Arc<Engine> {
        Arc::new(
            Engine::open(
                self.dir.path().join("state.db"),
                Some(self.dir.path().join("docker")),
            )
            .unwrap(),
        )
    }
    pub fn command(&self, session: &str) -> Command {
        Command::RunAgent {
            session_id: session.into(),
            command_id: "parent-command".into(),
            request: self.request.clone(),
        }
    }
    pub fn calls(&self) -> Vec<Value> {
        fs::read_to_string(self.dir.path().join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
    pub async fn markers(&self, prefix: &str, count: usize) -> Vec<String> {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let names: Vec<_> = fs::read_dir(self.dir.path())
                    .unwrap()
                    .map(|v| v.unwrap().file_name().to_string_lossy().to_string())
                    .filter(|s| s.starts_with(prefix))
                    .collect();
                if names.len() >= count {
                    return names;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("lifecycle marker deadline")
    }
    pub fn release_cleanup(&self, id: &str) {
        fs::write(
            self.dir.path().join(format!("cleanup-release-{id}")),
            "release",
        )
        .unwrap();
    }
}
pub async fn call(engine: &Engine, command: Command) -> Reply {
    let (tx, _rx) = mpsc::channel(512);
    tokio::time::timeout(Duration::from_secs(15), engine.handle(command, tx))
        .await
        .unwrap()
}
pub async fn session(engine: &Engine, limit: u64) -> String {
    match call(
        engine,
        Command::SessionCreate {
            generation: "fixture".into(),
            budget_limit: limit,
        },
    )
    .await
    {
        Reply::Session { session } => session.id,
        r => panic!("{r:?}"),
    }
}
pub async fn budget(engine: &Engine, session: &str) -> zero_protocol::BudgetSnapshot {
    match call(
        engine,
        Command::SessionBudget {
            session_id: session.into(),
        },
    )
    .await
    {
        Reply::SessionBudget { budget } => budget,
        r => panic!("{r:?}"),
    }
}
pub struct Running {
    pub result: JoinHandle<Reply>,
    pub progress: mpsc::Receiver<ExecutionEvent>,
    _events: mpsc::Receiver<ExecutionEvent>,
}
impl Running {
    pub fn close_operational_observer(&mut self) {
        self._events.close();
    }
}
pub fn start(engine: Arc<Engine>, command: Command) -> Running {
    let (events, rx) = mpsc::channel(512);
    let (progress, prx) = mpsc::channel(512);
    Running {
        result: tokio::spawn(async move {
            engine.handle_with_progress(command, events, progress).await
        }),
        progress: prx,
        _events: rx,
    }
}
pub async fn joined(running: Running) -> Reply {
    tokio::time::timeout(Duration::from_secs(12), running.result)
        .await
        .expect("join deadline")
        .unwrap()
}
pub fn agent(
    reply: Reply,
) -> (
    zero_protocol::Operation,
    zero_protocol::agent::AgentResult,
    bool,
) {
    match reply {
        Reply::Agent {
            operation,
            result: Some(result),
            duplicate,
        } => (operation, result, duplicate),
        other => panic!("{other:?}"),
    }
}
pub fn outputs(body: &Value) -> Vec<Value> {
    body["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["type"] == "function_call_output")
        .map(|v| {
            serde_json::from_str(v["output"].as_str().unwrap())
                .unwrap_or_else(|_| v["output"].clone())
        })
        .collect()
}
