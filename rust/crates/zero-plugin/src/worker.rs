//! Explicit persistent-worker wire. Data on this wire never grants authority.
//! The host maps capability operation names to captured grants and handlers.
use crate::{Call, Error, MAX_FRAME_BYTES, MAX_RESULT_BYTES, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkerFrame {
    Ready {
        version: u32,
    },
    Invoke {
        id: u64,
        call: Call,
    },
    Result {
        id: u64,
        result: Value,
    },
    Error {
        id: u64,
        error: RpcError,
    },
    CapabilityRequest {
        call_id: u64,
        id: u64,
        operation: String,
        input: Value,
    },
    CapabilityResult {
        call_id: u64,
        id: u64,
        result: Value,
    },
    CapabilityError {
        call_id: u64,
        id: u64,
        error: RpcError,
    },
    Shutdown,
}
impl WorkerFrame {
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        self.validate()?;
        let mut bytes = bounded_json(self, MAX_FRAME_BYTES)?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(Error::Limit);
        }
        bytes.push(b'\n');
        Ok(bytes)
    }
    fn validate(&self) -> Result<(), Error> {
        fn id(v: u64) -> Result<(), Error> {
            if v == 0 || v > 9_007_199_254_740_991 {
                Err(Error::Invalid("worker ID"))
            } else {
                Ok(())
            }
        }
        fn value(v: &Value, max: usize) -> Result<(), Error> {
            bounded_json(v, max).map(|_| ())
        }
        match self {
            Self::Ready { version: 1 } | Self::Shutdown => Ok(()),
            Self::Ready { .. } => Err(Error::Invalid("worker version")),
            Self::Invoke { id: n, call } => {
                id(*n)?;
                if !crate::identifier(&call.tool, 48, b"_") || !call.input.is_object() {
                    return Err(Error::Invalid("worker call"));
                }
                value(&call.input, crate::schema::MAX_ARGUMENT_BYTES)
            }
            Self::CapabilityRequest {
                call_id,
                id: n,
                operation,
                input,
            } => {
                id(*call_id)?;
                id(*n)?;
                if !crate::identifier(operation, 64, b"._-") || !input.is_object() {
                    return Err(Error::Invalid("capability request"));
                }
                value(input, crate::schema::MAX_ARGUMENT_BYTES)
            }
            Self::Result { id: n, result } => {
                id(*n)?;
                value(result, MAX_RESULT_BYTES)
            }
            Self::CapabilityResult {
                call_id,
                id: n,
                result,
            } => {
                id(*call_id)?;
                id(*n)?;
                value(result, MAX_RESULT_BYTES)
            }
            Self::Error { id: n, error } => {
                id(*n)?;
                if error.message.len() > 4096 {
                    Err(Error::Limit)
                } else {
                    Ok(())
                }
            }
            Self::CapabilityError {
                call_id,
                id: n,
                error,
            } => {
                id(*call_id)?;
                id(*n)?;
                if error.message.len() > 4096 {
                    Err(Error::Limit)
                } else {
                    Ok(())
                }
            }
        }
    }
}
/// A single bounded frame at a time; malformed/truncated input poisons the
/// decoder. Callback consumers must independently cap total frames and queues.
#[derive(Default)]
pub struct WorkerDecoder {
    pending: Vec<u8>,
    poisoned: bool,
}
impl WorkerDecoder {
    pub fn feed(
        &mut self,
        bytes: &[u8],
        mut receive: impl FnMut(WorkerFrame),
    ) -> Result<(), Error> {
        if self.poisoned {
            return Err(Error::Framing);
        }
        for byte in bytes {
            if *byte == b'\n' {
                let frame = serde_json::from_slice::<WorkerFrame>(&self.pending)
                    .map_err(|_| Error::Invalid("worker JSON"))
                    .and_then(|v| {
                        v.validate()?;
                        Ok(v)
                    });
                self.pending.clear();
                match frame {
                    Ok(v) => receive(v),
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

fn bounded_json(value: &impl Serialize, limit: usize) -> Result<Vec<u8>, Error> {
    struct Writer {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl std::io::Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
                return Err(std::io::Error::other("worker wire size exceeded"));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Writer {
        bytes: Vec::new(),
        limit,
    };
    serde_json::to_writer(&mut writer, value).map_err(|_| Error::Limit)?;
    Ok(writer.bytes)
}
