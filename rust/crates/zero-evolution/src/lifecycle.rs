use crate::*;
use rusqlite::{OptionalExtension, TransactionBehavior, params};

pub(crate) fn current(conn: &Connection) -> Result<RuntimeState> {
    let (epoch, generation, state_schema, state_digest, json): (
        u64,
        Option<String>,
        String,
        String,
        String,
    ) = conn.query_row(
        "SELECT epoch,generation,state_schema,state_digest,state FROM runtime WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    if json.len() > MAX_JSON_BYTES || hash(json.as_bytes()) != state_digest {
        return Err(Error::Invalid("runtime state digest mismatch".into()));
    }
    Ok(RuntimeState {
        epoch,
        generation,
        state_schema,
        state_digest,
        state: serde_json::from_str(&json)?,
    })
}
fn authorized(
    conn: &Connection,
    generation: &str,
    eligibility_id: &str,
    state: &RuntimeState,
    rollback: bool,
) -> Result<Manifest> {
    let manifest: Manifest = read_json(conn, "generations", generation)?;
    let eligibility: Eligibility = read_json(conn, "eligibilities", eligibility_id)?;
    if eligibility.generation != generation {
        return Err(Error::Ineligible(
            "eligibility belongs to another generation".into(),
        ));
    }
    let previously_active: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM activations WHERE generation=?1)",
        [generation],
        |r| r.get(0),
    )?;
    if rollback {
        if !previously_active {
            return Err(Error::Ineligible("rollback target was never active".into()));
        }
        if manifest.state_schema != state.state_schema
            && !manifest
                .compatible_state_schemas
                .contains(&state.state_schema)
        {
            return Err(Error::Ineligible(
                "rollback target is incompatible with current state schema".into(),
            ));
        }
    }
    if crate::strategy::reserved(&manifest) {
        crate::strategy::authorize(
            conn,
            generation,
            eligibility_id,
            &eligibility,
            state,
            rollback,
        )?;
        return Ok(manifest);
    }
    if eligibility.strategy_scope.is_some() {
        return Err(Error::Ineligible(
            "strategy scope on legacy generation".into(),
        ));
    }
    match eligibility.receipt {
        Some(id) => {
            let receipt: EvaluationReceipt = read_json(conn, "receipts", &id)?;
            if receipt.candidate != generation
                || receipt.policy_artifact != manifest.policy_artifact
                || receipt.decision != EvaluationDecision::Eligible
            {
                return Err(Error::Ineligible(
                    "invalid retained evaluation eligibility".into(),
                ));
            }
            if !rollback && state.generation.as_deref() != Some(&receipt.baseline) {
                return Err(Error::Ineligible(
                    "evaluation baseline is not the active generation".into(),
                ));
            }
        }
        None => {
            if eligibility.bootstrap_reason.is_none()
                || (!rollback && (state.epoch != 0 || state.generation.is_some()))
            {
                return Err(Error::Ineligible(
                    "bootstrap cannot bypass later evaluation".into(),
                ));
            }
        }
    }
    Ok(manifest)
}
impl Registry {
    pub fn current(&self) -> Result<RuntimeState> {
        current(&self.conn)
    }
    /// Callback must prepare provisional resources and migrate a COPY of current
    /// state. On error/conflict caller disposes provisional resources; no external
    /// side effect is rolled back by this registry.
    pub fn prepare_activation<F>(
        &mut self,
        generation: &str,
        eligibility: &str,
        expected: &RuntimeState,
        prepare: F,
    ) -> Result<PreparedActivation>
    where
        F: FnOnce(&Manifest, &RuntimeState) -> std::result::Result<PreparedState, String>,
    {
        self.prepare(generation, eligibility, expected, false, prepare)
    }
    /// Selects retained code using today's state. Never restores a historical
    /// state payload, rewrites a receipt or declares a new improvement.
    pub fn prepare_rollback<F>(
        &mut self,
        generation: &str,
        eligibility: &str,
        expected: &RuntimeState,
        prepare: F,
    ) -> Result<PreparedActivation>
    where
        F: FnOnce(&Manifest, &RuntimeState) -> std::result::Result<PreparedState, String>,
    {
        self.prepare(generation, eligibility, expected, true, prepare)
    }
    fn prepare<F>(
        &mut self,
        generation: &str,
        eligibility: &str,
        expected: &RuntimeState,
        rollback: bool,
        prepare: F,
    ) -> Result<PreparedActivation>
    where
        F: FnOnce(&Manifest, &RuntimeState) -> std::result::Result<PreparedState, String>,
    {
        let original = current(&self.conn)?;
        if &original != expected {
            return Err(Error::Conflict("stale expected runtime state".into()));
        }
        let manifest = authorized(&self.conn, generation, eligibility, &original, rollback)?;
        let staged = prepare(&manifest, &original).map_err(Error::Preparation)?;
        if staged.state_schema != manifest.state_schema {
            return Err(Error::Invalid(
                "prepared schema differs from target manifest".into(),
            ));
        }
        let json = encode(&staged.state)?;
        let digest = hash(json.as_bytes());
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if current(&tx)? != original {
            return Err(Error::Conflict("runtime changed during preparation".into()));
        }
        authorized(&tx, generation, eligibility, &original, rollback)?;
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO preparations(id,owner,generation,eligibility,expected_epoch,expected_generation,expected_digest,state_schema,state_digest,state,rollback) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![id,self.owner,generation,eligibility,original.epoch,original.generation,original.state_digest,staged.state_schema,digest,json,rollback])?;
        tx.commit()?;
        Ok(PreparedActivation {
            id,
            generation: generation.into(),
            expected_epoch: original.epoch,
        })
    }
    /// Publish only a preparation created by this live Registry instance.
    /// After reopening, prepare resources afresh; persisted intent is not readiness.
    pub fn commit(&mut self, preparation_id: &str) -> Result<RuntimeState> {
        self.commit_inner(preparation_id, None)
    }
    pub fn commit_strategy_baseline(
        &mut self,
        preparation_id: &str,
        generation: &str,
        command: &str,
        reason: &str,
    ) -> Result<zero_protocol::strategy_registry::StrategyBaselineInstallReceipt> {
        if let Some(prior) = self.strategy_bootstrap_by_command(command)? {
            if prior.generation != generation || prior.reason != reason {
                return Err(Error::Conflict("strategy bootstrap command reused".into()));
            }
            return Ok(prior);
        }
        self.commit_inner(preparation_id, Some((command, reason)))?;
        self.strategy_bootstrap_by_command(command)?
            .ok_or_else(|| Error::Missing(command.into()))
    }
    fn commit_inner(
        &mut self,
        preparation_id: &str,
        baseline: Option<(&str, &str)>,
    ) -> Result<RuntimeState> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        type Row = (
            String,
            String,
            String,
            u64,
            Option<String>,
            String,
            String,
            String,
            String,
            bool,
            Option<u64>,
        );
        let row:Row=tx.query_row("SELECT owner,generation,eligibility,expected_epoch,expected_generation,expected_digest,state_schema,state_digest,state,rollback,committed_epoch FROM preparations WHERE id=?1",[preparation_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?))).optional()?.ok_or_else(||Error::Missing(preparation_id.into()))?;
        let (
            owner,
            generation,
            eligibility,
            expected_epoch,
            expected_generation,
            expected_digest,
            schema,
            digest,
            json,
            rollback,
            committed,
        ) = row;
        if owner != self.owner || committed.is_some() {
            return Err(Error::Conflict(
                "preparation is not live or was already committed".into(),
            ));
        }
        let old = current(&tx)?;
        if old.epoch != expected_epoch
            || old.generation != expected_generation
            || old.state_digest != expected_digest
        {
            return Err(Error::Conflict("activation compare-and-swap failed".into()));
        }
        authorized(&tx, &generation, &eligibility, &old, rollback)?;
        let eligible: Eligibility = read_json(&tx, "eligibilities", &eligibility)?;
        if matches!(
            eligible.strategy_scope,
            Some(crate::strategy::Scope::Bootstrap { .. })
        ) && !rollback
            && baseline.is_none()
        {
            return Err(Error::Ineligible(
                "strategy bootstrap requires atomic install receipt".into(),
            ));
        }
        if json.len() > MAX_JSON_BYTES || hash(json.as_bytes()) != digest {
            return Err(Error::Invalid("prepared state corrupted".into()));
        }
        let epoch = old
            .epoch
            .checked_add(1)
            .filter(|v| *v <= i64::MAX as u64)
            .ok_or_else(|| Error::Invalid("epoch overflow".into()))?;
        let updated=tx.execute("UPDATE runtime SET epoch=?1,generation=?2,state_schema=?3,state_digest=?4,state=?5 WHERE singleton=1 AND epoch=?6",params![epoch,generation,schema,digest,json,expected_epoch])?;
        if updated != 1 {
            return Err(Error::Conflict("activation compare-and-swap failed".into()));
        }
        tx.execute(
            "UPDATE preparations SET committed_epoch=?2 WHERE id=?1",
            params![preparation_id, epoch],
        )?;
        tx.execute(
            "INSERT INTO activations VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                epoch,
                generation,
                old.generation,
                preparation_id,
                digest,
                rollback
            ],
        )?;
        let result = current(&tx)?;
        if let Some((command, reason)) = baseline {
            crate::strategy::finish_bootstrap(&tx, preparation_id, command, reason, &result)?;
        }
        tx.commit()?;
        Ok(result)
    }
    pub fn acquire_active(&mut self, owner: &str) -> Result<GenerationLease> {
        nonempty(owner)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = current(&tx)?;
        let generation = state
            .generation
            .ok_or_else(|| Error::Conflict("no active generation".into()))?;
        let lease = GenerationLease {
            id: uuid::Uuid::new_v4().to_string(),
            generation,
            owner: owner.into(),
            epoch: state.epoch,
        };
        tx.execute(
            "INSERT INTO leases(id,generation,owner,epoch) VALUES (?1,?2,?3,?4)",
            params![lease.id, lease.generation, lease.owner, lease.epoch],
        )?;
        tx.commit()?;
        Ok(lease)
    }
    /// Discover committed leases even when a crash lost the acquisition reply.
    /// Filters combine with AND. Cursor is the last returned ID, exclusive.
    /// Pages are individually consistent, not a snapshot across calls. Fence
    /// acquisition before recovery; new random IDs may sort before a cursor.
    /// Listing is not evidence that an owner is dead and never releases a lease.
    pub fn list_unreleased_leases(
        &self,
        owner: Option<&str>,
        generation: Option<&str>,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<GenerationLease>> {
        if !(1..=MAX_LEASE_PAGE_SIZE).contains(&limit) {
            return Err(Error::Invalid(format!(
                "lease page limit must be 1..={MAX_LEASE_PAGE_SIZE}"
            )));
        }
        for value in [owner, generation, after_id].into_iter().flatten() {
            nonempty(value)?;
        }
        let mut statement = self.conn.prepare(
            "SELECT id,generation,owner,epoch FROM leases WHERE released=0 AND (?1 IS NULL OR owner=?1) AND (?2 IS NULL OR generation=?2) AND (?3 IS NULL OR id>?3) ORDER BY id LIMIT ?4"
        )?;
        let rows =
            statement.query_map(params![owner, generation, after_id, limit as u32], |row| {
                Ok(GenerationLease {
                    id: row.get(0)?,
                    generation: row.get(1)?,
                    owner: row.get(2)?,
                    epoch: row.get(3)?,
                })
            })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
    /// Explicit release only. Dropping/reopening Registry never releases leases.
    /// A recovered owner must first be fenced/quiescent by the outer supervisor.
    pub fn release(&mut self, lease_id: &str, owner: &str) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actual: String = tx
            .query_row("SELECT owner FROM leases WHERE id=?1", [lease_id], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| Error::Missing(lease_id.into()))?;
        if owner != actual {
            return Err(Error::Conflict("lease owner mismatch".into()));
        }
        tx.execute("UPDATE leases SET released=1 WHERE id=?1", [lease_id])?;
        tx.commit()?;
        Ok(())
    }
    /// Momentary generation-level status, not exclusive disposal authority.
    /// Resource owners must serialize disposal/reactivation and distinguish
    /// activation epochs when a retained generation becomes active again.
    pub fn lifecycle(&self, generation: &str) -> Result<RuntimeLifecycle> {
        let _: Manifest = read_json(&self.conn, "generations", generation)?;
        // Single SQL statement observes active identity and lease count together.
        let (active,count):(Option<String>,u64)=self.conn.query_row("SELECT generation,(SELECT COUNT(*) FROM leases WHERE generation=?1 AND released=0) FROM runtime WHERE singleton=1",[generation],|r|Ok((r.get(0)?,r.get(1)?)))?;
        Ok(if active.as_deref() == Some(generation) {
            RuntimeLifecycle::Active
        } else if count > 0 {
            RuntimeLifecycle::Draining { leases: count }
        } else {
            RuntimeLifecycle::Inactive
        })
    }
}
