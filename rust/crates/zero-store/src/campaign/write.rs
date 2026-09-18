use super::*;
use sha2::{Digest, Sha256};
impl Store {
    pub fn campaign_by_command(&self, command: &str) -> Result<Option<Campaign>> {
        id(command)?;
        let key: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM campaigns WHERE command_id=?1",
                [command],
                |r| r.get(0),
            )
            .optional()?;
        key.map(|k| current(&self.conn, &k)).transpose()
    }
    pub fn create_campaign_with_artifact(
        &mut self,
        command: &str,
        plan: &CampaignPlan,
        bytes: &[u8],
    ) -> Result<(Campaign, bool)> {
        id(command)?;
        plan.validate().map_err(|e| bad(&e.to_string()))?;
        if bytes.len() > 2 * 1024 * 1024
            || format!("sha256:{:x}", Sha256::digest(bytes)) != plan.controller_plan_sha256
        {
            return Err(bad("controller artifact identity or bound"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior: Option<String> = tx
            .query_row(
                "SELECT id FROM campaigns WHERE command_id=?1",
                [command],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(key) = prior {
            let c = current(&tx, &key)?;
            if c.plan != *plan
                || crate::artifacts::read(&tx, &plan.controller_plan_sha256)? != bytes
            {
                return Err(bad("conflicting campaign retry"));
            }
            return Ok((c, true));
        }
        let at = now()?;
        if plan.expires_at_ms <= at {
            return Err(bad("campaign already expired"));
        }
        tx.execute(
            "INSERT OR IGNORE INTO artifacts(digest,bytes) VALUES(?1,?2)",
            params![plan.controller_plan_sha256, bytes],
        )?;
        if crate::artifacts::read(&tx, &plan.controller_plan_sha256)? != bytes {
            return Err(bad("artifact collision"));
        }
        let s = session(
            &tx,
            &format!("campaign-controller:{}", plan.controller_plan_sha256),
            0,
            at,
        )?;
        let c = Campaign {
            id: uuid::Uuid::new_v4().to_string(),
            command_id: command.into(),
            journal_session_id: s.id,
            plan: plan.clone(),
            plan_sha256: hash(&serde_json::to_value(plan)?)?,
            created_at_ms: at,
            status: CampaignStatus::Open,
        };
        let sequence = next(&tx, &c.journal_session_id)?;
        tx.execute("INSERT INTO campaigns(id,command_id,journal_session_id,record,sequence,cancel_sequence,last_ms) VALUES(?1,?2,?3,?4,?5,NULL,?6)",params![c.id,command,c.journal_session_id,serde_json::to_string(&c)?,integer(sequence)?,integer(at)?])?;
        append(
            &tx,
            &c.journal_session_id,
            "campaign_created",
            &serde_json::to_value(&c)?,
        )?;
        tx.commit()?;
        Ok((c, false))
    }
    pub fn create_campaign_exposure(
        &mut self,
        campaign: &str,
        command: &str,
        suite: &str,
        pair: &str,
        finalist: &str,
    ) -> Result<(CampaignExposure, bool)> {
        id(command)?;
        for d in [suite, pair, finalist] {
            if !zero_protocol::is_sha256(d) {
                return Err(bad("invalid exposure digest"));
            }
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior: Option<String> = tx
            .query_row(
                "SELECT id FROM campaign_exposures WHERE campaign_id=?1 AND command_id=?2",
                params![campaign, command],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(key) = prior {
            let e = read::exposure(&tx, campaign, &key)?;
            if e.suite_sha256 != suite
                || e.evaluation_pair_sha256 != pair
                || e.finalist_sha256 != finalist
            {
                return Err(bad("conflicting exposure retry"));
            }
            return Ok((e, true));
        }
        let c = open(&tx, campaign)?;
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM campaign_exposures WHERE suite_sha256=?1) OR EXISTS(SELECT 1 FROM events WHERE kind='campaign_exposed' AND json_extract(payload,'$.suite_sha256')=?1)",[suite],|r|r.get::<_,bool>(0))?{return Err(bad("protected suite has already been exposed"))}
        let sequence = next(&tx, &c.journal_session_id)?;
        let e = CampaignExposure {
            id: uuid::Uuid::new_v4().to_string(),
            campaign_id: campaign.into(),
            command_id: command.into(),
            suite_sha256: suite.into(),
            evaluation_pair_sha256: pair.into(),
            finalist_sha256: finalist.into(),
            sequence,
        };
        tx.execute("INSERT INTO campaign_exposures(id,campaign_id,command_id,suite_sha256,evaluation_pair_sha256,record,sequence) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![e.id,campaign,command,suite,pair,serde_json::to_string(&e)?,integer(sequence)?])?;
        append(
            &tx,
            &c.journal_session_id,
            "campaign_exposed",
            &serde_json::to_value(&e)?,
        )?;
        tx.commit()?;
        Ok((e, false))
    }
    pub fn create_campaign_run(
        &mut self,
        campaign: &str,
        command: &str,
        spec: &CampaignRunSpec,
        owner: &str,
    ) -> Result<(CampaignRun, bool)> {
        id(command)?;
        id(owner)?;
        spec.validate().map_err(|e| bad(&e.to_string()))?;
        if zero_http::canonical_origin(&spec.fixture_origin).map_err(|e| bad(&e.to_string()))?
            != spec.fixture_origin
        {
            return Err(bad("fixture origin must be canonical"));
        }
        // Instantiate validation only; no DNS/socket or secrets. Auth descriptors may be present.
        if zero_http::canonical_origin(&spec.http_policy.base_url)
            .map_err(|e| bad(&e.to_string()))?
            != spec.fixture_origin
        {
            return Err(bad("fixture policy origin differs"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior: Option<String> = tx
            .query_row(
                "SELECT id FROM campaign_runs WHERE campaign_id=?1 AND command_id=?2",
                params![campaign, command],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(key) = prior {
            let r = read::run(&tx, campaign, &key)?;
            if serde_json::to_value(&r.spec)? != serde_json::to_value(spec)? {
                return Err(bad("conflicting campaign run retry"));
            }
            return Ok((r, true));
        }
        require_epoch(&tx, owner)?;
        let c = open(&tx, campaign)?;
        let used = read::usage(&tx, &c)?;
        if used.runs >= u64::from(c.plan.limits.runs)
            || used.active_runs >= u64::from(c.plan.limits.max_parallel_runs)
        {
            return Err(Error::BudgetExceeded);
        }
        if let Some(key) = &spec.exposure_id {
            let e = read::exposure(&tx, campaign, key)?;
            if e.suite_sha256 != spec.suite_sha256
                || e.evaluation_pair_sha256 != spec.evaluation_pair_sha256
                || e.finalist_sha256 != spec.candidate_sha256
            {
                return Err(bad("run differs from exposed finalist/pair"));
            }
        }
        let at = now()?;
        let s = session(
            &tx,
            &format!("campaign:{}", c.plan_sha256),
            c.plan.limits.model_micro_usd,
            at,
        )?;
        let key = uuid::Uuid::new_v4().to_string();
        let sequence = next(&tx, &c.journal_session_id)?;
        let r = CampaignRun {
            id: key.clone(),
            campaign_id: campaign.into(),
            command_id: command.into(),
            session_id: s.id,
            run_command_id: format!("campaign-run:{key}"),
            spec: spec.clone(),
            request_sha256: hash(&serde_json::to_value(&spec.request)?)?,
            owner: owner.into(),
            sequence,
            status: CampaignRunStatus::Pending,
            operation_id: None,
        };
        tx.execute("INSERT INTO campaign_runs(id,campaign_id,command_id,session_id,schedule_index,record,sequence,owner,closed,close_sequence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,NULL,NULL)",params![r.id,campaign,command,r.session_id,spec.schedule_index,serde_json::to_string(&serde_json::to_value(&r)?)?,integer(sequence)?,owner])?;
        append(
            &tx,
            &c.journal_session_id,
            "campaign_run_admitted",
            &serde_json::to_value(&r)?,
        )?;
        append(
            &tx,
            &r.session_id,
            "campaign_session_bound",
            &json!({"campaign_id":campaign,"run_id":r.id,"request_sha256":r.request_sha256,"run_sequence":sequence}),
        )?;
        tx.commit()?;
        Ok((r, false))
    }
    pub fn settle_campaign_run_without_root(
        &mut self,
        campaign: &str,
        key: &str,
        owner: &str,
        status: CampaignRunStatus,
        reason: &str,
    ) -> Result<CampaignRun> {
        if !matches!(
            status,
            CampaignRunStatus::Failed | CampaignRunStatus::Cancelled
        ) || reason.is_empty()
            || reason.len() > 4096
        {
            return Err(bad("invalid pre-root settlement"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let r = read::run(&tx, campaign, key)?;
        if r.owner != owner || r.operation_id.is_some() {
            return Err(bad("pre-root settlement owner or effect differs"));
        }
        if r.status == status {
            let prior: String = tx.query_row(
                "SELECT CASE WHEN length(CAST(close_reason AS BLOB))<=4096 THEN close_reason END FROM campaign_runs WHERE id=?1",
                [key],
                |row| row.get(0),
            )?;
            if prior != reason {
                return Err(bad("conflicting pre-root settlement retry"));
            }
            return Ok(r);
        }
        require_epoch(&tx, owner)?;
        if r.status != CampaignRunStatus::Pending {
            return Err(bad("run already retired"));
        }
        let c = original(&tx, campaign)?;
        let sequence = next(&tx, &c.journal_session_id)?;
        let label = if status == CampaignRunStatus::Failed {
            "failed"
        } else {
            "cancelled"
        };
        tx.execute(
            "UPDATE campaign_runs SET closed=?2,close_sequence=?3,close_reason=?4 WHERE id=?1",
            params![key, label, integer(sequence)?, reason],
        )?;
        append(
            &tx,
            &c.journal_session_id,
            "campaign_run_closed",
            &json!({"run_id":key,"status":label,"reason":reason}),
        )?;
        let result = read::run(&tx, campaign, key)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn cancel_campaign(&mut self, campaign: &str) -> Result<CampaignSnapshot> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let c = original(&tx, campaign)?;
        let old: Option<u64> = tx.query_row(
            "SELECT cancel_sequence FROM campaigns WHERE id=?1",
            [campaign],
            |r| r.get(0),
        )?;
        if old.is_none() {
            let sequence = next(&tx, &c.journal_session_id)?;
            tx.execute(
                "UPDATE campaigns SET cancel_sequence=?2 WHERE id=?1",
                params![campaign, integer(sequence)?],
            )?;
            append(
                &tx,
                &c.journal_session_id,
                "campaign_cancelled",
                &json!({"campaign_id":campaign}),
            )?;
            hooks::close_pending(&tx, Some(campaign), None, "cancelled")?;
        }
        let result = read::snapshot(&tx, campaign)?;
        tx.commit()?;
        Ok(result)
    }
}
