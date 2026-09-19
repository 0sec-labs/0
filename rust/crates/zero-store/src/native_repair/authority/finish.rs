use super::*;
use zero_protocol::repair::{RepairValidationOutcome, RepairValidationStatus};
impl Store {
    /// Choose terminal status, retain its exact summary, and settle in one write
    /// transaction. A durable stop cannot race a previously prepared success.
    pub fn settle_native_repair(
        &mut self,
        key: &str,
        owner: &str,
        outcome: &RepairValidationOutcome,
        cancel_requested: bool,
    ) -> Result<Operation> {
        if encode(outcome)?.len() > MAX_INTENT || outcome.vulnerability_reportable {
            return Err(bad("repair outcome bound or unsupported finding claim"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut r = Reader::new();
        let b = bound(&tx, key, &mut r)?;
        epoch(&tx, owner)?;
        if b.operation.owner.as_deref() != Some(owner)
            || b.operation.status != OperationStatus::Running
        {
            return Err(bad("finalization requires current owned Running parent"));
        }
        let mut output = outcome.clone();
        if output.phases.len() > 2
            || output
                .phases
                .iter()
                .enumerate()
                .any(|(i, p)| p.name != ["candidate", "reconstructed"][i])
        {
            return Err(bad("repair phase summary order differs"));
        }
        let source = bound_source(&tx, &b, &mut r)?;
        if let Some((_, binding, materialize)) = &source {
            if output.original_plan_digest.as_deref() != Some(&binding.logical_plan_sha256)
                || output.candidate_receipt.as_ref().is_some_and(|receipt| {
                    zero_repair::expected_receipt(materialize).ok().as_ref() != Some(receipt)
                })
            {
                return Err(bad("repair summary source authority differs"));
            }
        } else if output.original_plan_digest.is_some()
            || output.candidate_receipt.is_some()
            || !output.phases.is_empty()
        {
            return Err(bad("repair summary before source binding"));
        }
        let mut q=tx.prepare("SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END,CASE WHEN length(CAST(digest AS BLOB))=71 THEN digest END FROM operation_artifacts WHERE operation_id=?1 AND name GLOB 'repair.*' ORDER BY name LIMIT 17")?;
        let refs = q
            .query_map([&b.operation.id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<std::collections::BTreeMap<_, _>, _>>()?;
        drop(q);
        if refs.len() > 16 || refs != output.artifacts {
            return Err(bad("repair artifact attribution differs"));
        }
        for phase in &output.phases {
            let (plan, _) = bound_candidate(&tx, &b, &phase.name, &mut r)?
                .ok_or_else(|| bad("summary candidate absent"))?;
            if plan.digest() != phase.derived_plan_digest {
                return Err(bad("summary phase plan differs"));
            }
            if let Some(completed) = completed_phase(&tx, &b, &phase.name, &mut r)? {
                if encode(&completed)? != encode(&phase.observations)? {
                    return Err(bad("summary differs from completed phase"));
                }
            }
        }
        let unresolved:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE session_id=?1 AND id!=?2 AND status IN ('admitted','running','unknown'))",params![b.record.session_id,b.operation.id],|r|r.get(0))?;
        if unresolved || !output.cleanup_recovery.is_empty() {
            output.status = RepairValidationStatus::Unknown;
        }
        if output.status == RepairValidationStatus::ValidatedCandidateForPlan {
            if output.error.is_some()
                || output.phases.len() != 2
                || output.candidate_receipt.is_none()
            {
                return Err(bad("validated repair lacks complete clean matrices"));
            }
            for phase in ["candidate", "reconstructed"] {
                completed_phase(&tx, &b, phase, &mut r)?
                    .ok_or_else(|| bad("validated repair lacks independently completed phase"))?;
            }
        }
        let expired = now()? >= b.record.deadline_at_ms;
        let closed = b.close.is_some() || expired || cancel_requested;
        if b.close.is_none() && (expired || cancel_requested) {
            close_in_transaction(
                &tx,
                &b,
                owner,
                if expired {
                    ReviewCloseReason::Deadline
                } else {
                    ReviewCloseReason::Cancelled
                },
            )?;
        }
        if closed && output.status != RepairValidationStatus::Unknown {
            output.status = RepairValidationStatus::Cancelled;
        }
        let status = match output.status {
            RepairValidationStatus::ValidatedCandidateForPlan => OperationStatus::Succeeded,
            RepairValidationStatus::NotValidated => OperationStatus::Failed,
            RepairValidationStatus::Cancelled => OperationStatus::Cancelled,
            RepairValidationStatus::Unknown => OperationStatus::Unknown,
        };
        let summary = json!({"status":output.status,"original_plan_digest":output.original_plan_digest,"candidate_receipt":output.candidate_receipt,"phases":output.phases,"vulnerability_reportable":false});
        let digest = retain(
            &tx,
            &b,
            &b.operation.id,
            "repair.validation_summary",
            &encode(&summary)?,
        )?;
        output
            .artifacts
            .insert("repair.validation_summary".into(), digest);
        let value = serde_json::to_value(output)?;
        let bytes = encode(&value)?;
        if bytes.len() > MAX_INTENT {
            return Err(bad("final outcome byte bound"));
        }
        let text = match status {
            OperationStatus::Succeeded => "succeeded",
            OperationStatus::Failed => "failed",
            OperationStatus::Cancelled => "cancelled",
            OperationStatus::Unknown => "unknown",
            _ => return Err(bad("unexpected final status")),
        };
        tx.execute(
            "UPDATE operations SET status=?2,outcome=?3 WHERE id=?1",
            params![b.operation.id, text, String::from_utf8(bytes).map_err(bad)?],
        )?;
        let mut op = b.operation;
        op.status = status;
        op.outcome = Some(value);
        append(
            &tx,
            &op.session_id,
            if status == OperationStatus::Unknown {
                "operation_unknown"
            } else {
                "operation_settled"
            },
            &serde_json::to_value(&op)?,
        )?;
        tx.commit()?;
        Ok(op)
    }
}
