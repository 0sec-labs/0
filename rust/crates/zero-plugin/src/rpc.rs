use crate::{Error, identifier};
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub const MAX_FRAME_BYTES: usize = 1_048_576;
pub const MAX_RESULT_BYTES: usize = 100_000;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Call {
    pub tool: String,
    pub input: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}
/// No host callbacks, approval flags or authority fields exist on this wire.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Request { id: u64, call: Call },
    Result { id: u64, result: Value },
    Error { id: u64, error: RpcError },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    jsonrpc: String,
    id: u64,
    method: String,
    params: Call,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResultFrame {
    jsonrpc: String,
    id: u64,
    result: Value,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorFrame {
    jsonrpc: String,
    id: u64,
    error: RpcError,
}
impl Frame {
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        let value = match self {
            Self::Request { id, call } => serde_json::to_value(Request {
                jsonrpc: "2.0".into(),
                id: *id,
                method: "tool.invoke".into(),
                params: call.clone(),
            }),
            Self::Result { id, result } => serde_json::to_value(ResultFrame {
                jsonrpc: "2.0".into(),
                id: *id,
                result: result.clone(),
            }),
            Self::Error { id, error } => serde_json::to_value(ErrorFrame {
                jsonrpc: "2.0".into(),
                id: *id,
                error: error.clone(),
            }),
        }
        .map_err(|_| Error::Invalid("RPC"))?;
        let mut bytes = serde_json::to_vec(&value).map_err(|_| Error::Invalid("RPC"))?;
        decode(&bytes)?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}
fn decode(bytes: &[u8]) -> Result<Frame, Error> {
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(Error::Limit);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| Error::Invalid("RPC JSON"))?;
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(Error::Invalid("RPC version"));
    }
    if value.get("method").is_some() {
        let r: Request =
            serde_json::from_slice(bytes).map_err(|_| Error::Invalid("RPC request"))?;
        if r.method != "tool.invoke"
            || !identifier(&r.params.tool, 48, b"_")
            || !r.params.input.is_object()
        {
            return Err(Error::Invalid("RPC method or arguments"));
        }
        if serde_json::to_vec(&r.params.input)
            .map_err(|_| Error::Invalid("RPC input"))?
            .len()
            > crate::schema::MAX_ARGUMENT_BYTES
        {
            return Err(Error::Limit);
        }
        Ok(Frame::Request {
            id: r.id,
            call: r.params,
        })
    } else if value.get("result").is_some() {
        let r: ResultFrame =
            serde_json::from_slice(bytes).map_err(|_| Error::Invalid("RPC result"))?;
        if serde_json::to_vec(&r.result)
            .map_err(|_| Error::Invalid("RPC result"))?
            .len()
            > MAX_RESULT_BYTES
        {
            return Err(Error::Limit);
        }
        Ok(Frame::Result {
            id: r.id,
            result: r.result,
        })
    } else {
        let r: ErrorFrame =
            serde_json::from_slice(bytes).map_err(|_| Error::Invalid("RPC error"))?;
        if r.error.message.len() > 4096 {
            return Err(Error::Limit);
        }
        Ok(Frame::Error {
            id: r.id,
            error: r.error,
        })
    }
}
/// Byte-bounded newline framing; malformed input poisons the decoder permanently.
/// Transport must separately constrain number/rate of frames and correlate IDs.
#[derive(Default)]
pub struct Decoder {
    pending: Vec<u8>,
    poisoned: bool,
}
impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }
    /// Callback avoids accumulating an unbounded Vec when one read has many frames.
    /// Valid earlier frames may have been delivered before a later frame fails.
    pub fn feed(&mut self, bytes: &[u8], mut receive: impl FnMut(Frame)) -> Result<(), Error> {
        if self.poisoned {
            return Err(Error::Framing);
        }
        for byte in bytes {
            if *byte == b'\n' {
                let result = decode(&self.pending);
                self.pending.clear();
                match result {
                    Ok(frame) => receive(frame),
                    Err(e) => {
                        self.poisoned = true;
                        return Err(e);
                    }
                }
            } else {
                if self.pending.len() >= MAX_FRAME_BYTES {
                    self.pending.clear();
                    self.poisoned = true;
                    return Err(Error::Limit);
                }
                self.pending.push(*byte);
            }
        }
        Ok(())
    }
    pub fn finish(&mut self) -> Result<(), Error> {
        if self.poisoned || !self.pending.is_empty() {
            self.pending.clear();
            self.poisoned = true;
            Err(Error::Framing)
        } else {
            Ok(())
        }
    }
}
