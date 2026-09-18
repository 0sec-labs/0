use crate::{Result, invalid};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use zero_plugin_runner::Launch;
use zero_protocol::sandbox::{SandboxBackend, SandboxResult};
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
    Development,
    HeldOut,
    NegativeControl,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Case {
    pub id: String,
    pub lane: Lane,
    pub input: Value,
    pub expected: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScoringPolicy {
    pub minimum_cases_per_lane: usize,
    /// Absolute number of additional solved distinct cases, not repeated samples.
    pub minimum_development_gain: usize,
    pub minimum_held_out_gain: usize,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub baseline: String,
    pub candidate: String,
    pub evaluator_artifact: String,
    pub engine_artifact: String,
    pub host_policy_artifact: String,
    pub plugin: String,
    pub tool: String,
    pub launch: Launch,
    pub cases: Vec<Case>,
    pub repeats: usize,
    /// Fixed execution slots reserved before dispatch; not dollars/provider usage.
    pub attempt_budget: usize,
    pub scoring: ScoringPolicy,
}
impl Plan {
    pub fn validate(&self) -> Result<()> {
        self.launch
            .validate()
            .map_err(|e| invalid(&e.to_string()))?;
        if self.scoring.minimum_development_gain > 96 || self.scoring.minimum_held_out_gain > 96 {
            return Err(invalid("scoring gain exceeds case bound"));
        }
        if self.baseline == self.candidate
            || !(2..=8).contains(&self.repeats)
            || self.cases.len() > 96
            || self.scoring.minimum_cases_per_lane == 0
            || self.plugin.is_empty()
            || self.tool.is_empty()
        {
            return Err(invalid("invalid identities, repeats or case bounds"));
        }
        for id in [
            &self.baseline,
            &self.candidate,
            &self.evaluator_artifact,
            &self.engine_artifact,
            &self.host_policy_artifact,
        ] {
            if !sha(id) {
                return Err(invalid("identity must be sha256 digest"));
            }
        }
        match &self.launch.backend {
            SandboxBackend::Docker { image } if sha(image) => {}
            SandboxBackend::Smolvm { archive_digest, .. } if sha(archive_digest) => {}
            _ => return Err(invalid("immutable backend identity required")),
        }
        if self.launch.timeout_ms > 60_000
            || self.launch.timeout_ms < 100
            || !(256..=64 * 1024).contains(&self.launch.max_output_bytes)
        {
            return Err(invalid("evaluation launch bounds"));
        }
        let count = self.cases.len() * self.repeats * 2;
        if self.attempt_budget < count
            || self.attempt_budget > 1536
            || count * self.launch.max_output_bytes * 2 > 16 * 1024 * 1024
            || serde_json::to_vec(self)?.len() > 1024 * 1024
        {
            return Err(invalid("evaluation budget or retained evidence limit"));
        }
        let mut ids = BTreeSet::new();
        let mut inputs = BTreeSet::new();
        for case in &self.cases {
            if case.id.is_empty()
                || case.id.len() > 128
                || !ids.insert(&case.id)
                || !inputs.insert(serde_json::to_vec(&case.input)?)
            {
                return Err(invalid("duplicate case IDs/inputs or invalid ID"));
            }
        }
        for lane in [Lane::Development, Lane::HeldOut, Lane::NegativeControl] {
            if self.cases.iter().filter(|c| c.lane == lane).count()
                < self.scoring.minimum_cases_per_lane
            {
                return Err(invalid("insufficient distinct cases in each lane"));
            }
        }
        Ok(())
    }
}
fn sha(s: &str) -> bool {
    s.len() == 71
        && s.starts_with("sha256:")
        && s[7..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Variant {
    Baseline,
    Candidate,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attempt {
    pub index: usize,
    pub variant: Variant,
    pub case_id: String,
    pub repeat: usize,
    pub state: String,
    /// Controller epoch which admitted the attempt; retained across restart.
    pub owner: Option<String>,
    pub lease_id: Option<String>,
    pub staging: Option<String>,
    pub execution_id: Option<String>,
    pub request_digest: Option<String>,
    pub sandbox: Option<SandboxResult>,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub settled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    pub schema_version: u32,
    pub baseline: String,
    pub candidate: String,
    pub engine_artifact: String,
    pub run_id: String,
    pub plan_digest: String,
    pub scoring_policy_digest: String,
    pub host_policy_artifact: String,
    pub evaluator_artifact: String,
    pub decision: zero_evolution::EvaluationDecision,
    pub qualification: String,
    pub reasons: Vec<String>,
    pub attempted: usize,
    pub settled: usize,
    pub reserved_slots: usize,
    pub evidence_digest: String,
    pub receipt_digest: String,
}
