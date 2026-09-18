//! One-invocation operator permission; approval never widens captured authority.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolApprovalPolicy {
    pub require_approval: Vec<String>,
}
impl ToolApprovalPolicy {
    pub fn validate(&self) -> Result<(), crate::ValidationError> {
        if !(1..=33).contains(&self.require_approval.len()) {
            return Err(crate::ValidationError(
                "approval policy requires 1..33 tool aliases".into(),
            ));
        }
        let mut seen = std::collections::BTreeSet::new();
        for name in &self.require_approval {
            if name.is_empty()
                || name.len() > 64
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                || !seen.insert(name)
            {
                return Err(crate::ValidationError(
                    "approval aliases must be unique bounded ASCII tool names".into(),
                ));
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolApprovalDecision {
    Approve,
    Deny,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolApprovalStatus {
    Pending,
    Approved,
    Denied,
    Consumed,
    Cancelled,
    Interrupted,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolApprovalDecisionReceipt {
    pub id: String,
    pub session_id: String,
    pub command_id: String,
    pub approval_operation_id: String,
    pub intent_sha256: String,
    pub decision: ToolApprovalDecision,
    pub sequence: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolApprovalConsumption {
    pub effect_operation_id: String,
    pub effect_command_id: String,
    pub effect_payload_sha256: String,
    pub sequence: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolApprovalRecord {
    pub operation_id: String,
    pub session_id: String,
    pub actor_operation_id: String,
    pub root_operation_id: String,
    pub sequence: u64,
    pub intent_sha256: String,
    pub intent_artifact: String,
    pub tool_name: String,
    pub preview: String,
    pub preview_truncated: bool,
    pub status: ToolApprovalStatus,
    pub operation_status: crate::OperationStatus,
    pub decision: Option<ToolApprovalDecisionReceipt>,
    pub consumption: Option<ToolApprovalConsumption>,
    pub effect_status: Option<crate::OperationStatus>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approval_policy_is_bounded_exact_and_cannot_embed_authority() {
        for tools in [
            vec![],
            vec!["x".to_string(); 2],
            vec!["é".into()],
            vec!["x".repeat(65)],
            (0..34).map(|n| format!("tool{n}")).collect(),
        ] {
            assert!(
                ToolApprovalPolicy {
                    require_approval: tools
                }
                .validate()
                .is_err()
            );
        }
        ToolApprovalPolicy {
            require_approval: vec!["execute_snapshot".into(), "explicit-plugin_1".into()],
        }
        .validate()
        .unwrap();
        assert!(
            serde_json::from_value::<ToolApprovalPolicy>(
                serde_json::json!({"require_approval":["execute_snapshot"],"network":true})
            )
            .is_err()
        );
    }
}
