use crate::{PythonEvolutionPlan, PythonProposalContext, Result, digest, invalid};
use serde::{Deserialize, Serialize};
use zero_protocol::model::ResponsesRequest;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PythonSearchPlan {
    pub schema_version: u32,
    pub proposal: PythonEvolutionPlan,
    pub max_rounds: usize,
    pub max_proposal_spend: u64,
    pub max_development_attempts: usize,
}
impl PythonSearchPlan {
    pub fn validate(&self) -> Result<()> {
        self.proposal.validate()?;
        if self.schema_version != 1
            || !(2..=16).contains(&self.max_rounds)
            || self.max_proposal_spend < self.proposal.reservation
            || !(1..=1536).contains(&self.max_development_attempts)
        {
            return Err(invalid("Python search host limits"));
        }
        let development = self
            .proposal
            .cases
            .iter()
            .filter(|c| c.lane == crate::Lane::Development)
            .count()
            * self.proposal.repeats;
        if development > self.max_development_attempts {
            return Err(invalid(
                "Python search cannot fit one Development experiment",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Intent {
    pub schema_version: u32,
    pub id: String,
    pub root: std::path::PathBuf,
    pub context: PythonProposalContext,
    pub plan: PythonSearchPlan,
    pub baseline: zero_evolution::Manifest,
    pub plugin: zero_plugin::Manifest,
}
impl Intent {
    pub fn sha(&self) -> Result<String> {
        Ok(digest(&serde_json::to_vec(self)?))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DevelopmentFeedback {
    pub source_sha256: String,
    pub attempted: usize,
    pub settled: usize,
    pub solved: usize,
    pub completed: bool,
    pub cases: Vec<DevelopmentCaseFeedback>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DevelopmentCaseFeedback {
    pub case_id: String,
    pub repeat: usize,
    pub solved: bool,
    pub error: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Experiment {
    pub source_utf8: String,
    pub rationale: String,
}
pub enum SearchStep {
    Experiment {
        round: usize,
    },
    Selected {
        claim: zero_store::PythonHoldoutClaim,
    },
    Stop,
}
#[derive(Serialize)]
pub struct PythonSearchInspection {
    pub schema_version: u32,
    pub qualification: &'static str,
    pub intent_sha256: String,
    pub phase: String,
    pub charged: u64,
    pub session_budget: zero_protocol::session::BudgetSnapshot,
    pub rounds: usize,
    pub development_attempts: usize,
    pub feedback: Vec<DevelopmentFeedback>,
    pub evaluation: Option<crate::Inspection>,
}
pub(super) fn request_sha(request: &ResponsesRequest) -> Result<String> {
    Ok(digest(&serde_json::to_vec(&serde_json::to_value(
        request,
    )?)?))
}
