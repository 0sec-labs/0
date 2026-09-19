use super::*;
use rusqlite::OpenFlags;
use zero_store::{PythonHoldoutReceipt, Store};
#[cfg(unix)]
pub fn inspect(root: &Path) -> Result<PythonEvolutionInspection> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::symlink_metadata(root)?;
    if !metadata.is_dir() || metadata.mode() & 0o077 != 0 {
        return Err(invalid("private non-symlink Python proposal root required"));
    }
    let root = root.canonicalize()?;
    let path = root.join("proposal.sqlite");
    let before = std::fs::symlink_metadata(&path)?;
    if !before.is_file() || before.nlink() != 1 {
        return Err(invalid("single-link Python proposal ledger required"));
    }
    let mut conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(2))?;
    let after = std::fs::symlink_metadata(&path)?;
    if before.dev() != after.dev() || before.ino() != after.ino() || after.nlink() != 1 {
        return Err(invalid("Python proposal ledger replaced"));
    }
    let tx = conn.transaction()?;
    if tx.query_row("PRAGMA application_id", [], |r| r.get::<_, i64>(0))? != 1514493520
        || tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? != 1
    {
        return Err(invalid("unsupported Python proposal ledger"));
    }
    let (count,total):(usize,usize)=tx.query_row("SELECT count(*),coalesce(sum(length(CAST(intent AS BLOB))+length(CAST(request AS BLOB))+coalesce(length(CAST(operation AS BLOB)),0)+coalesce(length(CAST(exposure AS BLOB)),0)),0) FROM proposal",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
    if count != 1 || total > 4 * 1024 * 1024 {
        return Err(invalid("Python proposal ledger byte bounds"));
    }
    let (raw,intent_sha,request_raw,request_hash,phase,operation_raw,candidate,source_sha,exposure_raw):(String,String,String,String,String,Option<String>,Option<String>,Option<String>,Option<String>)=tx.query_row("SELECT intent,intent_sha,request,request_sha,phase,operation,candidate,source_sha,exposure FROM proposal WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?)))?;
    let intent: Intent = serde_json::from_str(&raw)?;
    intent.plan.validate()?;
    intent.context.validate()?;
    if uuid::Uuid::parse_str(&intent.controller_id).is_err()
        || intent.controller_root != root
        || intent.semantics != SEMANTICS
        || intent.sha()? != intent_sha
    {
        return Err(invalid("Python proposal captured intent differs"));
    }
    let request: ResponsesRequest = serde_json::from_str(&request_raw)?;
    if request_sha(&request)? != request_hash {
        return Err(invalid("Python proposal request identity differs"));
    }
    let source = Registry::open_read_only(root.join("candidate.sqlite"))?;
    let baseline = source.artifact(&format!(
        "sha256:{}",
        intent.plugin_manifest.entrypoint.artifact
    ))?;
    if source.generation(&intent.plan.baseline)? != intent.baseline_manifest
        || serde_json::to_vec(&render(
            &intent,
            std::str::from_utf8(&baseline).map_err(|_| invalid("baseline UTF-8"))?,
        )?)? != serde_json::to_vec(&request)?
    {
        return Err(invalid(
            "Python proposal rendered request or frozen baseline differs",
        ));
    }
    let store = Store::open_read_only(&intent.context.state_database)
        .map_err(|e| invalid(&e.to_string()))?;
    let operation: Option<Operation> = operation_raw
        .map(|raw| serde_json::from_str(&raw))
        .transpose()?;
    if let Some(op) = &operation {
        let mut remaining = 2 * 1024 * 1024;
        let retained = store
            .get_operation_bounded(&op.id, &mut remaining)
            .map_err(|e| invalid(&e.to_string()))?;
        if *op != retained
            || op.session_id != intent.context.session_id
            || op.command_id != intent.context.command_id
        {
            return Err(invalid(
                "Python proposal operation projection differs from original session",
            ));
        }
    }
    if let Some(candidate) = &candidate {
        let output = parsed(
            &intent,
            &request,
            operation
                .as_ref()
                .ok_or_else(|| invalid("candidate has no retained inference"))?,
        )?;
        let PythonCandidateOutput::Propose { source_utf8, .. } = output else {
            return Err(invalid("model stop cannot create a candidate"));
        };
        let (plugin, manifest) = source_only(&intent, &source_utf8)?;
        let component = manifest
            .components
            .get(&format!("plugin:{}", plugin.id))
            .ok_or_else(|| invalid("candidate component missing"))?;
        if source.generation(candidate)? != manifest
            || source.artifact(component)? != serde_json::to_vec(&plugin)?
            || source_sha.as_deref() != Some(digest(source_utf8.as_bytes()).as_str())
            || source.artifact(
                source_sha
                    .as_ref()
                    .ok_or_else(|| invalid("candidate source missing"))?,
            )? != source_utf8.as_bytes()
        {
            return Err(invalid("Python candidate source-only binding differs"));
        }
    } else if source_sha.is_some() {
        return Err(invalid("Python source without candidate"));
    }
    let exposure: Option<PythonHoldoutReceipt> =
        exposure_raw.map(|s| serde_json::from_str(&s)).transpose()?;
    if let Some(receipt) = &exposure {
        let op = operation
            .as_ref()
            .ok_or_else(|| invalid("exposure has no proposal"))?;
        let expected = PythonHoldoutClaim {
            session_id: intent.context.session_id.clone(),
            command_id: intent.context.command_id.clone(),
            operation_id: op.id.clone(),
            request_sha256: request_hash.clone(),
            intent_sha256: intent_sha.clone(),
            suite_sha256: intent.plan.suite_sha256()?,
            candidate_sha256: candidate
                .clone()
                .ok_or_else(|| invalid("exposure has no candidate"))?,
            source_sha256: source_sha
                .clone()
                .ok_or_else(|| invalid("exposure has no source"))?,
        };
        if receipt.claim != expected
            || store
                .verify_python_holdout(&expected)
                .map_err(|e| invalid(&e.to_string()))?
                .receipt()
                != receipt
        {
            return Err(invalid(
                "Python exposure projection differs from original Store witness",
            ));
        }
    }
    let evaluation = match std::fs::symlink_metadata(root.join("evaluation")) {
        Ok(_) => Some(Evaluation::inspect(&root.join("evaluation"))?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    if let Some(evaluation) = &evaluation {
        let candidate = candidate
            .clone()
            .ok_or_else(|| invalid("evaluation has no selected candidate"))?;
        if exposure.is_none()
            || evaluation.plan_digest
                != digest(&serde_json::to_vec(&intent.plan.evaluation(candidate))?)
        {
            return Err(invalid(
                "Python evaluation differs from frozen plan/exposure",
            ));
        }
    }
    if phase == "model_stop" {
        let output = parsed(
            &intent,
            &request,
            operation
                .as_ref()
                .ok_or_else(|| invalid("model stop lacks retained inference"))?,
        )?;
        if !matches!(output, PythonCandidateOutput::Stop { .. })
            || candidate.is_some()
            || exposure.is_some()
            || evaluation.is_some()
        {
            return Err(invalid("model stop differs from retained evidence"));
        }
    }
    if phase == "completed"
        && evaluation
            .as_ref()
            .and_then(|e| e.report.as_ref())
            .is_none()
    {
        return Err(invalid(
            "completed Python evaluation lacks independent report",
        ));
    }
    if !matches!(
        phase.as_str(),
        "ready"
            | "proposal_running"
            | "proposal_settled"
            | "candidate_ready"
            | "evaluation_starting"
            | "evaluation_running"
            | "model_stop"
            | "proposal_rejected"
            | "inference_failed"
            | "cancelled"
            | "deadline"
            | "exposure_rejected"
            | "evaluation_failed"
            | "completed"
    ) {
        return Err(invalid("invalid Python proposal phase"));
    }
    tx.commit()?;
    Ok(PythonEvolutionInspection {
        schema_version: 1,
        qualification: "offline_python_fixture_only_not_production_eligibility".into(),
        intent_sha256: intent_sha,
        request_sha256: request_hash,
        suite_sha256: intent.plan.suite_sha256()?,
        session_id: intent.context.session_id,
        command_id: intent.context.command_id,
        phase,
        operation_id: operation.map(|o| o.id),
        candidate,
        source_sha256: source_sha,
        exposure,
        evaluation,
    })
}
#[cfg(not(unix))]
pub fn inspect(_: &Path) -> Result<PythonEvolutionInspection> {
    Err(invalid("Python proposal inspection requires Unix"))
}

pub(super) fn check_retry(
    root: &Path,
    plan: &PythonEvolutionPlan,
    context: &PythonProposalContext,
    grants: &HostGrants,
) -> Result<()> {
    inspect(root)?;
    let conn = Connection::open_with_flags(
        root.join("proposal.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    let raw:String=conn.query_row("SELECT CASE WHEN length(CAST(intent AS BLOB))<=2097152 THEN intent END FROM proposal WHERE singleton=1",[],|r|r.get(0))?;
    let intent: Intent = serde_json::from_str(&raw)?;
    if serde_json::to_vec(&intent.plan)? != serde_json::to_vec(plan)?
        || intent.context != *context
        || digest(&grants.artifact_bytes()?) != intent.plan.host_policy_artifact
    {
        return Err(invalid(
            "Python proposal retry differs from captured host intent",
        ));
    }
    Ok(())
}
