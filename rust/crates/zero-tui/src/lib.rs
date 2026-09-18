//! Experimental fullscreen protocol client. It never owns the engine or database.
mod client;
pub mod render;
pub mod state;
use crossterm::{
    event::{DisableBracketedPaste, EnableBracketedPaste, Event, EventStream},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use futures_util::StreamExt;
use ratatui::{Terminal, backend::CrosstermBackend};
use std::{io, time::Duration};
use tokio::io::{AsyncRead, AsyncWrite};
use zero_protocol::agent::AgentRequest;

#[derive(Clone, Default)]
pub struct Options {
    pub session: Option<String>,
    pub profile: Option<AgentRequest>,
    pub budget_limit: u64,
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("terminal or app-server I/O: {0}")]
    Io(#[from] io::Error),
    #[error("invalid app-server JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Protocol(String),
}
pub type Result<T> = std::result::Result<T, Error>;
struct Guard;
impl Guard {
    fn enter() -> Result<Self> {
        let guard = Self;
        enable_raw_mode()?;
        execute!(io::stdout(), EnterAlternateScreen, EnableBracketedPaste)?;
        Ok(guard)
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            io::stdout(),
            DisableBracketedPaste,
            LeaveAlternateScreen,
            crossterm::cursor::Show
        );
    }
}

pub async fn run<R, W>(reader: R, writer: W, options: Options) -> Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let interrupt = tokio::signal::ctrl_c();
    tokio::pin!(interrupt);
    let _guard = Guard::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    terminal.clear()?;
    let mut client = client::Client::new(reader, writer);
    let mut state = state::State::new(options);
    let initial = state.initialize();
    client.send(&initial).await?;
    let mut keys = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut progress_open = true;
    let result:Result<()>=async {
        loop {
            let requests=tokio::select! {
                biased;
                _=&mut interrupt=>break,
                _=async {#[cfg(unix)] {terminate.recv().await;} #[cfg(not(unix))] {std::future::pending::<()>().await;}}=>break,
                key=keys.next()=>match key {Some(Ok(Event::Key(key)))=>state.key(key),Some(Ok(Event::Paste(text)))=>{state.paste(&text);vec![]},Some(Ok(Event::Resize(..)))=>vec![],Some(Ok(_))=>vec![],Some(Err(e))=>return Err(e.into()),None=>break},
                message=client.messages.recv()=>match message {Some(Ok(message))=>state.message(message)?,Some(Err(error))=>return Err(error),None=>return Err(Error::Protocol("app-server reader ended".into()))},
                _=tick.tick()=>{terminal.draw(|frame|render::draw(frame,&state))?;vec![]},
                update=client.progress.recv(), if progress_open=>match update {Some(message)=>state.message(message)?,None=>{progress_open=false;vec![]}},
            };
            for request in requests {client.send(&request).await?;}
            if state.quit {break;}
        }Ok(())
    }.await;
    let closed = client.close().await;
    result.and(closed)
}
