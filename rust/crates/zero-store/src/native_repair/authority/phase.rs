use super::*;

fn started_phase(conn: &Connection, b: &Bound, phase: &str, r: &mut Reader) -> Result<Option<u64>> {
    let marker = phase_event(conn, b, phase, "started", r)?;
    let name = format!("native_repair.{phase}.start");
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM operation_artifacts WHERE operation_id=?1 AND name=?2)",
        params![b.operation.id, name],
        |r| r.get(0),
    )?;
    let Some((seq, witness)) = marker else {
        if exists {
            return Err(bad("candidate start witness absent"));
        }
        return Ok(None);
    };
    let (_, bytes) = attached(conn, b, &name, r, 65536)?;
    let source = event(conn, b, "native_repair_source_bound", r)?
        .ok_or_else(|| bad("candidate before source binding"))?;
    let expected = json!({"repair_id":b.record.id,"operation_id":b.operation.id,"phase":phase,"owner":b.operation.owner,"source_sequence":source.0});
    if seq <= source.0 || witness != expected || bytes != encode(&expected)? {
        return Err(bad("candidate start receipt differs"));
    }
    Ok(Some(seq))
}
fn expected_candidate(
    source: &FrozenPlan,
    materialize: &MaterializeRequest,
    plan: &FrozenPlan,
    receipt: &CandidateReceipt,
) -> Result<()> {
    let expected = zero_repair::expected_receipt(materialize).map_err(bad)?;
    if receipt != &expected
        || plan.plan().snapshot.digest != expected.candidate_snapshot_sha256
        || plan.plan().snapshot.id != plan.plan().snapshot.digest
        || plan.plan().snapshot.root == source.plan().snapshot.root
    {
        return Err(bad("candidate snapshot or receipt differs"));
    }
    let mut files = source.plan().snapshot.files.clone();
    let target = files
        .iter_mut()
        .find(|f| f.path == materialize.target)
        .ok_or_else(|| bad("target absent"))?;
    target.digest = expected.replacement_sha256;
    target.bytes = expected.replacement_bytes;
    if encode(&files)? != encode(&plan.plan().snapshot.files)? {
        return Err(bad("candidate changed unauthorized files"));
    }
    let mut derived = source.plan().clone();
    derived.snapshot = plan.plan().snapshot.clone();
    for case in &mut derived.cases {
        if case.mode == Mode::Attack {
            case.expected = case
                .safe_expected
                .take()
                .ok_or_else(|| bad("safe expectation absent"))?;
        }
    }
    if FrozenPlan::new(derived).map_err(bad)?.digest() != plan.digest() {
        return Err(bad("candidate observation authority differs"));
    }
    Ok(())
}
pub(super) fn bound_candidate(
    conn: &Connection,
    b: &Bound,
    phase: &str,
    r: &mut Reader,
) -> Result<Option<(FrozenPlan, CandidateReceipt)>> {
    phase_index(phase)?;
    let start = started_phase(conn, b, phase, r)?;
    let marker = phase_event(conn, b, phase, "bound", r)?;
    let names = [
        format!("native_repair.{phase}.plan"),
        format!("repair.{phase}.receipt"),
    ];
    let count: u64 = conn.query_row(
        "SELECT count(*) FROM operation_artifacts WHERE operation_id=?1 AND name IN (?2,?3)",
        params![b.operation.id, names[0], names[1]],
        |r| r.get(0),
    )?;
    let Some((seq, witness)) = marker else {
        if count != 0 {
            return Err(bad("candidate binding witness absent"));
        }
        return Ok(None);
    };
    if count != 2 || start.is_none_or(|n| seq <= n) {
        return Err(bad("candidate binding order or artifacts differ"));
    }
    let (ph, bytes) = attached(conn, b, &names[0], r, zero_verification::MAX_PLAN_BYTES)?;
    let plan = FrozenPlan::parse(&bytes).map_err(bad)?;
    if bytes != serde_json::to_vec(plan.plan())? {
        return Err(bad("candidate plan encoding differs"));
    }
    let (rh, bytes) = attached(conn, b, &names[1], r, 65536)?;
    let receipt: CandidateReceipt = serde_json::from_slice(&bytes)?;
    if bytes != encode(&receipt)? {
        return Err(bad("candidate receipt encoding differs"));
    }
    let (source, _, materialize) =
        bound_source(conn, b, r)?.ok_or_else(|| bad("source not bound"))?;
    expected_candidate(&source, &materialize, &plan, &receipt)?;
    if witness
        != json!({"repair_id":b.record.id,"operation_id":b.operation.id,"phase":phase,"owner":b.operation.owner,"start_sequence":start,"plan_artifact":ph,"receipt_artifact":rh})
    {
        return Err(bad("candidate binding witness differs"));
    }
    Ok(Some((plan, receipt)))
}
pub(super) fn completed_phase(
    conn: &Connection,
    b: &Bound,
    phase: &str,
    r: &mut Reader,
) -> Result<Option<ReproductionOutcome>> {
    let marker = phase_event(conn, b, phase, "completed", r)?;
    let name = format!("native_repair.{phase}.completed");
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM operation_artifacts WHERE operation_id=?1 AND name=?2)",
        params![b.operation.id, name],
        |r| r.get(0),
    )?;
    let Some((seq, witness)) = marker else {
        if exists {
            return Err(bad("completed phase witness absent"));
        }
        return Ok(None);
    };
    let (digest, bytes) = attached(conn, b, &name, r, MAX_INTENT)?;
    let outcome: ReproductionOutcome = serde_json::from_slice(&bytes)?;
    if encode(&outcome)? != bytes {
        return Err(bad("completed phase encoding differs"));
    }
    let bind = phase_event(conn, b, phase, "bound", r)?
        .ok_or_else(|| bad("completed phase has no candidate"))?;
    if seq <= bind.0
        || witness
            != json!({"repair_id":b.record.id,"operation_id":b.operation.id,"phase":phase,"owner":b.operation.owner,"outcome_artifact":digest})
    {
        return Err(bad("completed phase witness differs"));
    }
    let latest:u64=conn.query_row("SELECT coalesce(max(sequence),0) FROM events WHERE session_id=?1 AND ((coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id')) IN (SELECT id FROM operations WHERE session_id=?1 AND command_id GLOB ?2)) OR (kind='operation_artifact' AND json_extract(payload,'$.operation_id')=?3 AND json_extract(payload,'$.name') IN (?4,?5,?6)))",params![b.record.session_id,format!("{}:{phase}:case:*",b.operation.id),b.operation.id,format!("{phase}.plan"),format!("{phase}.evidence_index"),format!("{phase}.assessment")],|r|r.get(0))?;
    if latest >= seq {
        return Err(bad("phase completion precedes retained observations"));
    }
    matrix::validate(conn, b, phase, &outcome, r)?;
    Ok(Some(outcome))
}
impl Store {
    pub fn native_repair_bound_candidate(
        &self,
        key: &str,
        phase: &str,
    ) -> Result<Option<(Plan, CandidateReceipt)>> {
        let tx = self.conn.unchecked_transaction()?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        Ok(bound_candidate(&tx, &b, phase, &mut r)?.map(|(p, c)| (p.plan().clone(), c)))
    }
    pub fn begin_native_repair_candidate(
        &mut self,
        key: &str,
        owner: &str,
        phase: &str,
    ) -> Result<()> {
        phase_index(phase)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        open(&tx, &b, owner)?;
        bound_source(&tx, &b, &mut r)?.ok_or_else(|| bad("source not bound"))?;
        if started_phase(&tx, &b, phase, &mut r)?.is_some() {
            return Err(bad("candidate materialization already started"));
        }
        if phase == "reconstructed" && completed_phase(&tx, &b, "candidate", &mut r)?.is_none() {
            return Err(bad("first matrix not independently completed"));
        }
        let source = event(&tx, &b, "native_repair_source_bound", &mut r)?
            .ok_or_else(|| bad("source witness absent"))?;
        let receipt = json!({"repair_id":b.record.id,"operation_id":b.operation.id,"phase":phase,"owner":owner,"source_sequence":source.0});
        retain(
            &tx,
            &b,
            &b.operation.id,
            &format!("native_repair.{phase}.start"),
            &encode(&receipt)?,
        )?;
        append(
            &tx,
            &b.record.session_id,
            &format!("native_repair_{phase}_started"),
            &receipt,
        )?;
        open(&tx, &b, owner)?;
        tx.commit()?;
        Ok(())
    }
    pub fn bind_native_repair_candidate(
        &mut self,
        key: &str,
        owner: &str,
        phase: &str,
        plan: &Plan,
        receipt: &CandidateReceipt,
    ) -> Result<()> {
        phase_index(phase)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        let frozen = FrozenPlan::new(plan.clone()).map_err(bad)?;
        let (source, _, materialize) =
            bound_source(&tx, &b, &mut r)?.ok_or_else(|| bad("source not bound"))?;
        expected_candidate(&source, &materialize, &frozen, receipt)?;
        if let Some((old, old_receipt)) = bound_candidate(&tx, &b, phase, &mut r)? {
            if old.digest() != frozen.digest()
                || old_receipt != *receipt
                || b.operation.owner.as_deref() != Some(owner)
            {
                return Err(bad("candidate binding retry differs"));
            }
            return Ok(());
        }
        open(&tx, &b, owner)?;
        let start = started_phase(&tx, &b, phase, &mut r)?
            .ok_or_else(|| bad("candidate materialization not started"))?;
        if phase == "reconstructed" {
            let (first, _) = bound_candidate(&tx, &b, "candidate", &mut r)?
                .ok_or_else(|| bad("first candidate absent"))?;
            if first.plan().snapshot.root == plan.snapshot.root {
                return Err(bad("reconstructed candidate must use a fresh private root"));
            }
            completed_phase(&tx, &b, "candidate", &mut r)?
                .ok_or_else(|| bad("first phase incomplete"))?;
        }
        let p = retain(
            &tx,
            &b,
            &b.operation.id,
            &format!("native_repair.{phase}.plan"),
            &serde_json::to_vec(plan)?,
        )?;
        let c = retain(
            &tx,
            &b,
            &b.operation.id,
            &format!("repair.{phase}.receipt"),
            &encode(receipt)?,
        )?;
        append(
            &tx,
            &b.record.session_id,
            &format!("native_repair_{phase}_bound"),
            &json!({"repair_id":b.record.id,"operation_id":b.operation.id,"phase":phase,"owner":owner,"start_sequence":start,"plan_artifact":p,"receipt_artifact":c}),
        )?;
        open(&tx, &b, owner)?;
        tx.commit()?;
        Ok(())
    }
    pub fn complete_native_repair_phase(
        &mut self,
        key: &str,
        owner: &str,
        phase: &str,
        outcome: &ReproductionOutcome,
    ) -> Result<()> {
        phase_index(phase)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        if let Some(old) = completed_phase(&tx, &b, phase, &mut r)? {
            if encode(&old)? != encode(outcome)? || b.operation.owner.as_deref() != Some(owner) {
                return Err(bad("completed phase retry differs"));
            }
            return Ok(());
        }
        open(&tx, &b, owner)?;
        matrix::validate(&tx, &b, phase, outcome, &mut r)?;
        let digest = retain(
            &tx,
            &b,
            &b.operation.id,
            &format!("native_repair.{phase}.completed"),
            &encode(outcome)?,
        )?;
        append(
            &tx,
            &b.record.session_id,
            &format!("native_repair_{phase}_completed"),
            &json!({"repair_id":b.record.id,"operation_id":b.operation.id,"phase":phase,"owner":owner,"outcome_artifact":digest}),
        )?;
        open(&tx, &b, owner)?;
        tx.commit()?;
        Ok(())
    }
}
