use super::*;
impl Store {
    pub fn admit_native_repair_case(
        &mut self,
        key: &str,
        owner: &str,
        phase: &str,
        case_index: usize,
        repeat: usize,
    ) -> Result<(Operation, SandboxRequest)> {
        let phase_number = phase_index(phase)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        open(&tx, &b, owner)?;
        let (plan, _) =
            bound_candidate(&tx, &b, phase, &mut r)?.ok_or_else(|| bad("candidate not bound"))?;
        let (command, payload, request) =
            case_payload(&b.operation.id, phase, &plan, case_index, repeat)?;
        let required = plan.plan().cases.len() * plan.plan().repeats;
        let ordinal = case_index
            .checked_mul(plan.plan().repeats)
            .and_then(|n| n.checked_add(repeat))
            .and_then(|n| n.checked_add(phase_number * required))
            .ok_or_else(|| bad("case ordinal overflow"))?;
        let count: usize = tx.query_row(
            "SELECT count(*) FROM operations WHERE session_id=?1 AND id!=?2",
            params![b.record.session_id, b.operation.id],
            |r| r.get(0),
        )?;
        if count != ordinal || ordinal >= b.admission.authorization.max_executions as usize {
            return Err(bad("case replay, gap or execution limit"));
        }
        if phase_number == 1 {
            completed_phase(&tx, &b, "candidate", &mut r)?
                .ok_or_else(|| bad("first phase incomplete"))?;
        }
        if ordinal > 0 {
            let previous_phase = if ordinal - 1 < required {
                "candidate"
            } else {
                "reconstructed"
            };
            let (previous_plan, _) = bound_candidate(&tx, &b, previous_phase, &mut r)?
                .ok_or_else(|| bad("previous phase absent"))?;
            let index = (ordinal - 1) % required;
            let (prior, _, _) = case_payload(
                &b.operation.id,
                previous_phase,
                &previous_plan,
                index / plan.plan().repeats,
                index % plan.plan().repeats,
            )?;
            let previous:String=tx.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END FROM operations WHERE session_id=?1 AND command_id=?2",params![b.record.session_id,prior],|r|r.get(0))?;
            if workflow::operation(&tx, &previous, &mut r)?.status != OperationStatus::Succeeded {
                return Err(bad("previous case not successfully settled"));
            }
        }
        let op = running_child(&tx, &b, owner, command, payload)?;
        open(&tx, &b, owner)?;
        tx.commit()?;
        Ok((op, request))
    }
    pub fn begin_native_repair_effect(
        &mut self,
        key: &str,
        child: &str,
        owner: &str,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        open(&tx, &b, owner)?;
        let op = workflow::operation(&tx, child, &mut r)?;
        let phase = if op
            .command_id
            .starts_with(&format!("{}:candidate:case:", b.operation.id))
        {
            "candidate"
        } else if op
            .command_id
            .starts_with(&format!("{}:reconstructed:case:", b.operation.id))
        {
            "reconstructed"
        } else {
            return Err(bad("case phase differs"));
        };
        let (plan, _) =
            bound_candidate(&tx, &b, phase, &mut r)?.ok_or_else(|| bad("candidate not bound"))?;
        let case = plan
            .plan()
            .cases
            .iter()
            .position(|c| op.payload["case_id"] == c.id)
            .ok_or_else(|| bad("case absent"))?;
        let repeat = op.payload["repeat"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| bad("repeat invalid"))?;
        let (command, payload, request) =
            case_payload(&b.operation.id, phase, &plan, case, repeat)?;
        if op.session_id != b.record.session_id
            || op.owner.as_deref() != Some(owner)
            || op.status != OperationStatus::Running
            || op.command_id != command
            || op.payload != payload
        {
            return Err(bad("case dispatch authority differs"));
        }
        let digest:String=tx.query_row("SELECT CASE WHEN length(CAST(digest AS BLOB))=71 THEN digest END FROM operation_artifacts WHERE operation_id=?1 AND name='reproduction.request'",[child],|r|r.get(0))?;
        if r.artifact(&tx, &digest, zero_verification::MAX_PLAN_BYTES)?
            != serde_json::to_vec(&request)?
        {
            return Err(bad("physical request differs"));
        }
        let count:u64=tx.query_row("SELECT count(*) FROM events WHERE session_id=?1 AND kind='native_repair_effect_started' AND json_extract(payload,'$.operation_id')=?2",params![b.record.session_id,child],|r|r.get(0))?;
        if count != 0 {
            return Err(bad("physical effect already started"));
        }
        let receipt = json!({"repair_id":b.record.id,"operation_id":child,"parent_operation_id":b.operation.id,"request_sha256":digest,"owner":owner,"phase":phase});
        retain(
            &tx,
            &b,
            child,
            "native_repair.effect_start",
            &encode(&receipt)?,
        )?;
        append(
            &tx,
            &b.record.session_id,
            "native_repair_effect_started",
            &receipt,
        )?;
        open(&tx, &b, owner)?;
        tx.commit()?;
        Ok(())
    }
}
