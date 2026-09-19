//! Host-owned configuration for adaptive local-source review. Compiling intent
//! grants neither a model call nor execution; the engine must first admit it.
use crate::{
    SnapshotPin, ValidationError,
    agent::{AgentExecution, AgentRequest},
    context::ContextPolicy,
    delegation::DelegationPolicy,
    sandbox::{SandboxBackend, SandboxRequest},
    scan::ScanCurrency,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

const PROMPT_PREFIX: &str = "Investigate the authorized pinned source. Choose source reads, searches, delegation and offline experiments as useful. Submit supported unverified hypotheses with exact source citations using submit_source_hypotheses. An empty submission does not establish source safety. Review question: ";

pub const MAX_REVIEW_FILES: usize = 4096;
pub const MAX_REVIEW_SOURCE_BYTES: u64 = 64 * 1024 * 1024;

/// Explicit offline execution authority. Source identity comes from host capture,
/// and argv comes from the agent's bounded execute_snapshot tool invocation.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewExecution {
    pub backend: SandboxBackend,
    pub timeout_ms: u64,
    pub memory_mb: u64,
    pub cpus: f64,
    pub max_output_bytes: usize,
}
impl ReviewExecution {
    fn request(&self, snapshot: SnapshotPin, execution_id: &str) -> SandboxRequest {
        SandboxRequest {
            execution_id: execution_id.into(),
            backend: self.backend.clone(),
            snapshot,
            // The actor's execute_snapshot handler replaces argv before every
            // execution. This template is never a startup or required probe.
            argv: vec!["true".into()],
            build_argv: None,
            stdin: None,
            timeout_ms: self.timeout_ms,
            memory_mb: self.memory_mb,
            cpus: self.cpus,
            max_output_bytes: self.max_output_bytes,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewProfile {
    pub schema_version: u32,
    #[serde(
        default,
        skip_serializing_if = "crate::workspace::WorkspaceSelectionMode::is_default"
    )]
    pub workspace_selection: crate::workspace::WorkspaceSelectionMode,
    pub provider: String,
    pub model: String,
    pub instructions: String,
    pub question: String,
    pub execution: ReviewExecution,
    pub budget_limit: u64,
    pub currency: ScanCurrency,
    pub reservation_per_turn: u64,
    pub max_turns: u32,
    pub max_hypotheses: u32,
    pub deadline_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_policy: Option<ContextPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation_policy: Option<DelegationPolicy>,
}
fn invalid() -> ValidationError {
    ValidationError("unsupported local review authority or bounds".into())
}
fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.contains('\0')
}
impl ReviewProfile {
    /// Pure validation; never touches source files, credentials or a backend.
    /// The engine must capture provider rates and atomically fund the actor.
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.schema_version != 1
            || !text(&self.provider, 256)
            || !text(&self.model, 256)
            || !text(&self.instructions, 32768)
            || !text(
                &self.question,
                crate::source::MAX_SOURCE_QUESTION_BYTES - PROMPT_PREFIX.len(),
            )
            || self.budget_limit == 0
            || self.reservation_per_turn == 0
            || self.reservation_per_turn > self.budget_limit
            || !(1..=32).contains(&self.max_turns)
            || !(1..=32).contains(&self.max_hypotheses)
            || !(1..=86_400_000).contains(&self.deadline_ms)
            || serde_json::to_vec(self).map_err(|_| invalid())?.len() > 256 * 1024
        {
            return Err(invalid());
        }
        if let SandboxBackend::Docker { image } = &self.execution.backend {
            let digest = image
                .rsplit_once('@')
                .map_or(image.as_str(), |(_, digest)| digest);
            if !crate::is_sha256(digest) {
                return Err(ValidationError(
                    "local review requires an immutable Docker image digest".into(),
                ));
            }
        }
        // Validate the shared backend/resource contract without inventing any
        // real source authority. This structural sentinel is never returned.
        let digest = format!("sha256:{}", "0".repeat(64));
        self.execution
            .request(
                SnapshotPin {
                    id: "validation".into(),
                    root: "/validation".into(),
                    digest: digest.clone(),
                    files: vec![crate::SnapshotFile {
                        path: "validation".into(),
                        digest,
                        bytes: 0,
                    }],
                },
                "validation",
            )
            .validate()?;
        if let Some(policy) = &self.context_policy {
            policy.validate()?;
        }
        if let Some(policy) = &self.delegation_policy {
            policy.validate()?;
            for role in &policy.roles {
                if role.reservation_per_turn > self.budget_limit
                    || !text(&role.provider, 256)
                    || !text(&role.model, 256)
                    || role.tools.iter().any(|tool| {
                        !matches!(
                            tool.as_str(),
                            "list_source_files"
                                | "read_source_lines"
                                | "search_source_text"
                                | "execute_snapshot"
                        )
                    })
                {
                    return Err(invalid());
                }
            }
        }
        Ok(())
    }

    /// Compile the exact host-captured manifest, not a model-selected path.
    /// This checks structure/bounds only; anchored capture and digest verification
    /// remain the executor's job. Retry identity must be resolved before recapture.
    pub fn request(
        &self,
        snapshot: SnapshotPin,
        execution_id: &str,
    ) -> Result<AgentRequest, ValidationError> {
        self.validate()?;
        let total = snapshot
            .files
            .iter()
            .try_fold(0u64, |sum, file| sum.checked_add(file.bytes));
        if snapshot.files.len() > MAX_REVIEW_FILES
            || total.is_none_or(|bytes| bytes > MAX_REVIEW_SOURCE_BYTES)
            || snapshot
                .files
                .iter()
                .any(|file| file.path.contains(':') || file.path.chars().any(char::is_control))
        {
            return Err(invalid());
        }
        let execution = self.execution.request(snapshot, execution_id);
        execution.validate()?;
        let request = AgentRequest {
            provider: self.provider.clone(),
            model: self.model.clone(),
            instructions: self.instructions.clone(),
            prompt: format!("{PROMPT_PREFIX}{}", self.question),
            context_policy: self.context_policy.clone(),
            operator_questions: false,
            http_profile: None,
            web_experiment_policy: None,
            tool_approval_policy: None,
            delegation_policy: self.delegation_policy.clone(),
            continuation_of: None,
            source_review_operation_id: None,
            source_snapshot_tools: true,
            source_submission_max_hypotheses: Some(self.max_hypotheses),
            web_submission_max_hypotheses: None,
            execution: Some(AgentExecution::Sandbox(execution)),
            plugin_tools: vec![],
            max_turns: self.max_turns,
            reservation_per_turn: self.reservation_per_turn,
        };
        request.validate_capabilities()?;
        Ok(request)
    }
    /// New selected captures bind their host scope into the actor prompt.
    /// Historical records without a receipt preserve the original compiler bytes.
    pub fn request_with_selection(
        &self,
        snapshot: SnapshotPin,
        execution_id: &str,
        selection: Option<&crate::workspace::WorkspaceSelectionReceipt>,
    ) -> Result<AgentRequest, ValidationError> {
        if let Some(receipt) = selection {
            receipt.validate_pin(&snapshot).map_err(|_| invalid())?;
            if self.workspace_selection == crate::workspace::WorkspaceSelectionMode::FullTree
                && receipt.policy != crate::workspace::WorkspaceSelectionPolicy::FullTree
            {
                return Err(invalid());
            }
        }
        let mut request = self.request(snapshot, execution_id)?;
        if let Some(receipt) = selection {
            request.prompt.push_str(&receipt.prompt_scope());
            if request.prompt.len() > crate::source::MAX_SOURCE_QUESTION_BYTES {
                return Err(invalid());
            }
        }
        request.validate_capabilities()?;
        Ok(request)
    }
}

