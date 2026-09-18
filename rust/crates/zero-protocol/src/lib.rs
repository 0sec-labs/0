//! Draft versioned values for the native application and its clients.
//! Experimental schema sketch; not a published compatibility contract.
//! These types carry data, never live processes, credentials, or UI handles.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

mod binary;
pub mod execution;
pub mod model;
pub mod session;
pub use execution::*;
pub use session::*;

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
    SessionCreate {
        generation: String,
        budget_limit: u64,
    },
    SessionList,
    SessionGet {
        session_id: String,
    },
    SessionBudget {
        session_id: String,
    },
    SessionEvents {
        session_id: String,
        after_sequence: u64,
        limit: u32,
    },
    Execute {
        session_id: String,
        command_id: String,
        request: ExecutionRequest,
    },
    Infer {
        session_id: String,
        command_id: String,
        provider: String,
        request: model::ResponsesRequest,
        reservation: u64,
    },
    Cancel {
        session_id: String,
        execution_id: String,
    },
    Reconcile(ReconcileRequest),
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
    Session {
        session: Session,
    },
    Sessions {
        sessions: Vec<Session>,
    },
    SessionBudget {
        budget: BudgetSnapshot,
    },
    SessionEvents {
        events: Vec<SessionEvent>,
    },
    Execution {
        operation: Operation,
        result: Option<ExecutionResult>,
        duplicate: bool,
    },
    Inference {
        operation: Operation,
        completion: Option<model::Completion>,
        duplicate: bool,
    },
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
        reply: Box<Reply>,
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
    fn preserves_caller_identity_and_typed_command_across_round_trip() {
        let request = Request {
            protocol_version: PROTOCOL_VERSION,
            id: RequestId::Text("request-1".into()),
            command: Command::SessionCreate {
                generation: "baseline".into(),
                budget_limit: 100,
            },
        };
        let wire = serde_json::to_vec(&request).unwrap();
        let decoded: Request = serde_json::from_slice(&wire).unwrap();
        assert_eq!(decoded.id, request.id);
        assert!(matches!(
            decoded.command,
            Command::SessionCreate {
                budget_limit: 100,
                ..
            }
        ));
    }

    #[test]
    fn wire_rejects_unrecognized_execution_fields() {
        let mut frame = serde_json::json!({
            "protocol_version":1,"id":1,"command":{"method":"execute","params":{
                "session_id":"session-1","command_id":"command-1","request":{
                    "execution_id":"a","image":"local","argv":["true"],
                    "snapshot":{"id":"snapshot-1","root":"/tmp/source","digest":"sha256:abc","files":[]},
                    "timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":1024
                }
            }}
        });
        assert!(serde_json::from_value::<Request>(frame.clone()).is_ok());
        frame["command"]["params"]["request"]["privileged"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Request>(frame).is_err());
    }
}
