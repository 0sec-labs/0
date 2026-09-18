//! Model predictions frozen under host authority; matching is not security truth.
use crate::plan::id;
use crate::{ORACLE_VERSION, ObservationMatrix, Result, hash, invalid};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zero_protocol::{
    approvals::ToolApprovalPolicy,
    http::{HttpProfilePolicy, HttpRequestIntent},
    web::{WebStateMode, WebVerificationCase},
    web_experiment::*,
};
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    schema_version: u32,
    origin: String,
    session_id: String,
    actor_operation_id: String,
    inference_operation_id: String,
    call_id: String,
    policy: WebExperimentPolicy,
    proposal: WebExperimentProposal,
    oracle_version: String,
    state_mode: WebStateMode,
    http_context: Value,
    inherited_tool_approval_policy: Option<ToolApprovalPolicy>,
    hypothesis: WebHypothesisRevision,
    matrix_sha256: String,
}
#[derive(Clone)]
pub struct FrozenExperiment {
    envelope: Envelope,
    profile: HttpProfilePolicy,
    intent: Value,
    digest: String,
    approval_required: bool,
}
impl FrozenExperiment {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        session: &str,
        actor: &str,
        inference: &str,
        call: &str,
        policy: WebExperimentPolicy,
        mut proposal: WebExperimentProposal,
        http_context: Value,
        approval: Option<ToolApprovalPolicy>,
    ) -> Result<Self> {
        if [session, actor, inference, call].iter().any(|v| !id(v)) {
            return Err(invalid("invalid experiment origin identity"));
        }
        policy.validate().map_err(invalid)?;
        proposal.validate().map_err(invalid)?;
        if proposal.cases.len() > policy.max_cases as usize || proposal.repeats > policy.max_repeats
        {
            return Err(invalid("experiment exceeds captured host policy"));
        }
        if serde_json::to_vec(&proposal).map_err(invalid)?.len() > 4 * 1024 * 1024 {
            return Err(invalid("experiment proposal exceeds4MiB"));
        }
        let profile = crate::matrix::profile(session, &http_context)?;
        crate::matrix::normalize_cases(&profile, &mut proposal.cases, proposal.repeats)?;
        if let Some(p) = &approval {
            p.validate().map_err(invalid)?;
        }
        let approval_required = approval.as_ref().is_some_and(|p| {
            p.require_approval
                .iter()
                .any(|n| n == "http_request" || n == "run_web_experiment")
        });
        let hypothesis_sha256 = hash(
            &json!({"schema_version":1,"session_id":session,"actor_operation_id":actor,"inference_operation_id":inference,"call_id":call,"hypothesis":proposal.hypothesis}),
        )?;
        let hypothesis = WebHypothesisRevision {
            hypothesis_sha256,
            title: proposal.hypothesis.title.clone(),
            explanation: proposal.hypothesis.explanation.clone(),
            prior_revision: proposal.hypothesis.prior_revision.clone(),
        };
        let state_mode = WebStateMode::SameStaticIdentityExistingTarget;
        let matrix_sha256 = hash(
            &json!({"schema_version":1,"oracle_version":ORACLE_VERSION,"state_mode":state_mode,"cases":proposal.cases,"repeats":proposal.repeats}),
        )?;
        let envelope = Envelope {
            schema_version: 1,
            origin: "agent_web_experiment".into(),
            session_id: session.into(),
            actor_operation_id: actor.into(),
            inference_operation_id: inference.into(),
            call_id: call.into(),
            policy,
            proposal,
            oracle_version: ORACLE_VERSION.into(),
            state_mode,
            http_context,
            inherited_tool_approval_policy: approval,
            hypothesis,
            matrix_sha256,
        };
        let intent = serde_json::to_value(&envelope).map_err(invalid)?;
        let digest = hash(&intent)?;
        let frozen = Self {
            envelope,
            profile,
            intent,
            digest,
            approval_required,
        };
        // Approval adds a UUID link to this effect. Reserve that space before effects.
        let placeholder = format!("sha256:{}", "0".repeat(64));
        let mut payload = frozen.parent_payload(&placeholder, &placeholder, &placeholder)?;
        payload["approval_operation"] = json!("00000000-0000-0000-0000-000000000000");
        if serde_json::to_vec(&payload).map_err(invalid)?.len() > 4 * 1024 * 1024 {
            return Err(invalid("experiment effect exceeds owned-admission bound"));
        }
        for index in 0..frozen.cases().len() {
            let payload = frozen.child_payload(
                "00000000-0000-0000-0000-000000000000",
                index,
                frozen.repeats() - 1,
            )?;
            if serde_json::to_vec(&payload).map_err(invalid)?.len() > 4 * 1024 * 1024 {
                return Err(invalid(
                    "experiment HTTP child exceeds owned-admission bound",
                ));
            }
        }
        Ok(frozen)
    }
    pub fn from_intent(intent: &Value) -> Result<Self> {
        if serde_json::to_vec(intent).map_err(invalid)?.len() > 4 * 1024 * 1024 {
            return Err(invalid("experiment intent exceeds bound"));
        }
        let e: Envelope = serde_json::from_value(intent.clone()).map_err(invalid)?;
        let frozen = Self::new(
            &e.session_id,
            &e.actor_operation_id,
            &e.inference_operation_id,
            &e.call_id,
            e.policy,
            e.proposal,
            e.http_context,
            e.inherited_tool_approval_policy,
        )?;
        if frozen.intent != *intent {
            return Err(invalid("experiment intent is not canonical"));
        }
        Ok(frozen)
    }
    pub fn intent(&self) -> &Value {
        &self.intent
    }
    pub fn intent_sha256(&self) -> &str {
        &self.digest
    }
    pub fn matrix_sha256(&self) -> &str {
        &self.envelope.matrix_sha256
    }
    pub fn hypothesis(&self) -> &WebHypothesisRevision {
        &self.envelope.hypothesis
    }
    pub fn hypothesis_sha256(&self) -> &str {
        &self.envelope.hypothesis.hypothesis_sha256
    }
    pub fn proposal(&self) -> &WebExperimentProposal {
        &self.envelope.proposal
    }
    pub fn policy(&self) -> &WebExperimentPolicy {
        &self.envelope.policy
    }
    pub fn approval_required(&self) -> bool {
        self.approval_required
    }
    pub fn cases(&self) -> &[WebVerificationCase] {
        &self.envelope.proposal.cases
    }
    pub fn repeats(&self) -> u32 {
        self.envelope.proposal.repeats
    }
    pub fn request(&self, index: usize, repeat: u32) -> Result<HttpRequestIntent> {
        if repeat >= self.repeats() {
            return Err(invalid("experiment repeat outside matrix"));
        }
        let case = self
            .cases()
            .get(index)
            .ok_or_else(|| invalid("experiment case outside matrix"))?;
        zero_http::normalize_intent(&self.profile, case.request.clone()).map_err(invalid)
    }
    pub fn request_sha256(&self, index: usize, repeat: u32) -> Result<String> {
        hash(&self.request(index, repeat)?)
    }
    pub fn parent_payload(
        &self,
        actor_sha: &str,
        inference_sha: &str,
        outcome_sha: &str,
    ) -> Result<Value> {
        if [actor_sha, inference_sha, outcome_sha]
            .iter()
            .any(|s| !crate::plan::digest(s))
        {
            return Err(invalid("experiment original operation hash malformed"));
        }
        Ok(
            json!({"kind":"agent_web_experiment","parent_operation":self.envelope.actor_operation_id,"call_id":self.envelope.call_id,"origin_inference_id":self.envelope.inference_operation_id,"http_context":self.envelope.http_context,"http_output_version":2,"execution_intent":self.intent,"intent_sha256":self.digest,"matrix_sha256":self.envelope.matrix_sha256,"hypothesis_sha256":self.envelope.hypothesis.hypothesis_sha256,"actor_payload_sha256":actor_sha,"origin_payload_sha256":inference_sha,"origin_outcome_sha256":outcome_sha}),
        )
    }
    pub fn child_payload(&self, parent: &str, index: usize, repeat: u32) -> Result<Value> {
        let request = self.request(index, repeat)?;
        let case = &self.cases()[index];
        Ok(
            json!({"kind":"agent_http","parent_operation":parent,"origin":{"kind":"frozen_agent_experiment","intent_sha256":self.digest,"case_index":index,"case_name":case.name,"repeat_index":repeat},"http_context":self.envelope.http_context,"http_output_version":2,"request":request}),
        )
    }
}
impl crate::matrix::sealed::Sealed for FrozenExperiment {}
impl ObservationMatrix for FrozenExperiment {
    fn cases(&self) -> &[WebVerificationCase] {
        self.cases()
    }
    fn repeats(&self) -> u32 {
        self.repeats()
    }
    fn matrix_sha256(&self) -> &str {
        self.matrix_sha256()
    }
    fn request(&self, index: usize, repeat: u32) -> Result<HttpRequestIntent> {
        self.request(index, repeat)
    }
}
