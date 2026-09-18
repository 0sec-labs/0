//! Observation-only campaign inspection, including while the execution owner is live.
use crate::EngineError;
use std::path::Path;
use zero_protocol::campaign::{CampaignRunPage, CampaignSnapshot};
use zero_store::Store;

pub fn read_campaign_status(path: &Path, campaign: &str) -> Result<CampaignSnapshot, EngineError> {
    Ok(Store::open_read_only(path)?.campaign(campaign)?)
}

pub fn read_campaign_runs(
    path: &Path,
    campaign: &str,
    after_sequence: u64,
    limit: u32,
) -> Result<CampaignRunPage, EngineError> {
    Ok(Store::open_read_only(path)?.campaign_runs(campaign, after_sequence, limit)?)
}
