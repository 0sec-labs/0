//! Owned local fixture. No target-accessible oracle/control endpoint or detached tasks.
use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};
pub(super) struct Fixture {
    pub origin: String,
    listener: Option<TcpListener>,
    cancel: CancellationToken,
    task: Option<JoinHandle<Result<(), EngineError>>>,
}
impl Fixture {
    pub async fn bind() -> Result<Self, EngineError> {
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(error)?;
        let origin = format!("http://{}", listener.local_addr().map_err(error)?);
        Ok(Self {
            origin,
            listener: Some(listener),
            cancel: CancellationToken::new(),
            task: None,
        })
    }
    pub fn start(&mut self, scenario: StrategyScenario) -> Result<(), EngineError> {
        let listener = self
            .listener
            .take()
            .ok_or_else(|| error("fixture already started"))?;
        let cancel = self.cancel.clone();
        self.task = Some(tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {biased;_=cancel.cancelled()=>return Ok(()),socket=listener.accept()=>socket.map_err(error)?};
                let result = tokio::select! {biased;_=cancel.cancelled()=>return Ok(()),result=tokio::time::timeout(std::time::Duration::from_secs(3),serve(accepted.0,&scenario))=>result};
                // A timed-out/malformed peer is closed, never a fabricated successful response.
                if let Ok(Err(e)) = result {
                    return Err(e);
                }
            }
        }));
        Ok(())
    }
    pub async fn finish(mut self) -> Result<(), EngineError> {
        self.cancel.cancel();
        self.listener.take();
        if let Some(task) = self.task.take() {
            task.await.map_err(error)??;
        }
        Ok(())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
async fn serve(mut socket: TcpStream, scenario: &StrategyScenario) -> Result<(), EngineError> {
    let mut bytes = Vec::new();
    let (target, method) = loop {
        if bytes.len() > 32768 {
            return Err(error("fixture request exceeds bound"));
        }
        let mut buf = [0; 4096];
        let n = socket.read(&mut buf).await.map_err(error)?;
        if n == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&buf[..n]);
        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            let headers = std::str::from_utf8(&bytes[..end]).map_err(error)?;
            let first = headers
                .lines()
                .next()
                .ok_or_else(|| error("fixture request line absent"))?;
            let mut fields = first.split(' ');
            let method = fields.next().unwrap_or("");
            let target = fields.next().unwrap_or("");
            let mut length = None;
            for line in headers.lines().skip(1) {
                if let Some((key, value)) = line.split_once(':') {
                    if key.eq_ignore_ascii_case("content-length") {
                        if length.is_some() {
                            return Err(error("duplicate fixture content length"));
                        }
                        length = Some(value.trim().parse::<usize>().map_err(error)?);
                    }
                }
            }
            let length = length.unwrap_or(0);
            if length > 16384 {
                return Err(error("fixture body exceeds bound"));
            }
            if bytes.len() >= end + 4 + length {
                break (target.to_owned(), method.to_owned());
            }
        }
    };
    let (status, body) = if matches!(method.as_str(), "GET" | "POST") {
        oracle::response(scenario, &target)
    } else {
        (405, b"fixture method not allowed".to_vec())
    };
    let head = format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n",
        body.len()
    );
    socket.write_all(head.as_bytes()).await.map_err(error)?;
    socket.write_all(&body).await.map_err(error)?;
    socket.shutdown().await.map_err(error)?;
    Ok(())
}
