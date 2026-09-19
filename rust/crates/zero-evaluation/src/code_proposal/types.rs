use crate::{Case, Lane, Plan, Result, ScoringPolicy, digest, invalid};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zero_plugin_runner::Launch;
use zero_protocol::model::{ResponsesRequest, ToolDefinition};

pub const MAX_SOURCE: usize = 32768;
pub const SEMANTICS: &str = "offline-python-proposal-v1/exact-paired-json-v1";
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PythonEvolutionPlan {
    pub schema_version: u32,
    pub baseline: String,
    pub evaluator_artifact: String,
    pub engine_artifact: String,
    pub host_policy_artifact: String,
    pub plugin: String,
    pub tool: String,
    pub launch: Launch,
    pub cases: Vec<Case>,
    pub repeats: usize,
    pub attempt_budget: usize,
    pub scoring: ScoringPolicy,
    pub objective: String,
    pub provider: String,
    pub model: String,
    pub reservation: u64,
    pub max_output_tokens: u32,
    pub expires_at_ms: u64,
}
impl PythonEvolutionPlan {
    pub fn evaluation(&self, candidate: String) -> Plan {
        Plan {
            baseline: self.baseline.clone(),
            candidate,
            evaluator_artifact: self.evaluator_artifact.clone(),
            engine_artifact: self.engine_artifact.clone(),
            host_policy_artifact: self.host_policy_artifact.clone(),
            plugin: self.plugin.clone(),
            tool: self.tool.clone(),
            launch: self.launch.clone(),
            cases: self.cases.clone(),
            repeats: self.repeats,
            attempt_budget: self.attempt_budget,
            scoring: self.scoring.clone(),
        }
    }
    pub fn validate(&self) -> Result<()> {
        self.evaluation(digest(b"candidate identity validation placeholder"))
            .validate()?;
        if self.schema_version != 1
            || self.objective.trim().is_empty()
            || self.objective.len() > 8192
            || self.provider.is_empty()
            || self.provider.len() > 128
            || self.model.is_empty()
            || self.model.len() > 256
            || self.reservation == 0
            || !(1..=8192).contains(&self.max_output_tokens)
            || self.expires_at_ms == 0
            || self.launch.interpreter != ["python3", "-I"]
            || !matches!(
                self.launch.backend,
                zero_protocol::sandbox::SandboxBackend::Docker { .. }
            )
        {
            return Err(invalid(
                "Python proposal host policy, interpreter, provider or limits",
            ));
        }
        if serde_json::to_vec(self)?.len() > 1024 * 1024 {
            return Err(invalid("Python proposal plan exceeds bound"));
        }
        Ok(())
    }
    /// Labels, ordering, Development, proposals and baseline/candidate do not refresh a suite.
    /// Oracle semantics and repeats are part of the protected identity.
    pub fn suite_sha256(&self) -> Result<String> {
        let mut cases: Vec<Vec<u8>> = self
            .cases
            .iter()
            .filter(|c| c.lane != Lane::Development)
            .map(|c| {
                serde_json::to_vec(&json!({"lane":c.lane,"input":c.input,"expected":c.expected}))
            })
            .collect::<std::result::Result<_, _>>()?;
        cases.sort();
        Ok(digest(&serde_json::to_vec(
            &json!({"semantics":SEMANTICS,"repeats":self.repeats,"scoring":{"minimum_cases_per_lane":self.scoring.minimum_cases_per_lane,"minimum_held_out_gain":self.scoring.minimum_held_out_gain},"cases":cases}),
        )?))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PythonProposalContext {
    pub state_database: String,
    pub session_id: String,
    pub command_id: String,
}
impl PythonProposalContext {
    pub fn validate(&self) -> Result<()> {
        if !std::path::Path::new(&self.state_database).is_absolute()
            || self.state_database.len() > 4096
            || [&self.session_id, &self.command_id]
                .iter()
                .any(|s| s.is_empty() || s.len() > 256)
        {
            return Err(invalid(
                "Python proposal context must identify one existing session/command",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Intent {
    pub semantics: String,
    pub controller_id: String,
    pub controller_root: std::path::PathBuf,
    pub context: PythonProposalContext,
    pub plan: PythonEvolutionPlan,
    pub baseline_manifest: zero_evolution::Manifest,
    pub plugin_manifest: zero_plugin::Manifest,
    pub source_state: zero_evolution::RuntimeState,
}
impl Intent {
    pub fn sha(&self) -> Result<String> {
        Ok(digest(&serde_json::to_vec(self)?))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum PythonCandidateOutput {
    Propose {
        source_utf8: String,
        rationale: String,
    },
    Stop {
        reason: String,
    },
}
impl PythonCandidateOutput {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Propose {
                source_utf8,
                rationale,
            } if !source_utf8.is_empty()
                && source_utf8.len() <= MAX_SOURCE
                && !source_utf8.contains('\0')
                && !rationale.trim().is_empty()
                && rationale.len() <= 4096 =>
            {
                Ok(())
            }
            Self::Stop { reason } if !reason.trim().is_empty() && reason.len() <= 4096 => Ok(()),
            _ => Err(invalid("Python proposal output is empty or exceeds bounds")),
        }
    }
}
pub(super) fn render(intent: &Intent, source: &str) -> Result<ResponsesRequest> {
    let p = &intent.plan;
    let development: Vec<Value> = p
        .cases
        .iter()
        .filter(|c| c.lane == Lane::Development)
        .map(|c| json!({"input":c.input,"expected":c.expected}))
        .collect();
    let request=ResponsesRequest{
        model:p.model.clone(),
        instructions:"Propose one Python JSON-RPC plugin source change or stop. Read one newline-terminated JSON-RPC 2.0 tool.invoke request from stdin and write exactly one result/error frame with matching id. The host runs Python3 -I offline. Call submit_python_candidate exactly once. You cannot change host policy, plugin manifest, resources, tools, evaluator or oracle, and cannot certify success.".into(),
        input:vec![json!({"role":"user","content":[{"type":"input_text","text":serde_json::to_string(&json!({"intent_sha256":intent.sha()?,"objective":p.objective,"baseline_source_utf8":source,"plugin_contract":intent.plugin_manifest,"development_examples":development}))?}]})],
        tools:vec![ToolDefinition{name:"submit_python_candidate".into(),description:"Submit bounded replacement source or stop; host evaluation independently measures it.".into(),parameters:json!({"type":"object","oneOf":[{"type":"object","additionalProperties":false,"required":["action","source_utf8","rationale"],"properties":{"action":{"const":"propose"},"source_utf8":{"type":"string","minLength":1,"maxLength":32768},"rationale":{"type":"string","minLength":1,"maxLength":4096}}},{"type":"object","additionalProperties":false,"required":["action","reason"],"properties":{"action":{"const":"stop"},"reason":{"type":"string","minLength":1,"maxLength":4096}}}]})}],
        max_output_tokens:p.max_output_tokens,
    };
    if serde_json::to_vec(&request)?.len() > 256 * 1024 {
        return Err(invalid("Python proposer request exceeds bound"));
    }
    Ok(request)
}
pub(super) fn request_sha(request: &ResponsesRequest) -> Result<String> {
    Ok(digest(&serde_json::to_vec(&serde_json::to_value(
        request,
    )?)?))
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PythonEvolutionInspection {
    pub schema_version: u32,
    pub qualification: String,
    pub intent_sha256: String,
    pub request_sha256: String,
    pub suite_sha256: String,
    pub session_id: String,
    pub command_id: String,
    pub phase: String,
    pub operation_id: Option<String>,
    pub candidate: Option<String>,
    pub source_sha256: Option<String>,
    pub exposure: Option<zero_store::PythonHoldoutReceipt>,
    pub evaluation: Option<crate::Inspection>,
}
