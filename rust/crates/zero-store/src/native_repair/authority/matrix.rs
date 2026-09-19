//! A completed phase is re-assessed from exact retained observations, never a
//! caller-supplied success bit. Partial matrices cannot authorize reconstruction.
use super::*;
use zero_protocol::verification::{Assessment, Evidence};
pub(super) fn validate(
    conn: &Connection,
    b: &Bound,
    phase: &str,
    outcome: &ReproductionOutcome,
    r: &mut Reader,
) -> Result<()> {
    let (plan, _) =
        bound_candidate(conn, b, phase, r)?.ok_or_else(|| bad("phase candidate absent"))?;
    let required = plan.plan().cases.len() * plan.plan().repeats;
    if outcome.children.len() != required
        || outcome.artifacts.len() != 3
        || outcome.error.is_some()
        || outcome.stop_reason.is_some()
        || !outcome.external_effects_started
    {
        return Err(bad("complete phase requires every observed case"));
    }
    let mut read = |suffix: &str, max: usize| -> Result<Vec<u8>> {
        let name = format!("{phase}.{suffix}");
        let (digest, bytes) = attached(conn, b, &name, r, max)?;
        if outcome.artifacts.get(&name) != Some(&digest) {
            return Err(bad("phase artifact attribution differs"));
        }
        Ok(bytes)
    };
    if read("plan", zero_verification::MAX_PLAN_BYTES)? != serde_json::to_vec(plan.plan())? {
        return Err(bad("phase plan differs"));
    }
    let index: Vec<Value> = serde_json::from_slice(&read("evidence_index", MAX_INTENT)?)?;
    let retained: Assessment = serde_json::from_slice(&read("assessment", 65536)?)?;
    if index.len() != required {
        return Err(bad("phase index omitted a case"));
    }
    let mut evidence = Vec::with_capacity(required);
    let mut total = 0usize;
    for (ordinal, id) in outcome.children.iter().enumerate() {
        let case_index = ordinal / plan.plan().repeats;
        let repeat = ordinal % plan.plan().repeats;
        let (command, payload, request) =
            case_payload(&b.operation.id, phase, &plan, case_index, repeat)?;
        let child = workflow::operation(conn, id, r)?;
        if child.session_id != b.record.session_id
            || child.owner != b.operation.owner
            || child.command_id != command
            || child.payload != payload
            || child.status != OperationStatus::Succeeded
        {
            return Err(bad("phase case identity or status differs"));
        }
        let mut q=conn.prepare("SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END,CASE WHEN length(CAST(digest AS BLOB))=71 THEN digest END FROM operation_artifacts WHERE operation_id=?1 ORDER BY name LIMIT 4")?;
        let refs = q
            .query_map([id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<std::collections::BTreeMap<_, _>, _>>()?;
        if refs.len() != 3 || !refs.contains_key("native_repair.effect_start") {
            return Err(bad("phase case artifact inventory differs"));
        }
        let req = refs
            .get("reproduction.request")
            .ok_or_else(|| bad("case request absent"))?;
        let obs = refs
            .get("reproduction.evidence")
            .ok_or_else(|| bad("case evidence absent"))?;
        if index[ordinal]
            != json!({"child_operation":id,"case_id":plan.plan().cases[case_index].id,"repeat":repeat,"request_artifact":req,"evidence_artifact":obs})
            || r.artifact(conn, req, zero_verification::MAX_PLAN_BYTES)?
                != serde_json::to_vec(&request)?
        {
            return Err(bad("phase ordered request index differs"));
        }
        let bytes = r.artifact(conn, obs, crate::MAX_ARTIFACT_BYTES)?;
        total = total
            .checked_add(bytes.len())
            .ok_or_else(|| bad("matrix bytes overflow"))?;
        if total > zero_verification::MAX_EVIDENCE_BYTES {
            return Err(bad("matrix evidence byte bound"));
        }
        let item: Evidence = serde_json::from_slice(&bytes)?;
        if bytes != serde_json::to_vec(&item)?
            || serde_json::to_vec(&item.request)? != serde_json::to_vec(&request)?
            || item.case_id != plan.plan().cases[case_index].id
            || item.repeat != repeat
            || child.outcome
                != Some(
                    json!({"request_artifact":req,"evidence_artifact":obs,"status":item.result.status,"exit_code":item.result.exit_code,"cleanup":item.result.cleanup}),
                )
        {
            return Err(bad("phase observed evidence or outcome differs"));
        }
        evidence.push(item);
    }
    let reassessed = zero_verification::assess(&plan, &evidence).map_err(bad)?;
    if reassessed.disposition != Disposition::ObservedForPlan
        || reassessed.vulnerability_reportable
        || encode(&retained)? != encode(&reassessed)?
        || encode(&outcome.assessment)? != encode(&Some(reassessed))?
    {
        return Err(bad("phase independently observed result differs"));
    }
    Ok(())
}
