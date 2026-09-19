use super::*;
use sha2::{Digest, Sha256};
use zero_protocol::{
    model::{Completion, CompletionStatus, Content, ResponsesRequest},
    strategy::StrategyArtifact,
    strategy_search::*,
};
mod evaluations;
mod proposals;
mod selection;
pub(super) use evaluations::validate_run;
pub(super) use proposals::{
    authorize_proposal_session, proposal_binding, reserve_model, settle_model,
};
fn artifact(conn: &Connection, digest: &str, max: usize) -> Result<Vec<u8>> {
    let size: usize = conn.query_row(
        "SELECT length(bytes) FROM artifacts WHERE digest=?1",
        [digest],
        |r| r.get(0),
    )?;
    if size > max {
        return Err(bad("search artifact exceeds bound"));
    }
    crate::artifacts::read(conn, digest)
}
fn encode<T: serde::Serialize>(v: &T) -> Result<String> {
    Ok(serde_json::to_string(&serde_json::to_value(v)?)?)
}
fn config_validate(config: &StrategySearchConfiguration) -> Result<()> {
    config.plan.validate().map_err(|e| bad(&e.to_string()))?;
    config
        .capture
        .authority
        .validate()
        .map_err(|e| bad(&e.to_string()))?;
    config
        .capture
        .advisory
        .validate()
        .map_err(|e| bad(&e.to_string()))?;
    let capture = &config.capture;
    if capture.registry.schema_version != 1
        || uuid::Uuid::parse_str(&capture.registry.registry_id).is_err()
        || capture.epoch == 0
        || [
            &capture.registry.genesis_sha256,
            &capture.generation,
            &capture.state_sha256,
            &capture.advisory_sha256,
            &capture.host_policy_sha256,
        ]
        .iter()
        .any(|d| !zero_protocol::is_sha256(d))
    {
        return Err(bad("search capture identity is invalid"));
    }
    if config.kind != "strategy_search"
        || config.schema_version != config.plan.schema_version
        || hash(&serde_json::to_value(&config.capture.advisory)?)? != config.capture.advisory_sha256
        || config.plan.minimum_development_gain < config.capture.authority.minimum_development_gain
    {
        return Err(bad("search captured authority differs"));
    }
    for policy in config
        .plan
        .protected_final
        .iter()
        .chain(config.plan.protected_canary.iter())
    {
        if policy.minimum_gain < config.capture.authority.minimum_final_gain
            || !config
                .capture
                .authority
                .accepted_suite_sha256
                .contains(&hash(&search_final_suite_value(policy))?)
        {
            return Err(bad("protected search suite or minimum is not authorized"));
        }
    }
    let limits = serde_json::to_value(&config.plan.limits)?;
    let maximum = serde_json::to_value(&config.capture.authority.campaign_limits)?;
    if limits.as_object().is_none_or(|m| {
        m.iter().any(|(k, v)| {
            v.as_u64()
                .zip(maximum[k].as_u64())
                .is_none_or(|(a, b)| a > b)
        })
    }) {
        return Err(bad("search exceeds captured aggregate authority"));
    }
    if config.proposer_context.endpoint.is_empty() || config.proposer_context.endpoint.len() > 8192
    {
        return Err(bad("search proposer route invalid"));
    }
    for s in config.plan.scenarios.iter().chain(
        config
            .plan
            .protected_final
            .iter()
            .flat_map(|p| &p.scenarios)
            .chain(
                config
                    .plan
                    .protected_canary
                    .iter()
                    .flat_map(|p| &p.scenarios),
            ),
    ) {
        if config.capture.advisory.advisory_utf8.contains(&s.marker)
            || config
                .capture
                .authority
                .host
                .instructions
                .contains(&s.marker)
        {
            return Err(bad("private marker appears in captured public inputs"));
        }
    }
    Ok(())
}
pub(super) fn created(tx: &Transaction<'_>, c: &Campaign, bytes: &[u8]) -> Result<()> {
    let value: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
    if value["kind"] != "strategy_search" {
        return Ok(());
    }
    let config: StrategySearchConfiguration = serde_json::from_value(value)?;
    config_validate(&config)?;
    if c.plan.baseline_sha256 != config.capture.advisory_sha256
        || c.plan.limits != config.plan.limits
        || c.plan.expires_at_ms != config.plan.expires_at_ms
    {
        return Err(bad("search account plan differs"));
    }
    let seq = next(tx, &c.journal_session_id)?;
    tx.execute(
        "INSERT INTO strategy_searches VALUES(?1,?2,?3)",
        params![c.id, c.plan.controller_plan_sha256, integer(seq)?],
    )?;
    append(
        tx,
        &c.journal_session_id,
        "strategy_search_created",
        &json!({"campaign_id":c.id,"config_sha256":c.plan.controller_plan_sha256}),
    )?;
    Ok(())
}
fn configuration(conn: &Connection, c: &Campaign) -> Result<Option<StrategySearchConfiguration>> {
    let bytes = artifact(conn, &c.plan.controller_plan_sha256, 2 * 1024 * 1024)?;
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let row:Option<(String,u64)>=conn.query_row("SELECT CASE WHEN length(CAST(config_sha256 AS BLOB))=71 THEN config_sha256 END,sequence FROM strategy_searches WHERE campaign_id=?1",[&c.id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let count: u64 = conn.query_row(
        "SELECT count(*) FROM events WHERE session_id=?1 AND kind='strategy_search_created'",
        [&c.journal_session_id],
        |r| r.get(0),
    )?;
    if value["kind"] != "strategy_search" {
        if row.is_some() || count != 0 {
            return Err(bad("search mode differs from creation artifact"));
        }
        return Ok(None);
    }
    let (digest, seq) = row.ok_or_else(|| bad("search projection absent"))?;
    if digest != c.plan.controller_plan_sha256 || count != 1 {
        return Err(bad("search configuration projection differs"));
    }
    event(
        conn,
        &c.journal_session_id,
        seq,
        "strategy_search_created",
        &json!({"campaign_id":c.id,"config_sha256":digest}),
    )?;
    let config: StrategySearchConfiguration = serde_json::from_value(value)?;
    config_validate(&config)?;
    selection::check_exposure(conn, c, &config)?;
    Ok(Some(config))
}
fn required(conn: &Connection, c: &Campaign) -> Result<StrategySearchConfiguration> {
    configuration(conn, c)?.ok_or_else(|| bad("campaign is not a strategy search"))
}
pub(super) fn authorize_controller(
    conn: &Connection,
    c: &Campaign,
    command: &str,
    payload: &Value,
) -> Result<bool> {
    if configuration(conn, c)?.is_none() {
        return Ok(false);
    }
    if command != format!("strategy-search:{}", c.id)
        || *payload
            != json!({"kind":"strategy_search","campaign_id":c.id,"controller_plan_sha256":c.plan.controller_plan_sha256})
    {
        return Err(bad("search journal permits exact owned controller only"));
    }
    Ok(true)
}
impl Store {
    pub fn create_strategy_search(
        &mut self,
        command: &str,
        config: &StrategySearchConfiguration,
    ) -> Result<(Campaign, bool)> {
        config_validate(config)?;
        let bytes = encode(config)?.into_bytes();
        let plan = CampaignPlan {
            schema_version: 1,
            controller_plan_sha256: hash(&serde_json::to_value(config)?)?,
            baseline_sha256: config.capture.advisory_sha256.clone(),
            limits: config.plan.limits.clone(),
            expires_at_ms: config.plan.expires_at_ms,
        };
        self.create_campaign_with_artifact(command, &plan, &bytes)
    }
    pub fn search_configuration(&self, campaign: &str) -> Result<StrategySearchConfiguration> {
        let tx = self.conn.unchecked_transaction()?;
        required(&tx, &original(&tx, campaign)?)
    }
    pub fn search_snapshot(&self, campaign: &str) -> Result<SearchSnapshot> {
        let tx = self.conn.unchecked_transaction()?;
        let c = original(&tx, campaign)?;
        required(&tx, &c)?;
        let p = proposals::list(&tx, &c)?;
        let e = evaluations::list(&tx, &c)?;
        Ok(SearchSnapshot {
            campaign: read::snapshot(&tx, campaign)?,
            proposal_attempts: p.len() as u32,
            candidates: e.len() as u32,
            active_proposals: p
                .iter()
                .filter(|(_, o)| {
                    matches!(
                        o.status,
                        OperationStatus::Admitted | OperationStatus::Running
                    )
                })
                .count() as u32,
            unknown_proposals: p
                .iter()
                .filter(|(_, o)| o.status == OperationStatus::Unknown)
                .count() as u32,
        })
    }
}
impl Store {
    /// Preflight the Store-side materializations used by a complete search report.
    /// The caller separately charges event pages, HTTP/artifact evidence and final output.
    pub fn search_evidence_preflight(&self, campaign: &str, budget: &mut usize) -> Result<()> {
        id(campaign)?;
        let tx = self.conn.unchecked_transaction()?;
        let config_bytes:u64=tx.query_row("SELECT length(a.bytes) FROM strategy_searches s JOIN artifacts a ON a.digest=s.config_sha256 WHERE s.campaign_id=?1",[campaign],|r|r.get(0))?;
        let (proposals,proposal_bytes):(u64,u64)=tx.query_row("SELECT count(*),COALESCE(sum(length(CAST(p.record AS BLOB))+length(CAST(o.payload AS BLOB))+COALESCE(length(CAST(o.outcome AS BLOB)),0)),0) FROM strategy_search_proposals p JOIN operations o ON o.id=p.operation_id WHERE p.campaign_id=?1",[campaign],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let events:u64=tx.query_row("SELECT COALESCE(sum(length(CAST(e.payload AS BLOB))),0) FROM events e JOIN strategy_search_proposals p ON p.session_id=e.session_id WHERE p.campaign_id=?1",[campaign],|r|r.get(0))?;
        let (runs,run_bytes):(u64,u64)=tx.query_row("SELECT count(*),COALESCE(sum(length(CAST(record AS BLOB))),0) FROM campaign_runs WHERE campaign_id=?1",[campaign],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let (evaluations,evaluation_bytes):(u64,u64)=tx.query_row("SELECT count(*),COALESCE(sum(length(CAST(record AS BLOB))),0) FROM strategy_search_evaluations WHERE campaign_id=?1",[campaign],|r|Ok((r.get(0)?,r.get(1)?)))?;
        if config_bytes > 2 * 1024 * 1024 || proposals > 16 || runs > 128 || evaluations > 16 {
            return Err(bad("search evidence count or configuration bound"));
        }
        let selection_bytes: u64 = tx.query_row("SELECT COALESCE(sum(length(CAST(record AS BLOB))),0) FROM strategy_search_selections WHERE campaign_id=?1", [campaign], |r| r.get(0))?;
        let matrix_bytes: u64 = tx.query_row("SELECT COALESCE(sum(length(a.bytes)),0) FROM strategy_search_selections s JOIN artifacts a ON a.digest=CASE WHEN length(CAST(s.record AS BLOB))<=65536 THEN json_extract(s.record,'$.development_matrix_sha256') END WHERE s.campaign_id=?1", [campaign], |r| r.get(0))?;
        if selection_bytes > 65536 || matrix_bytes > 1024 * 1024 {
            return Err(bad("selection evidence exceeds bound"));
        }
        // Full selection proof adds one proposal/evaluation verification pass.
        // Configuration reads also validate the compact selection/exposure pair;
        // charge those repeated reads without reloading every matrix per run.
        let selected_charge = if selection_bytes == 0 {
            0
        } else {
            proposal_bytes
                .checked_add(events)
                .and_then(|n| n.checked_add(evaluation_bytes))
                .and_then(|n| n.checked_add(config_bytes.saturating_mul(proposals + 1)))
                .and_then(|n| n.checked_add(proposals * 512 * 1024))
                .and_then(|n| n.checked_add(matrix_bytes * 2))
                .and_then(|n| {
                    n.checked_add(selection_bytes.saturating_mul(2 * runs + 4 * proposals + 16))
                })
                .ok_or_else(|| bad("selection preflight overflow"))?
        };
        // Snapshot and detail readers each verify proposals/evaluations; run pages
        // verify one record again for the caller's full detail. Config/feedback
        // decoding is charged for both passes, before either pass starts.
        let charge = proposal_bytes
            .checked_add(events)
            .and_then(|n| n.checked_add(run_bytes))
            .and_then(|n| n.checked_add(evaluation_bytes))
            .and_then(|n| n.checked_mul(2))
            .and_then(|n| n.checked_add(config_bytes.saturating_mul(2 * proposals + 4)))
            .and_then(|n| n.checked_add(proposals * 1024 * 1024))
            .and_then(|n| n.checked_add(selected_charge))
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| bad("search evidence preflight overflow"))?;
        *budget = budget
            .checked_sub(charge)
            .ok_or_else(|| bad("search evidence preflight exceeds aggregate budget"))?;
        Ok(())
    }
}

pub(super) fn forbid_exposure(conn: &Connection, c: &Campaign) -> Result<()> {
    if configuration(conn, c)?.is_some() {
        return Err(bad("Development search cannot expose a protected suite"));
    }
    Ok(())
}
