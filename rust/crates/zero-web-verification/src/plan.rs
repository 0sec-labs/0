use crate::{Result, invalid};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use zero_protocol::{
    approvals::ToolApprovalPolicy,
    http::{HttpProfilePolicy, HttpRequestArguments, HttpRequestIntent},
    web::{WebCaseRole, WebVerificationPlan},
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
fn id(s: &str) -> bool {
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
        let profile: HttpProfilePolicy =
            serde_json::from_value(context["profile"].clone()).map_err(invalid)?;
        let profile = zero_http::normalize_policy(profile).map_err(invalid)?;
        let profile_sha256 = hash(&profile)?;
        let name = context["profile_name"]
            .as_str()
            .filter(|v| id(v))
            .ok_or_else(|| invalid("HTTP profile name missing"))?;
        let command = context["original_root_command"]
            .as_str()
            .filter(|v| id(v))
            .ok_or_else(|| invalid("HTTP root command missing"))?;
        let expected = json!({"schema_version":1,"profile_name":name,"profile":profile,"profile_sha256":profile_sha256,"account_id":hash(&json!({"session_id":session,"original_root_command":command,"profile_sha256":profile_sha256}))?,"original_root_command":command});
        if context != expected {
            return Err(invalid("HTTP authority/account identity differs"));
        }
        if let Some(policy) = &approval {
            policy.validate().map_err(invalid)?;
        }
        let approval_required = approval
            .as_ref()
            .is_some_and(|p| p.require_approval.iter().any(|s| s == "http_request"));
        let mut names = BTreeSet::new();
        let mut attacks = BTreeSet::new();
        let mut controls = BTreeSet::new();
        for case in &mut plan.cases {
            if case.name.is_empty()
                || case.name.len() > 64
                || !case
                    .name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                || !names.insert(case.name.clone())
                || !(100..=599).contains(&case.expected.status)
                || !digest(&case.expected.body_sha256)
            {
                return Err(invalid("invalid web case identity or expected response"));
            }
            let request =
                zero_http::normalize_intent(&profile, case.request.clone()).map_err(invalid)?;
            case.request = HttpRequestArguments {
                url: request.url.clone(),
                method: request.method.clone(),
                headers: case
                    .request
                    .headers
                    .iter()
                    .map(|(name, value)| (name.to_ascii_lowercase(), value.clone()))
                    .collect(),
                body: request.body.clone(),
            };
            match case.role {
                WebCaseRole::Attack => {
                    attacks.insert(hash(&request)?);
                }
                WebCaseRole::LegitimateControl => {
                    controls.insert(hash(&request)?);
                }
            }
        }
        if attacks.is_empty() || controls.is_empty() || attacks.iter().any(|r| controls.contains(r))
        {
            return Err(invalid(
                "web plan needs distinct attack and legitimate control requests",
            ));
        }
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
