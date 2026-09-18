use crate::{Result, invalid};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use zero_protocol::{
    approvals::ToolApprovalPolicy,
    http::{HttpProfilePolicy, HttpRequestIntent},
    web::WebVerificationPlan,
};
pub const ORACLE_VERSION: &str = "zero-web-exact-response-v1";
const MAX_PLAN: usize = 4 * 1024 * 1024;
const MAX_INTENT: usize = 8 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    schema_version: u32,
    session_id: String,
    plan: WebVerificationPlan,
    http_context: Value,
    inherited_tool_approval_policy: Option<ToolApprovalPolicy>,
}
#[derive(Clone)]
pub struct FrozenPlan {
    plan: WebVerificationPlan,
    profile: HttpProfilePolicy,
    intent: Value,
    intent_sha256: String,
    plan_sha256: String,
    approval_required: bool,
}
pub fn hash(value: &impl Serialize) -> Result<String> {
    let value = serde_json::to_value(value).map_err(invalid)?;
    let bytes = serde_json::to_vec(&value).map_err(invalid)?;
    if bytes.len() > MAX_INTENT {
        return Err(invalid("web identity exceeds byte bound"));
    }
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}
pub(crate) fn digest(s: &str) -> bool {
    s.strip_prefix("sha256:").is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub(crate) fn id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
}
impl FrozenPlan {
    pub fn new(
        session: &str,
        mut plan: WebVerificationPlan,
        context: Value,
        approval: Option<ToolApprovalPolicy>,
    ) -> Result<Self> {
        if !id(session)
            || plan.schema_version != 1
            || plan.oracle_version != ORACLE_VERSION
            || !id(&plan.web_operation_id)
            || !digest(&plan.web_review_sha256)
            || !id(&plan.hypothesis_id)
            || !(2..=3).contains(&plan.repeats)
            || !(2..=8).contains(&plan.cases.len())
        {
            return Err(invalid("invalid frozen web plan identity or matrix bounds"));
        }
        if serde_json::to_vec(&plan).map_err(invalid)?.len() > MAX_PLAN {
            return Err(invalid("web plan exceeds4MiB bound"));
        }
        let profile = crate::matrix::profile(session, &context)?;
        if let Some(policy) = &approval {
            policy.validate().map_err(invalid)?;
        }
        let approval_required = approval
            .as_ref()
            .is_some_and(|p| p.require_approval.iter().any(|s| s == "http_request"));
        crate::matrix::normalize_cases(&profile, &mut plan.cases, plan.repeats)?;
        if serde_json::to_vec(&plan).map_err(invalid)?.len() > MAX_PLAN {
            return Err(invalid("normalized web plan exceeds4MiB"));
        }
        let plan_sha256 = hash(&plan)?;
        let envelope = Envelope {
            schema_version: 1,
            session_id: session.into(),
            plan: plan.clone(),
            http_context: context,
            inherited_tool_approval_policy: approval,
        };
        let intent = serde_json::to_value(envelope).map_err(invalid)?;
        let intent_sha256 = hash(&intent)?;
        Ok(Self {
            plan,
            profile,
            intent,
            intent_sha256,
            plan_sha256,
            approval_required,
        })
    }
    pub fn from_intent(value: &Value) -> Result<Self> {
        if serde_json::to_vec(value).map_err(invalid)?.len() > MAX_INTENT {
            return Err(invalid("web execution intent exceeds8MiB"));
        }
        let envelope: Envelope = serde_json::from_value(value.clone()).map_err(invalid)?;
        if envelope.schema_version != 1 {
            return Err(invalid("unsupported web intent schema"));
        }
        let frozen = Self::new(
            &envelope.session_id,
            envelope.plan,
            envelope.http_context,
            envelope.inherited_tool_approval_policy,
        )?;
        if frozen.intent != *value {
            return Err(invalid("web execution intent is not canonical"));
        }
        Ok(frozen)
    }
    pub fn intent(&self) -> &Value {
        &self.intent
    }
    pub fn intent_sha256(&self) -> &str {
        &self.intent_sha256
    }
    pub fn plan_sha256(&self) -> &str {
        &self.plan_sha256
    }
    pub fn plan(&self) -> &WebVerificationPlan {
        &self.plan
    }
    pub fn approval_required(&self) -> bool {
        self.approval_required
    }
    pub fn request(&self, index: usize, repeat: u32) -> Result<HttpRequestIntent> {
        if repeat >= self.plan.repeats {
            return Err(invalid("web repeat outside frozen matrix"));
        }
        let case = self
            .plan
            .cases
            .get(index)
            .ok_or_else(|| invalid("web case outside frozen matrix"))?;
        zero_http::normalize_intent(&self.profile, case.request.clone()).map_err(invalid)
    }
    pub fn request_sha256(&self, index: usize, repeat: u32) -> Result<String> {
        hash(&self.request(index, repeat)?)
    }
}
