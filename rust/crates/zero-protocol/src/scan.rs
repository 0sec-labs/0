//! Standalone scoped HTTP investigation. Publication and claimed severity confer no verification.
use crate::{
    BudgetSnapshot, OperationStatus, ValidationError,
    agent::{AgentRequest, AgentStatus},
    context::ContextPolicy,
    delegation::DelegationPolicy,
    source::SecurityConclusion,
    web::WebWorkflowReport,
    web_experiment::WebExperimentPolicy,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const MAX_SCAN_REPORT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SCAN_INTENT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScanKind {
    ScopedHttp,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScanCurrency {
    Units,
    Usd,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScanProfile {
    pub schema_version: u32,
    pub kind: ScanKind,
    pub provider: String,
    pub model: String,
    pub instructions: String,
    pub http_profile: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_experiment_policy: Option<WebExperimentPolicy>,
}
fn invalid() -> ValidationError {
    ValidationError("unsupported scan profile authority or bounds".into())
}
fn text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.contains('\0')
}
/// Classify standalone HTTP targets before configuration or effects. URL normalization
/// and scope authorization remain the HTTP client's responsibility; check again afterward.
pub fn validate_scan_target(target: &str) -> Result<(), ValidationError> {
    if !text(target, 8192) || !(target.starts_with("http://") || target.starts_with("https://")) {
        return Err(ValidationError(
            "Scan requires an absolute HTTP(S) target; source, package, browser and MCP workflows are unsupported".into(),
        ));
    }
    let shape = target.trim_end().to_ascii_lowercase();
    let path = shape.split(['?', '#']).next().unwrap_or(&shape);
    if shape.starts_with("https://github.com/") || shape.ends_with(".git") || path.ends_with(".git")
    {
        return Err(ValidationError(
            "Repository targets require a source workflow; standalone HTTP scan does not support repository inputs".into(),
        ));
    }
    Ok(())
}
impl ScanProfile {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.schema_version != 1
            || !text(&self.provider, 256)
            || !text(&self.model, 256)
            || !text(&self.instructions, 32768)
            || !text(&self.http_profile, 128)
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
        if let Some(p) = &self.context_policy {
            p.validate()?;
        }
        if let Some(p) = &self.web_experiment_policy {
            p.validate()?;
        }
        if let Some(p) = &self.delegation_policy {
            p.validate()?;
            for r in &p.roles {
                if r.reservation_per_turn > self.budget_limit
                    || r.tools
                        .iter()
                        .any(|t| !matches!(t.as_str(), "http_request" | "run_web_experiment"))
                    || (r.tools.iter().any(|t| t == "run_web_experiment")
                        && self.web_experiment_policy.is_none())
                {
                    return Err(invalid());
                }
            }
        }
        Ok(())
    }
    /// Compile public intent only. Engine must normalize and authorize target using its private HTTP client first.
    pub fn request(&self, target: &str) -> Result<AgentRequest, ValidationError> {
        self.validate()?;
        validate_scan_target(target)?;
        Ok(AgentRequest {
            interactive_policy: None,
            workspace_policy: None,
            provider: self.provider.clone(),
            model: self.model.clone(),
            instructions: self.instructions.clone(),
            prompt: format!(
                "Investigate the scoped HTTP target {target}. Choose bounded requests and authorized experiments as useful. Submit supported unverified hypotheses with retained evidence using submit_web_hypotheses; an empty submission does not establish target safety."
            ),
            context_policy: self.context_policy.clone(),
            operator_questions: false,
            http_profile: Some(self.http_profile.clone()),
            web_experiment_policy: self.web_experiment_policy.clone(),
            tool_approval_policy: None,
            delegation_policy: self.delegation_policy.clone(),
            continuation_of: None,
            source_review_operation_id: None,
            source_snapshot_tools: false,
            source_submission_max_hypotheses: None,
            web_submission_max_hypotheses: Some(self.max_hypotheses),
            execution: None,
            plugin_tools: vec![],
            max_turns: self.max_turns,
            reservation_per_turn: self.reservation_per_turn,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScanRecord {
    pub schema_version: u32,
    pub id: String,
    pub command_id: String,
    pub session_id: String,
    pub controller_operation_id: String,
    pub root_operation_id: String,
    pub input_target: String,
    pub target: String,
    pub profile_name: String,
    pub intent_sha256: String,
    pub profile_sha256: String,
    pub http_account_id: String,
    pub created_at_ms: u64,
    pub deadline_at_ms: u64,
    pub sequence: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScanCloseReason {
    Cancelled,
    Deadline,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScanPhase {
    Admitted,
    Investigating,
    Cancelling,
    Terminal,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScanStopReason {
    Submitted,
    StoppedWithoutSubmission,
    TurnLimit,
    BudgetLimit,
    Deadline,
    Cancelled,
    Failed,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScanCompleteness {
    CompletedWorkflow,
    Partial,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScanClaimSummary {
    pub submitted_hypotheses: u32,
    pub claimed_critical: u32,
    pub claimed_high: u32,
    pub claimed_medium: u32,
    pub claimed_low: u32,
    pub claimed_info: u32,
    pub verified_vulnerabilities: u32,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScanHttpUsage {
    pub requests: u64,
    pub request_body_bytes: u64,
    pub response_charged_bytes: u64,
    pub response_reserved_bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScanOutcome {
    pub close_reason: Option<ScanCloseReason>,
    pub http_usage: ScanHttpUsage,
    pub schema_version: u32,
    pub scan_id: String,
    pub root_status: OperationStatus,
    pub agent_status: Option<AgentStatus>,
    pub stop_reason: ScanStopReason,
    pub completeness: ScanCompleteness,
    pub started_at_ms: u64,
    pub completed_at_ms: u64,
    pub review_sha256: Option<String>,
    pub budget: BudgetSnapshot,
    pub currency: ScanCurrency,
    pub summary: ScanClaimSummary,
    pub security_conclusion: SecurityConclusion,
    pub vulnerability_reportable: bool,
    pub error_code: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScanPublication {
    Retained { report_sha256: String },
    ReportTooLarge,
    Unavailable { reason: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScanResult {
    pub outcome: ScanOutcome,
    pub publication: ScanPublication,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScanSnapshot {
    pub http_usage: ScanHttpUsage,
    pub scan: ScanRecord,
    pub controller_status: OperationStatus,
    pub root_status: OperationStatus,
    pub phase: ScanPhase,
    pub close_reason: Option<ScanCloseReason>,
    pub budget: BudgetSnapshot,
    pub currency: ScanCurrency,
    pub result: Option<ScanResult>,
    pub observed_sequence: u64,
    pub observed_at_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScanPage {
    pub scans: Vec<ScanSnapshot>,
    pub next_before_sequence: Option<u64>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScanReportKind {
    Retained,
    Recovery,
    Compact,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScanReport {
    pub schema_version: u32,
    pub kind: ScanReportKind,
    pub scan: ScanRecord,
    pub outcome: ScanOutcome,
    pub web: Option<WebWorkflowReport>,
    /// Actual consumed observation-scanner position; never inferred from displayed item count.
    pub observations_next_after_sequence: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn profile() -> ScanProfile {
        serde_json::from_value(json!({"schema_version":1,"kind":"scoped_http","provider":"p","model":"m","instructions":"Investigate only authorized HTTP","http_profile":"http","budget_limit":100,"currency":"units","reservation_per_turn":10,"max_turns":4,"max_hypotheses":4,"deadline_ms":1000})).unwrap()
    }
    #[test]
    fn repository_and_non_http_targets_cannot_compile_http_scan_requests() {
        for target in [
            "https://github.com/owner/repo",
            "https://GitHub.com/owner/repo",
            "https://example.test/repo.git",
            "https://example.test/repo.git?ref=main",
            "https://example.test/repo.git#readme",
            "git@example.test:repo.git",
            "source:./repo",
            "./repo",
            "npm:package",
            "mcp://example.test",
        ] {
            assert!(profile().request(target).is_err(), "{target}");
        }
        for target in [
            "https://example.test/path",
            "http://127.0.0.1:8080/target",
            "https://github.com.example.test/target",
            "https://example.test/repo.git/info",
        ] {
            assert!(profile().request(target).is_ok(), "{target}");
        }
    }
    #[test]
    fn scan_renderer_has_no_ambient_or_interactive_authority() {
        let p = profile();
        let r = p.request("https://example.test/path").unwrap();
        assert!(r.execution.is_none() && r.plugin_tools.is_empty() && !r.operator_questions);
        assert!(
            r.tool_approval_policy.is_none()
                && r.continuation_of.is_none()
                && r.source_submission_max_hypotheses.is_none()
        );
        assert_eq!(r.web_submission_max_hypotheses, Some(4));
        assert!(
            r.prompt.contains("https://example.test/path")
                && r.prompt.contains("empty submission does not establish")
        );
        let mut raw = serde_json::to_value(p).unwrap();
        raw["execution"] = json!({});
        assert!(serde_json::from_value::<ScanProfile>(raw).is_err());
    }
    #[test]
    fn scan_rejects_unfunded_roles_and_new_tool_authority() {
        let mut raw = serde_json::to_value(profile()).unwrap();
        raw["delegation_policy"] = json!({"max_parallel":1,"max_children":1,"roles":[{"name":"helper","provider":"p","model":"m","instructions":"help","description":"HTTP helper","tools":["http_request"],"max_turns":2,"reservation_per_turn":10}]});
        serde_json::from_value::<ScanProfile>(raw.clone())
            .unwrap()
            .validate()
            .unwrap();
        for tool in [
            "execute_snapshot",
            "submit_web_hypotheses",
            "run_web_experiment",
            "activate",
        ] {
            let mut invalid = raw.clone();
            invalid["delegation_policy"]["roles"][0]["tools"] = json!([tool]);
            assert!(
                serde_json::from_value::<ScanProfile>(invalid)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        raw["delegation_policy"]["roles"][0]["reservation_per_turn"] = json!(101);
        assert!(
            serde_json::from_value::<ScanProfile>(raw)
                .unwrap()
                .validate()
                .is_err()
        );
    }
    #[test]
    fn scan_bounds_require_explicit_positive_budget_and_finite_deadline() {
        for (field, value) in [
            ("budget_limit", 0),
            ("reservation_per_turn", 0),
            ("reservation_per_turn", 101),
            ("max_turns", 33),
            ("max_hypotheses", 0),
            ("deadline_ms", 0),
            ("deadline_ms", 86_400_001),
        ] {
            let mut raw = serde_json::to_value(profile()).unwrap();
            raw[field] = json!(value);
            assert!(
                serde_json::from_value::<ScanProfile>(raw)
                    .unwrap()
                    .validate()
                    .is_err(),
                "{field}"
            );
        }
    }
}
