//! Draft versioned values for the native application and its clients.
//! Experimental schema sketch; not a published compatibility contract.
//! These types carry data, never live processes, credentials, or UI handles.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// A caller-selected identifier echoed in a response; not an execution ID.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum RequestId {
    Number(u64),
    Text(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub protocol_version: u32,
    pub id: RequestId,
    pub command: Command,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "method",
    content = "params",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Command {
    Initialize,
    Execute(ExecutionRequest),
    Cancel { execution_id: String },
    Reconcile(ReconcileRequest),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExecutionRequest {
    pub execution_id: String,
    /// Docker must resolve this locally to an immutable image ID; never pull.
    pub image: String,
    pub argv: Vec<String>,
    #[serde(default)]
    pub stdin: Option<String>,
    pub timeout_ms: u64,
    pub memory_mb: u64,
    pub cpus: u16,
    pub max_output_bytes: usize,
}

impl ExecutionRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.execution_id.is_empty()
            || self.execution_id.len() > 128
            || !self
                .execution_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            return Err(ValidationError(
                "execution_id must contain 1..128 ASCII letters, digits, '-', '_' or '.'".into(),
            ));
        }
        if self.image.is_empty()
            || self.image.len() > 512
            || self.image.starts_with('-')
            || self
                .image
                .bytes()
                .any(|b| b.is_ascii_whitespace() || b == 0)
        {
            return Err(ValidationError(
                "image must be a nonempty local Docker image reference".into(),
            ));
        }
        if self.argv.is_empty()
            || self.argv[0].is_empty()
            || self.argv.len() > 1024
            || self
                .argv
                .iter()
                .any(|arg| arg.contains('\0') || arg.len() > 128 * 1024)
        {
            return Err(ValidationError(
                "argv must be nonempty, bounded, and contain no NUL bytes".into(),
            ));
        }
        if !(100..=600_000).contains(&self.timeout_ms)
            || !(32..=16_384).contains(&self.memory_mb)
            || !(1..=16).contains(&self.cpus)
            || !(256..=16 * 1024 * 1024).contains(&self.max_output_bytes)
            || self
                .stdin
                .as_ref()
                .is_some_and(|s| s.len() > MAX_FRAME_BYTES / 2)
        {
            return Err(ValidationError(
                "execution limits are outside the supported range".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutionEvent {
    Started {
        execution_id: String,
        image_id: String,
        container_id: String,
    },
    /// Text is presentation only; chunks must preserve split UTF-8 sequences.
    Output {
        execution_id: String,
        sequence: u64,
        stream: OutputStream,
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Exited,
    Cancelled,
    TimedOut,
    OutputLimit,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExecutionResult {
    pub execution_id: String,
    pub status: ExecutionStatus,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    /// True only after the executor observes removal of its owned container.
    pub cleanup_confirmed: bool,
    pub error: Option<String>,
}

/// This records an assessment. It never turns a model claim into an oracle proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    Reportable,
    Rejected,
    Inconclusive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceFinding {
    pub id: String,
    pub worker_id: String,
    pub title: String,
    /// SHA-256 of retained original finding bytes, supplied by the trusted host.
    pub artifact_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FindingGroup {
    pub id: String,
    pub source_ids: Vec<String>,
    pub disposition: Disposition,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReconcileRequest {
    pub scan_id: String,
    pub sources: Vec<SourceFinding>,
    pub groups: Vec<FindingGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReconciledGroup {
    pub id: String,
    pub sources: Vec<SourceFinding>,
    pub disposition: Disposition,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReconcileResult {
    pub scan_id: String,
    pub groups: Vec<ReconciledGroup>,
    pub source_count: usize,
    pub reportable_count: usize,
    pub rejected_count: usize,
    pub inconclusive_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Reply {
    Initialized {
        protocol_version: u32,
        capabilities: Vec<String>,
    },
    Execution(ExecutionResult),
    Cancelled {
        execution_id: String,
        accepted: bool,
    },
    Reconciled(ReconcileResult),
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ServerMessage {
    Response {
        protocol_version: u32,
        id: Option<RequestId>,
        reply: Reply,
    },
    Event {
        protocol_version: u32,
        event: ExecutionEvent,
    },
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ValidationError(pub String);

/// One authoritative schema for external adapters and future generated clients.
pub fn schema() -> serde_json::Value {
    serde_json::json!({
        "protocol_version": PROTOCOL_VERSION,
        "request": schemars::schema_for!(Request),
        "server_message": schemars::schema_for!(ServerMessage)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_execution_before_side_effects() {
        let mut request = ExecutionRequest {
            execution_id: "run-1".into(),
            image: "toolbox:local".into(),
            argv: vec!["true".into()],
            stdin: None,
            timeout_ms: 1000,
            memory_mb: 128,
            cpus: 1,
            max_output_bytes: 1024,
        };
        assert!(request.validate().is_ok());
        request.image = "--privileged".into();
        assert!(request.validate().is_err());
        request.image = "toolbox:local".into();
        request.argv = vec!["bad\0arg".into()];
        assert!(request.validate().is_err());
    }

    #[test]
    fn wire_rejects_unrecognized_execution_fields() {
        let frame = r#"{"protocol_version":1,"id":1,"command":{"method":"execute","params":{"execution_id":"a","image":"local","argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":1024,"privileged":true}}}"#;
        assert!(serde_json::from_str::<Request>(frame).is_err());
    }
}
