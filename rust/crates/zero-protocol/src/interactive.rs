//! Explicit offline pipe sessions. Input acknowledgment is launcher forwarding,
//! never evidence that the guest consumed it or that an investigation succeeded.
use crate::{
    ValidationError,
    agent::AgentRequest,
    model::ToolDefinition,
    sandbox::{SandboxBackend, SandboxRequest, SandboxResult},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InteractivePolicy {
    pub max_sessions: u32,
    pub max_writes: u32,
    pub max_input_bytes: u64,
    pub max_read_bytes: u32,
    pub deadline_ms: u64,
}
impl InteractivePolicy {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if !(1..=4).contains(&self.max_sessions)
            || !(1..=128).contains(&self.max_writes)
            || !(1..=1_048_576).contains(&self.max_input_bytes)
            || !(1..=65536).contains(&self.max_read_bytes)
            || !(100..=600_000).contains(&self.deadline_ms)
        {
            return Err(ValidationError("interactive policy bounds".into()));
        }
        Ok(())
    }
    pub fn validate_actor(&self, request: &AgentRequest) -> Result<(), ValidationError> {
        self.validate()?;
        let execution = request.snapshot_request()?;
        if !matches!(&execution.backend,SandboxBackend::Docker{image} if crate::is_sha256(image))
            || request
                .workspace_policy
                .as_ref()
                .is_some_and(|p| p.deadline_ms != self.deadline_ms)
            || request.http_profile.is_some()
            || request.delegation_policy.is_some()
            || request.tool_approval_policy.is_some()
            || !request.plugin_tools.is_empty()
            || request.continuation_of.is_some()
            || request.operator_questions
            || request.source_snapshot_tools
            || request.source_review_operation_id.is_some()
            || request.source_submission_max_hypotheses.is_some()
            || execution.max_output_bytes > 1024 * 1024
            || execution.stdin.is_some()
            || execution.build_argv.is_some()
            || request.web_experiment_policy.is_some()
            || request.web_submission_max_hypotheses.is_some()
        {
            return Err(ValidationError("interactive sessions require a digest-pinned offline Docker actor without HTTP, plugins, delegation, approval policies or continuation".into()));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InteractiveCapture {
    pub created_at_ms: u64,
    pub deadline_at_ms: u64,
}
impl InteractiveCapture {
    pub fn validate(&self, policy: &InteractivePolicy) -> Result<(), ValidationError> {
        policy.validate()?;
        if self.created_at_ms == 0
            || self.created_at_ms.checked_add(policy.deadline_ms) != Some(self.deadline_at_ms)
        {
            return Err(ValidationError(
                "interactive deadline capture differs".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum InteractiveCall {
    Create {
        argv: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_generation: Option<String>,
    },
    Write {
        session_id: String,
        data_base64: String,
    },
    Read {
        session_id: String,
        after: u64,
        max_bytes: u32,
        wait_ms: u32,
    },
    Close {
        session_id: String,
    },
}
impl InteractiveCall {
    pub fn parse(name: &str, input: &Value, policy: &InteractivePolicy) -> Result<Self, String> {
        let action = name
            .strip_prefix("interactive_")
            .ok_or("interactive tool name")?;
        let mut value = input
            .as_object()
            .ok_or("interactive arguments must be an object")?
            .clone();
        if value.contains_key("action") {
            return Err("interactive action is host-derived".into());
        }
        value.insert("action".into(), json!(action));
        let call: Self = serde_json::from_value(Value::Object(value))
            .map_err(|_| "invalid interactive arguments")?;
        if let Some(id) = call.session_id() {
            if id.len() != 36
                || !id.bytes().enumerate().all(|(i, b)| {
                    if [8, 13, 18, 23].contains(&i) {
                        b == b'-'
                    } else {
                        b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                    }
                })
            {
                return Err("invalid interactive session handle".into());
            }
        }
        if let Self::Create {
            expected_generation: Some(generation),
            ..
        } = &call
        {
            if !crate::is_sha256(generation) {
                return Err("interactive expected generation invalid".into());
            }
        }
        match &call {
            Self::Write { data_base64, .. } => {
                decode_input(data_base64)?;
            }
            Self::Read {
                max_bytes, wait_ms, ..
            } if *max_bytes == 0 || *max_bytes > policy.max_read_bytes || *wait_ms > 1000 => {
                return Err("interactive read bounds".into());
            }
            Self::Create { argv, .. }
                if argv.is_empty()
                    || argv.len() > 128
                    || argv.iter().any(|v| v.contains('\0') || v.len() > 8192) =>
            {
                return Err("interactive argv bounds".into());
            }
            _ => {}
        }
        Ok(call)
    }
    pub fn name(&self) -> &'static str {
        match self {
            Self::Create { .. } => "interactive_create",
            Self::Write { .. } => "interactive_write",
            Self::Read { .. } => "interactive_read",
            Self::Close { .. } => "interactive_close",
        }
    }
    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::Create { .. } => None,
            Self::Write { session_id, .. }
            | Self::Read { session_id, .. }
            | Self::Close { session_id } => Some(session_id),
        }
    }
    pub fn arguments(&self) -> Value {
        let mut v = serde_json::to_value(self).expect("typed interactive value");
        v.as_object_mut().expect("typed object").remove("action");
        v
    }
}
pub fn decode_input(value: &str) -> Result<Vec<u8>, String> {
    if value.is_empty() || value.len() > 21848 {
        return Err("interactive input frame bounds".into());
    }
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| "interactive input must be canonical base64")?;
    if bytes.is_empty() || bytes.len() > 16384 || STANDARD.encode(&bytes) != value {
        return Err("interactive input frame bounds or encoding".into());
    }
    Ok(bytes)
}
pub fn encode_bytes(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}
pub fn definitions(policy: &InteractivePolicy) -> Vec<ToolDefinition> {
    let string = json!({"type":"string"});
    let handle = json!({"type":"string","maxLength":128});
    [ ("interactive_create","Start one process in the captured offline Docker snapshot. Pipes only, not a PTY. No host paths/network or new budget.",json!({"argv":{"type":"array","items":string,"minItems":1,"maxItems":128}}),vec!["argv"]),
 ("interactive_write","Forward exact base64 bytes once to this actor's pipe session. Successful forwarding does not establish guest consumption.",json!({"session_id":handle,"data_base64":{"type":"string","maxLength":21848}}),vec!["session_id","data_base64"]),
 ("interactive_read","Read a bounded byte-cursor page of untrusted combined stdout/stderr. Output does not establish security or process success.",json!({"session_id":handle,"after":{"type":"integer","minimum":0},"max_bytes":{"type":"integer","minimum":1,"maximum":policy.max_read_bytes},"wait_ms":{"type":"integer","minimum":0,"maximum":1000}}),vec!["session_id","after","max_bytes","wait_ms"]),
 ("interactive_close","Cancel and join this actor's pipe session, retaining actual cleanup disposition.",json!({"session_id":handle}),vec!["session_id"])] .into_iter().map(|(name,description,properties,required)|ToolDefinition{name:name.into(),description:description.into(),parameters:json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})}).collect()
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InteractivePage {
    pub session_id: String,
    pub after: u64,
    pub next_after: u64,
    pub bytes_base64: String,
    pub available_bytes: u64,
    pub finished: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InteractiveResult {
    pub sandbox: SandboxResult,
    pub transcript_sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InteractiveSession {
    pub operation: crate::Operation,
    pub request: SandboxRequest,
    pub result: Option<InteractiveResult>,
}

/// Workspace sessions always name the retained generation; legacy snapshots keep
/// the unchanged creation schema and request identity.
pub fn workspace_definitions(policy: &InteractivePolicy) -> Vec<ToolDefinition> {
    let mut tools = definitions(policy);
    let create = &mut tools[0];
    create.description = "Start an offline pipe session from the exact current private workspace generation. Guest changes never become source edits. Close and recreate after source edits.".into();
    create.parameters["properties"]["expected_generation"] = json!({"type":"string"});
    create.parameters["required"] = json!(["argv", "expected_generation"]);
    tools
}

#[cfg(test)]
mod generation_tests {
    use super::*;
    #[test]
    fn generation_extension_preserves_legacy_arguments_and_requires_valid_identity() {
        let policy = InteractivePolicy {
            max_sessions: 1,
            max_writes: 1,
            max_input_bytes: 100,
            max_read_bytes: 100,
            deadline_ms: 1000,
        };
        let legacy = json!({"argv":["cat"]});
        assert_eq!(
            InteractiveCall::parse("interactive_create", &legacy, &policy)
                .unwrap()
                .arguments(),
            legacy
        );
        assert_eq!(
            definitions(&policy)[0].parameters["required"],
            json!(["argv"])
        );
        assert_eq!(
            workspace_definitions(&policy)[0].parameters["required"],
            json!(["argv", "expected_generation"])
        );
        assert!(
            InteractiveCall::parse(
                "interactive_create",
                &json!({"argv":["cat"],"expected_generation":"not-a-generation"}),
                &policy
            )
            .is_err()
        );
        let current =
            json!({"argv":["cat"],"expected_generation":format!("sha256:{}","a".repeat(64))});
        assert_eq!(
            InteractiveCall::parse("interactive_create", &current, &policy)
                .unwrap()
                .arguments(),
            current
        );
    }
}
