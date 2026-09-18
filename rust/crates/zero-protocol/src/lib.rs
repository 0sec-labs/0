//! Draft versioned values for the native application and its clients.
//! Experimental schema sketch; not a published compatibility contract.
//! These types carry data, never live processes, credentials, or UI handles.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub mod agent;
pub mod approvals;
mod binary;
pub mod campaign;
pub mod context;
pub mod delegation;
pub mod discovery;
pub mod execution;
pub mod history;
pub mod http;
pub mod microvm;
pub mod model;
pub mod plugin;
pub mod questions;
pub mod queue;
pub mod repair;
pub mod sandbox;
pub mod session;
pub mod source;
pub mod steering;
pub mod strategy;
pub mod triage;
pub mod verification;
mod verification_binary;
pub mod web;
pub mod web_experiment;
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
    CreateStrategyCampaign {
        command_id: String,
        plan: Box<strategy::StrategyPlan>,
    },
    RunStrategyCampaign {
        campaign_id: String,
        lane: campaign::CampaignLane,
    },
    CampaignStatus {
        campaign_id: String,
    },
    CampaignRuns {
        campaign_id: String,
        after_sequence: u64,
        limit: u32,
    },
    StrategyCampaignReport {
        campaign_id: String,
    },
    StrategyDevelopmentFeedback {
        campaign_id: String,
    },
    CancelStrategyCampaign {
        campaign_id: String,
    },
    SessionCreate {
        generation: String,
        budget_limit: u64,
    },
    SessionCreatePinned {
        budget_limit: u64,
    },
    RunPlugin {
        session_id: String,
        command_id: String,
        plugin: String,
        tool: String,
        input: serde_json::Value,
    },
    SessionList,
    SessionListPage {
        after: Option<history::SessionCursor>,
        limit: u32,
    },
    SessionHistory {
        session_id: String,
        before_sequence: Option<u64>,
        limit: u32,
    },
    SessionGet {
        session_id: String,
    },
    SessionBudget {
        session_id: String,
    },
    ReconcileUsage {
        session_id: String,
        operation_id: String,
        charged: u64,
        evidence: String,
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
    RunSandbox {
        session_id: String,
        command_id: String,
        request: sandbox::SandboxRequest,
    },
    ValidateSourceRepair {
        session_id: String,
        command_id: String,
        request: repair::RepairValidationRequest,
    },
    ReproduceSource {
        session_id: String,
        command_id: String,
        request: verification::SourceReproductionRequest,
    },
    WebRuns {
        session_id: String,
        before_sequence: Option<u64>,
        limit: u32,
    },
    WebRun {
        session_id: String,
        operation_id: String,
    },
    WebHttpOperations {
        session_id: String,
        web_operation_id: String,
        after_sequence: u64,
        limit: u32,
    },
    WebFindings {
        session_id: String,
        web_operation_id: String,
        #[serde(default)]
        offset: u32,
        #[serde(default = "triage::finding_limit")]
        limit: u32,
    },
    WebFinding {
        session_id: String,
        web_operation_id: String,
        hypothesis_id: String,
        #[serde(default)]
        after_revision: u64,
        #[serde(default = "triage::history_limit")]
        limit: u32,
    },
    TriageWebFinding {
        session_id: String,
        command_id: String,
        web_operation_id: String,
        hypothesis_id: String,
        status: web::WebTriageStatus,
        expected_revision: u64,
        note: String,
    },
    HttpEvidence {
        session_id: String,
        operation_id: String,
    },
    HttpEvidenceRange {
        session_id: String,
        operation_id: String,
        expected_manifest_sha256: String,
        offset: u64,
        limit: u32,
    },
    PrepareWebVerification {
        session_id: String,
        plan: web::WebVerificationPlan,
    },
    VerifyWebHypothesis {
        session_id: String,
        command_id: String,
        request: web::WebVerificationRequest,
    },
    WebExperiments {
        session_id: String,
        web_operation_id: String,
        after_sequence: u64,
        limit: u32,
    },
    WebExperiment {
        session_id: String,
        web_operation_id: String,
        experiment_operation_id: String,
    },
    WebWorkflowReport {
        session_id: String,
        operation_id: String,
        verification_ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        experiment_ids: Vec<String>,
    },
    SourceReviews {
        session_id: String,
        before_sequence: Option<u64>,
        limit: u32,
    },
    SourceFindings {
        session_id: String,
        source_operation_id: String,
        #[serde(default)]
        offset: u32,
        #[serde(default = "triage::finding_limit")]
        limit: u32,
    },
    SourceFinding {
        session_id: String,
        source_operation_id: String,
        hypothesis_id: String,
        #[serde(default)]
        after_revision: u64,
        #[serde(default = "triage::history_limit")]
        limit: u32,
    },
    TriageSourceFinding {
        session_id: String,
        command_id: String,
        source_operation_id: String,
        hypothesis_id: String,
        status: triage::SourceFindingStatus,
        expected_revision: u64,
        note: String,
    },
    ReviewSource {
        session_id: String,
        command_id: String,
        request: source::SourceReviewRequest,
    },
    ToolApprovals {
        session_id: String,
        root_operation_id: Option<String>,
        after_sequence: u64,
        limit: u32,
    },
    ToolApproval {
        session_id: String,
        approval_operation_id: String,
    },
    DecideToolApproval {
        session_id: String,
        command_id: String,
        approval_operation_id: String,
        expected_intent_sha256: String,
        decision: approvals::ToolApprovalDecision,
    },
    OperatorQuestions {
        session_id: String,
        root_operation_id: Option<String>,
        after_sequence: u64,
        limit: u32,
    },
    OperatorQuestion {
        session_id: String,
        question_operation_id: String,
    },
    DecideOperatorQuestion {
        session_id: String,
        command_id: String,
        question_operation_id: String,
        expected_request_sha256: String,
        decision: questions::OperatorDecision,
    },
    SteerAgent {
        session_id: String,
        operation_id: String,
        command_id: String,
        prompt: String,
    },
    AgentSteering {
        session_id: String,
        operation_id: String,
        after_sequence: u64,
        limit: u32,
    },
    QueueAgent {
        session_id: String,
        command_id: String,
        request: agent::AgentRequest,
        after_input: Option<String>,
    },
    AgentQueue {
        session_id: String,
        after_sequence: u64,
        limit: u32,
    },
    CancelQueuedAgent {
        session_id: String,
        input_id: String,
    },
    RunQueuedAgent {
        session_id: String,
        input_id: String,
    },
    RunAgent {
        session_id: String,
        command_id: String,
        request: agent::AgentRequest,
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
    StrategyCampaignCreated {
        campaign: campaign::CampaignSnapshot,
        duplicate: bool,
    },
    StrategyCampaignReport {
        report: strategy::StrategyReport,
    },
    StrategyDevelopmentFeedback {
        feedback: strategy::StrategyDevelopmentFeedback,
    },
    StrategyCampaignCancelled {
        snapshot: campaign::CampaignSnapshot,
    },
    CampaignStatus {
        snapshot: campaign::CampaignSnapshot,
    },
    CampaignRuns {
        page: campaign::CampaignRunPage,
    },
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
    SessionListPage {
        page: history::SessionListPage,
    },
    SessionHistory {
        page: history::SessionHistoryPage,
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
    Plugin {
        operation: Operation,
        result: Option<plugin::PluginOutcome>,
        duplicate: bool,
    },
    Sandbox {
        operation: Operation,
        result: Option<sandbox::SandboxResult>,
        duplicate: bool,
    },
    SourceRepair {
        operation: session::Operation,
        result: Option<repair::RepairValidationOutcome>,
        duplicate: bool,
    },
    SourceReproduction {
        operation: Operation,
        result: Option<verification::ReproductionOutcome>,
        duplicate: bool,
    },
    WebRuns {
        page: web::WebRunsPage,
    },
    WebRun {
        run: web::WebRun,
    },
    WebHttpOperations {
        page: web::WebHttpOperationsPage,
    },
    WebFindings {
        findings: Vec<web::WebFindingRecord>,
    },
    WebFinding {
        finding: web::WebFindingRecord,
        history: Vec<web::WebTriageDecision>,
    },
    WebFindingTriaged {
        finding: web::WebFindingRecord,
        decision: web::WebTriageDecision,
        duplicate: bool,
    },
    HttpEvidence {
        evidence: web::HttpEvidenceMetadata,
    },
    HttpEvidenceRange {
        range: web::HttpEvidenceRange,
    },
    WebVerificationPrepared {
        preparation: web::WebVerificationPreparation,
    },
    WebVerification {
        operation: Operation,
        result: Option<web::WebVerificationOutcome>,
        duplicate: bool,
    },
    WebExperiments {
        page: web_experiment::WebExperimentsPage,
    },
    WebExperiment {
        experiment: web_experiment::WebExperimentReport,
    },
    WebWorkflowReport {
        report: web::WebWorkflowReport,
    },
    SourceReviews {
        page: discovery::SourceReviewPage,
    },
    SourceFindings {
        findings: Vec<triage::SourceFindingRecord>,
    },
    SourceFinding {
        finding: triage::SourceFindingRecord,
        history: Vec<triage::TriageDecision>,
    },
    SourceFindingTriaged {
        finding: triage::SourceFindingRecord,
        decision: triage::TriageDecision,
        duplicate: bool,
    },
    SourceReview {
        operation: Operation,
        result: Option<source::SourceReviewOutcome>,
        duplicate: bool,
    },
    ToolApprovals {
        approvals: Vec<approvals::ToolApprovalRecord>,
    },
    ToolApproval {
        approval: approvals::ToolApprovalRecord,
    },
    ToolApprovalDecided {
        approval: approvals::ToolApprovalRecord,
        decision: approvals::ToolApprovalDecisionReceipt,
        duplicate: bool,
    },
    OperatorQuestions {
        questions: Vec<questions::OperatorQuestionRecord>,
    },
    OperatorQuestion {
        question: questions::OperatorQuestionRecord,
    },
    OperatorQuestionDecided {
        question: questions::OperatorQuestionRecord,
        decision: questions::OperatorQuestionDecisionReceipt,
        duplicate: bool,
    },
    AgentSteered {
        message: steering::AgentSteeringMessage,
        duplicate: bool,
    },
    AgentSteering {
        messages: Vec<steering::AgentSteeringMessage>,
    },
    AgentQueued {
        input: queue::QueuedAgent,
        duplicate: bool,
    },
    AgentQueue {
        inputs: Vec<queue::QueuedAgent>,
    },
    AgentInput {
        input: queue::QueuedAgent,
    },
    Agent {
        operation: Operation,
        result: Option<agent::AgentResult>,
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
