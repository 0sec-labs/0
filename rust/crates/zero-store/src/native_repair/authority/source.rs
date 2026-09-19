use super::*;

pub(in crate::native_repair) fn expected_source(
    conn: &Connection,
    b: &Bound,
    execution: &FrozenPlan,
    r: &mut Reader,
) -> Result<(ReviewRepairBinding, MaterializeRequest)> {
    let (record, original) = crate::native_reproduction::authorization_record(
        conn,
        &b.record.source_reproduction_id,
        r,
    )?;
    if record.operation_id != b.record.reproduction_operation_id {
        return Err(bad("baseline operation differs"));
    }
    let logical = FrozenPlan::new(original.plan.clone()).map_err(bad)?;
    logical.validate_reanchored(execution).map_err(bad)?;
    let materialize = zero_repair::reanchor_materialization(
        &b.admission.authorization.materialize,
        &execution.plan().snapshot,
    )
    .map_err(bad)?;
    let receipt = zero_repair::expected_receipt(&materialize).map_err(bad)?;
    Ok((
        ReviewRepairBinding {
            schema_version: 1,
            reproduction_id: record.id,
            reproduction_operation_id: record.operation_id,
            review_id: record.source_review_id,
            source_operation_id: record.source_operation_id,
            archive_manifest_sha256: original.archive_manifest_sha256.clone(),
            reproduction_authorization_sha256: hash(&original)?,
            repair_authorization_sha256: b.record.authorization_sha256.clone(),
            logical_plan_sha256: logical.digest().into(),
            execution_baseline_plan_sha256: execution.digest().into(),
            materialize_request_sha256: hash(&materialize)?,
            candidate_receipt_sha256: hash(&receipt)?,
        },
        materialize,
    ))
}
pub(super) fn bound_source(
    conn: &Connection,
    b: &Bound,
    r: &mut Reader,
) -> Result<Option<(FrozenPlan, ReviewRepairBinding, MaterializeRequest)>> {
    let marker = event(conn, b, "native_repair_source_bound", r)?;
    let count:u64=conn.query_row("SELECT count(*) FROM operation_artifacts WHERE operation_id=?1 AND name IN ('native_repair.execution_baseline','native_repair.source_binding','repair.materialize_request','repair.replacement')",[&b.operation.id],|r|r.get(0))?;
    let Some((seq, witness)) = marker else {
        if count != 0 {
            return Err(bad("source artifacts without binding witness"));
        }
        return Ok(None);
    };
    if count != 4 {
        return Err(bad("source binding artifacts missing"));
    }
    let prep = preparation(conn, b, r)?.ok_or_else(|| bad("preparation missing"))?;
    let (plan_hash, bytes) = attached(
        conn,
        b,
        "native_repair.execution_baseline",
        r,
        zero_verification::MAX_PLAN_BYTES,
    )?;
    let execution = FrozenPlan::parse(&bytes).map_err(bad)?;
    if bytes != serde_json::to_vec(execution.plan())? {
        return Err(bad("execution baseline encoding differs"));
    }
    let (binding_hash, bytes) = attached(conn, b, "native_repair.source_binding", r, 65536)?;
    let binding: ReviewRepairBinding = serde_json::from_slice(&bytes)?;
    if bytes != encode(&binding)? {
        return Err(bad("binding encoding differs"));
    }
    let (request_hash, bytes) = attached(conn, b, "repair.materialize_request", r, MAX_INTENT)?;
    let materialize: MaterializeRequest = serde_json::from_slice(&bytes)?;
    if bytes != encode(&materialize)? {
        return Err(bad("materialization encoding differs"));
    }
    let (replacement_hash, replacement) = attached(conn, b, "repair.replacement", r, MAX_INTENT)?;
    let (expected, request) = expected_source(conn, b, &execution, r)?;
    if binding != expected
        || encode(&request)? != encode(&materialize)?
        || replacement != materialize.replacement.as_bytes()
        || seq <= prep
        || witness
            != json!({"repair_id":b.record.id,"operation_id":b.operation.id,"owner":b.operation.owner,
        "preparation_sequence":prep,"execution_baseline_artifact":plan_hash,"source_binding_artifact":binding_hash,
        "materialize_request_artifact":request_hash,"replacement_artifact":replacement_hash})
    {
        return Err(bad("retained source binding differs"));
    }
    Ok(Some((execution, binding, materialize)))
}
impl Store {
    pub fn native_repair_authorization(&self, key: &str) -> Result<ReviewRepairPlan> {
        let tx = self.conn.unchecked_transaction()?;
        Ok(bound(&tx, key, &mut Reader::new())?.admission.authorization)
    }
    pub fn native_repair_bound_source(
        &self,
        key: &str,
    ) -> Result<Option<(Plan, ReviewRepairBinding, MaterializeRequest)>> {
        let tx = self.conn.unchecked_transaction()?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        Ok(bound_source(&tx, &b, &mut r)?.map(|(p, b, m)| (p.plan().clone(), b, m)))
    }
    pub fn begin_native_repair_preparation(&mut self, key: &str, owner: &str) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        open(&tx, &b, owner)?;
        if preparation(&tx, &b, &mut r)?.is_some() {
            return Err(bad("preparation already started"));
        }
        // Recheck the assessed view atomically before allowing archive reads.
        super::super::source(&tx, &b.admission)?;
        append(
            &tx,
            &b.record.session_id,
            "native_repair_preparation_started",
            &json!({"repair_id":b.record.id,"operation_id":b.operation.id,"intent_sha256":b.record.intent_sha256,"owner":owner}),
        )?;
        open(&tx, &b, owner)?;
        tx.commit()?;
        Ok(())
    }
    pub fn bind_native_repair_source(
        &mut self,
        key: &str,
        owner: &str,
        execution: &Plan,
        binding: &ReviewRepairBinding,
        materialize: &MaterializeRequest,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        let frozen = FrozenPlan::new(execution.clone()).map_err(bad)?;
        let (expected, request) = expected_source(&tx, &b, &frozen, &mut r)?;
        if *binding != expected || encode(materialize)? != encode(&request)? {
            return Err(bad("source authority differs"));
        }
        if let Some((old, old_binding, old_request)) = bound_source(&tx, &b, &mut r)? {
            if old.digest() != frozen.digest()
                || old_binding != *binding
                || encode(&old_request)? != encode(materialize)?
                || b.operation.owner.as_deref() != Some(owner)
            {
                return Err(bad("source binding retry differs"));
            }
            return Ok(());
        }
        open(&tx, &b, owner)?;
        // Reconstruction happened outside SQLite. No source binding is issued
        // if its independently assessed baseline changed in that interval.
        super::super::source(&tx, &b.admission)?;
        let prep = preparation(&tx, &b, &mut r)?.ok_or_else(|| bad("preparation not started"))?;
        let p = retain(
            &tx,
            &b,
            &b.operation.id,
            "native_repair.execution_baseline",
            &serde_json::to_vec(execution)?,
        )?;
        let h = retain(
            &tx,
            &b,
            &b.operation.id,
            "native_repair.source_binding",
            &encode(binding)?,
        )?;
        let m = retain(
            &tx,
            &b,
            &b.operation.id,
            "repair.materialize_request",
            &encode(materialize)?,
        )?;
        let replacement = retain(
            &tx,
            &b,
            &b.operation.id,
            "repair.replacement",
            materialize.replacement.as_bytes(),
        )?;
        append(
            &tx,
            &b.record.session_id,
            "native_repair_source_bound",
            &json!({"repair_id":b.record.id,"operation_id":b.operation.id,"owner":owner,
            "preparation_sequence":prep,"execution_baseline_artifact":p,"source_binding_artifact":h,"materialize_request_artifact":m,"replacement_artifact":replacement}),
        )?;
        open(&tx, &b, owner)?;
        tx.commit()?;
        Ok(())
    }
}
