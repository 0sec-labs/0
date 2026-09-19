use super::*;
use rusqlite::OpenFlags;
pub(super) fn inspect(root: &Path) -> Result<PythonSearchInspection> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::symlink_metadata(root)?;
        if !m.is_dir() || m.mode() & 0o077 != 0 {
            return Err(invalid("private search root required"));
        }
    }
    let root = root.canonicalize()?;
    let db = root.join("search.sqlite");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::symlink_metadata(&db)?;
        if !m.is_file() || m.nlink() != 1 {
            return Err(invalid("single-link search ledger required"));
        }
    }
    let mut conn = Connection::open_with_flags(
        &db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(2))?;
    let tx = conn.transaction()?;
    if tx.query_row("PRAGMA application_id", [], |r| r.get::<_, i64>(0))? != 1514493521
        || tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? != 1
    {
        return Err(invalid("search ledger identity"));
    }
    let (raw,sha,phase,charged,slots,selection,exposure):(String,String,String,u64,usize,Option<usize>,Option<String>)=tx.query_row("SELECT CASE WHEN length(CAST(intent AS BLOB))<=2097152 THEN intent END,intent_sha,phase,charged,slots,selection,exposure FROM search WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)))?;
    let intent: Intent = serde_json::from_str(&raw)?;
    intent.plan.validate()?;
    intent.context.validate()?;
    if intent.schema_version != 1
        || intent.root != root
        || intent.sha()? != sha
        || uuid::Uuid::parse_str(&intent.id).is_err()
    {
        return Err(invalid("search captured identity differs"));
    }
    let store = zero_store::Store::open_read_only(&intent.context.state_database)
        .map_err(|e| invalid(&e.to_string()))?;
    let source = Registry::open_read_only(root.join("candidate.sqlite"))?;
    if source.generation(&intent.plan.proposal.baseline)? != intent.baseline {
        return Err(invalid("search baseline differs"));
    }
    let count: usize = tx.query_row("SELECT count(*) FROM rounds", [], |r| r.get(0))?;
    if count > intent.plan.max_rounds || slots > intent.plan.max_development_attempts {
        return Err(invalid("search retained limits exceeded"));
    }
    let mut feedback: Vec<DevelopmentFeedback> = vec![];
    let mut measured = std::collections::BTreeMap::new();
    let mut total_charge = 0u64;
    let mut final_claim = None;
    let mut saw_stop = false;
    for idx in 0..count {
        let (command,request_raw,request_hash,operation,kind,source_sha,candidate,raw_feedback):(String,String,String,Option<String>,Option<String>,Option<String>,Option<String>,Option<String>)=tx.query_row("SELECT command,CASE WHEN length(CAST(request AS BLOB))<=262144 THEN request END,request_sha,CASE WHEN length(CAST(operation AS BLOB))<=2097152 THEN operation END,kind,source_sha,candidate,CASE WHEN length(CAST(feedback AS BLOB))<=262144 THEN feedback END FROM rounds WHERE idx=?1",[idx],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)))?;
        let request: ResponsesRequest = serde_json::from_str(&request_raw)?;
        if request_sha(&request)? != request_hash
            || command != format!("{}:search:{idx}", intent.context.command_id)
        {
            return Err(invalid("search round request identity"));
        }
        let rendered = render(&intent, &source, idx, &feedback)?;
        if serde_json::to_vec(&request)? != serde_json::to_vec(&rendered)? {
            return Err(invalid(
                "search request differs from complete frozen policy/history",
            ));
        }
        let Some(raw) = operation else {
            if kind.is_some()
                || source_sha.is_some()
                || candidate.is_some()
                || raw_feedback.is_some()
                || idx + 1 != count
                || selection.is_some()
                || exposure.is_some()
                || !matches!(
                    phase.as_str(),
                    "inference_running" | "inference_failed" | "cancelled" | "deadline"
                )
            {
                return Err(invalid("search evidence without inference"));
            }
            continue;
        };
        let operation: Operation = serde_json::from_str(&raw)?;
        let mut bytes = 2 * 1024 * 1024;
        if operation
            != store
                .get_operation_bounded(&operation.id, &mut bytes)
                .map_err(|e| invalid(&e.to_string()))?
            || operation.session_id != intent.context.session_id
            || operation.command_id != command
            || operation.payload["provider"] != intent.plan.proposal.provider
            || operation.payload["reservation"] != intent.plan.proposal.reservation
            || digest(&serde_json::to_vec(&operation.payload["request"])?) != request_hash
        {
            return Err(invalid("search original inference witness differs"));
        }
        if operation.status != zero_protocol::session::OperationStatus::Succeeded {
            if kind.is_some()
                || candidate.is_some()
                || raw_feedback.is_some()
                || idx + 1 != count
                || !matches!(phase.as_str(), "inference_failed" | "cancelled")
            {
                return Err(invalid(
                    "uncertain search inference cannot authorize continuation",
                ));
            }
            continue;
        }
        let completion: Completion = serde_json::from_value(
            operation
                .outcome
                .clone()
                .ok_or_else(|| invalid("search outcome absent"))?,
        )?;
        let charge = store
            .inspect_python_search_inference(
                &intent.context.session_id,
                &command,
                &operation.id,
                &request_hash,
            )
            .map_err(|e| invalid(&e.to_string()))?;
        if operation.status != zero_protocol::session::OperationStatus::Succeeded
            || completion.status != zero_protocol::model::CompletionStatus::Completed
            || !completion.usage_is_final
            || completion.error.is_some()
        {
            return Err(invalid("search inference not settled"));
        }
        total_charge = total_charge
            .checked_add(charge)
            .ok_or_else(|| invalid("search charge overflow"))?;
        let calls: Vec<_> = completion
            .content
            .iter()
            .filter_map(|c| match c {
                Content::ToolCall {
                    name, arguments, ..
                } => Some((name, arguments)),
                _ => None,
            })
            .collect();
        if let Some(kind) = kind {
            if calls.len() != 1 {
                return Err(invalid("search output tool count"));
            }
            let (name, args) = calls[0];
            if kind == "stop" {
                let out: PythonCandidateOutput = serde_json::from_value(args.clone())?;
                out.validate()?;
                if name != "submit_python_candidate"
                    || !matches!(out, PythonCandidateOutput::Stop { .. })
                    || phase != "stopped"
                    || idx + 1 != count
                {
                    return Err(invalid("search Stop proof differs"));
                }
                saw_stop = true;
                continue;
            }
            let source_bytes = if kind == "experiment" {
                if name != "experiment_python_candidate" {
                    return Err(invalid("experiment tool differs"));
                }
                let out: Experiment = serde_json::from_value(args.clone())?;
                PythonCandidateOutput::Propose {
                    source_utf8: out.source_utf8.clone(),
                    rationale: out.rationale,
                }
                .validate()?;
                out.source_utf8
            } else if kind == "selection" {
                if name != "submit_python_candidate" {
                    return Err(invalid("selection tool differs"));
                }
                let out: PythonCandidateOutput = serde_json::from_value(args.clone())?;
                out.validate()?;
                let PythonCandidateOutput::Propose { source_utf8, .. } = out else {
                    return Err(invalid("selection must propose"));
                };
                source_utf8
            } else {
                return Err(invalid("search round kind"));
            };
            let source_sha = source_sha.ok_or_else(|| invalid("source digest absent"))?;
            let candidate = candidate.ok_or_else(|| invalid("candidate absent"))?;
            if digest(source_bytes.as_bytes()) != source_sha
                || source.artifact(&source_sha)? != source_bytes.as_bytes()
            {
                return Err(invalid("search source identity"));
            }
            let mut plugin = intent.plugin.clone();
            plugin.entrypoint.artifact = zero_plugin::sha256(source_bytes.as_bytes());
            plugin.artifacts = vec![zero_plugin::Artifact {
                sha256: plugin.entrypoint.artifact.clone(),
                size: source_bytes.len() as u64,
            }];
            let component = digest(&serde_json::to_vec(&plugin)?);
            let mut manifest = intent.baseline.clone();
            manifest
                .components
                .insert(format!("plugin:{}", plugin.id), component.clone());
            if source.generation(&candidate)? != manifest
                || source.artifact(&component)? != serde_json::to_vec(&plugin)?
            {
                return Err(invalid("search candidate contract differs"));
            }
            if kind == "experiment" {
                if let Some(raw_feedback) = raw_feedback {
                    let mut q=tx.prepare("SELECT CASE WHEN length(CAST(evidence AS BLOB))<=262144 THEN evidence END FROM development_attempts WHERE round=?1 ORDER BY idx LIMIT 1537")?;
                    let attempts: Vec<crate::Attempt> = q
                        .query_map([idx], |r| r.get::<_, String>(0))?
                        .map(|r| Ok(serde_json::from_str(&r?)?))
                        .collect::<Result<_>>()?;
                    let cases: Vec<_> = intent
                        .plan
                        .proposal
                        .cases
                        .iter()
                        .filter(|c| c.lane == crate::Lane::Development)
                        .cloned()
                        .collect();
                    let report = development::feedback_from_attempts(
                        &source_sha,
                        &cases,
                        intent.plan.proposal.repeats,
                        &attempts,
                    )?;
                    if serde_json::to_value(&report)?
                        != serde_json::from_str::<Value>(&raw_feedback)?
                    {
                        return Err(invalid(
                            "Development feedback differs from retained measurements",
                        ));
                    }
                    if report.completed {
                        measured.insert(source_sha.clone(), candidate.clone());
                    }
                    feedback.push(report);
                }
            } else {
                if idx + 1 != count
                    || selection != Some(idx)
                    || measured.get(&source_sha) != Some(&candidate)
                {
                    return Err(invalid(
                        "selected source lacks preceding completed experiment",
                    ));
                }
                final_claim = Some(PythonHoldoutClaim {
                    session_id: intent.context.session_id.clone(),
                    command_id: command,
                    operation_id: operation.id,
                    request_sha256: request_hash,
                    intent_sha256: sha.clone(),
                    suite_sha256: intent.plan.proposal.suite_sha256()?,
                    candidate_sha256: candidate,
                    source_sha256: source_sha,
                });
            }
        }
    }
    if total_charge != charged {
        return Err(invalid("search cumulative accounting differs"));
    }
    if let Some(raw) = exposure {
        let receipt: zero_store::PythonHoldoutReceipt = serde_json::from_str(&raw)?;
        if final_claim.as_ref() != Some(&receipt.claim)
            || store
                .verify_python_holdout(&receipt.claim)
                .map_err(|e| invalid(&e.to_string()))?
                .receipt()
                != &receipt
        {
            return Err(invalid("search final exposure differs"));
        }
    }
    let evaluation = match std::fs::symlink_metadata(root.join("evaluation")) {
        Ok(_) => Some(crate::Evaluation::inspect(&root.join("evaluation"))?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    if let Some(evaluation) = &evaluation {
        let claim = final_claim
            .as_ref()
            .ok_or_else(|| invalid("evaluation lacks selection"))?;
        if evaluation.plan_digest
            != digest(&serde_json::to_vec(
                &intent
                    .plan
                    .proposal
                    .evaluation(claim.candidate_sha256.clone()),
            )?)
            || tx.query_row("SELECT exposure IS NULL FROM search", [], |r| {
                r.get::<_, bool>(0)
            })?
        {
            return Err(invalid(
                "search evaluation differs from selected plan/exposure",
            ));
        }
    }
    if phase == "completed"
        && evaluation
            .as_ref()
            .and_then(|e| e.report.as_ref())
            .is_none()
    {
        return Err(invalid("completed search lacks independent report"));
    }
    if phase == "stopped" && (!saw_stop || selection.is_some()) {
        return Err(invalid("stop cannot select a candidate"));
    }
    let session_budget = store
        .budget(&intent.context.session_id)
        .map_err(|e| invalid(&e.to_string()))?;
    tx.commit()?;
    Ok(PythonSearchInspection {
        session_budget,
        schema_version: 1,
        qualification: "Development search feedback is not independent eligibility; no production activation",
        intent_sha256: sha,
        phase,
        charged,
        rounds: count,
        development_attempts: slots,
        feedback,
        evaluation,
    })
}