/// Immutable identity of an admitted local source investigation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewRecord {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_selection: Option<crate::workspace::WorkspaceSelectionReceipt>,
    pub id: String,
    pub command_id: String,
    pub session_id: String,
    pub controller_operation_id: String,
    pub root_operation_id: String,
    pub input_path: String,
    pub canonical_path: String,
    pub snapshot_sha256: String,
    pub profile_name: String,
    pub intent_sha256: String,
    pub profile_sha256: String,
    pub created_at_ms: u64,
    pub deadline_at_ms: u64,
    pub sequence: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewCloseReason {
    Cancelled,
    Deadline,
}
/// Retained lifecycle/funding only. An admitted or stopped run has no implied
/// security conclusion or successful empty submission.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewSnapshot {
    pub review: ReviewRecord,
    pub agent_result: Option<crate::agent::AgentResult>,
    pub controller_status: crate::OperationStatus,
    pub root_status: crate::OperationStatus,
    pub close_reason: Option<ReviewCloseReason>,
    pub budget: crate::BudgetSnapshot,
    pub currency: ScanCurrency,
    pub observed_sequence: u64,
    pub observed_at_ms: u64,
}

/// Bounded history metadata. Source claims and archive bytes require explicit
/// report/archive reads; their absence here does not imply an empty review.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewHistoryEntry {
    pub review: ReviewRecord,
    pub controller_status: crate::OperationStatus,
    pub root_status: crate::OperationStatus,
    pub close_reason: Option<ReviewCloseReason>,
    pub budget: crate::BudgetSnapshot,
    pub currency: ScanCurrency,
    pub observed_sequence: u64,
    pub observed_at_ms: u64,
}

impl From<ReviewSnapshot> for ReviewHistoryEntry {
    fn from(snapshot: ReviewSnapshot) -> Self {
        Self {
            review: snapshot.review,
            controller_status: snapshot.controller_status,
            root_status: snapshot.root_status,
            close_reason: snapshot.close_reason,
            budget: snapshot.budget,
            currency: snapshot.currency,
            observed_sequence: snapshot.observed_sequence,
            observed_at_ms: snapshot.observed_at_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewPage {
    pub reviews: Vec<ReviewHistoryEntry>,
    pub next_before_sequence: Option<u64>,
}

/// A point-in-time view over retained source evidence, never a safety verdict.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewReport {
    pub schema_version: u32,
    pub review: ReviewSnapshot,
    pub source: Option<crate::source::SourceReport>,
    pub security_conclusion: crate::source::SecurityConclusion,
}
