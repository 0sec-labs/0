//! Shared exact-response matrix grammar; it does not invent a review or origin.
use crate::{
    Result, invalid,
    plan::{digest, hash, id},
};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use zero_protocol::web::WebCaseRole;
use zero_protocol::{
    http::{HttpProfilePolicy, HttpRequestArguments, HttpRequestIntent},
    web::WebVerificationCase,
};
pub(crate) fn profile(session: &str, context: &Value) -> Result<HttpProfilePolicy> {
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
    if *context != expected {
        return Err(invalid("HTTP authority/account identity differs"));
    }
    Ok(profile)
}
pub(crate) fn normalize_cases(
    profile: &HttpProfilePolicy,
    cases: &mut [WebVerificationCase],
    repeats: u32,
) -> Result<()> {
    if !(2..=3).contains(&repeats) || !(2..=8).contains(&cases.len()) {
        return Err(invalid("invalid matrix bounds"));
    }
    let mut names = BTreeSet::new();
    let mut attacks = BTreeSet::new();
    let mut controls = BTreeSet::new();
    for case in cases {
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
            zero_http::normalize_intent(profile, case.request.clone()).map_err(invalid)?;
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
    if attacks.is_empty() || controls.is_empty() || attacks.iter().any(|r| controls.contains(r)) {
        return Err(invalid(
            "web plan needs distinct attack and legitimate control requests",
        ));
    }
    Ok(())
}
pub(crate) mod sealed {
    pub trait Sealed {}
}
/// Only fully frozen supported origins can enter the shared scorer.
pub trait ObservationMatrix: sealed::Sealed {
    fn cases(&self) -> &[WebVerificationCase];
    fn repeats(&self) -> u32;
    fn matrix_sha256(&self) -> &str;
    fn request(&self, index: usize, repeat: u32) -> Result<HttpRequestIntent>;
    fn request_sha256(&self, index: usize, repeat: u32) -> Result<String> {
        hash(&self.request(index, repeat)?)
    }
}
impl sealed::Sealed for crate::FrozenPlan {}
impl ObservationMatrix for crate::FrozenPlan {
    fn cases(&self) -> &[WebVerificationCase] {
        &self.plan().cases
    }
    fn repeats(&self) -> u32 {
        self.plan().repeats
    }
    fn matrix_sha256(&self) -> &str {
        self.plan_sha256()
    }
    fn request(&self, index: usize, repeat: u32) -> Result<HttpRequestIntent> {
        self.request(index, repeat)
    }
}
