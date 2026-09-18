use super::*;
pub(crate) fn effect_origin(
    store: &Store,
    effect: &Operation,
) -> Result<(Operation, Operation), EngineError> {
    let parent_id = effect.payload["parent_operation"]
        .as_str()
        .ok_or_else(|| error("experiment HTTP parent missing"))?;
    let parent = store.get_operation(parent_id)?;
    let (frozen, _, inference) = agent_web_experiment::origin(store, &parent)?;
    let origin = &effect.payload["origin"];
    let index = origin["case_index"]
        .as_u64()
        .and_then(|v| usize::try_from(v).ok())
        .ok_or_else(|| error("experiment case index missing"))?;
    let repeat = origin["repeat_index"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| error("experiment repeat missing"))?;
    if effect.session_id != parent.session_id
        || effect.command_id != format!("{}:web:case:{index}:{repeat}", parent.id)
        || effect.payload
            != frozen
                .child_payload(&parent.id, index, repeat)
                .map_err(error)?
    {
        return Err(error("HTTP child differs from frozen experiment"));
    }
    Ok((parent, inference))
}
pub(super) fn attempt(
    store: &Store,
    frozen: &FrozenExperiment,
    index: usize,
    repeat: u32,
    child: &Operation,
) -> Result<WebVerificationAttempt, EngineError> {
    effect_origin(store, child)?;
    let mut attempt = WebVerificationAttempt {
        case_name: frozen.cases()[index].name.clone(),
        repeat_index: repeat,
        operation_id: child.id.clone(),
        operation_status: child.status,
        request_sha256: frozen.request_sha256(index, repeat).map_err(error)?,
        response_manifest_sha256: None,
        status: None,
        body_sha256: None,
        complete: false,
        possible_dispatch: false,
    };
    let dispatches = store.read_http_dispatches(&child.session_id, &child.id)?;
    if child.status == OperationStatus::Failed
        && child.outcome
            == Some(
                json!({"error_code":"http_preparation_failed","external_effects_started":false}),
            )
        && dispatches.is_empty()
    {
        return Ok(attempt);
    }
    if interrupted(child) {
        store.validate_unknown_operation(child)?;
        // A recovery witness establishes uncertainty, not a response. Check all
        // surviving artifact hashes without pretending an uncommitted body is complete.
        for digest in store.operation_artifacts(&child.id)?.values() {
            store.artifact(digest)?;
        }
        attempt.possible_dispatch = !dispatches.is_empty();
        return Ok(attempt);
    }
    let (manifest, outcome, _body) = agent_http::checked_evidence(store, child)?;
    attempt.response_manifest_sha256 = child
        .outcome
        .as_ref()
        .and_then(|v| v["http_response_artifact"].as_str())
        .map(str::to_owned);
    attempt.status = outcome.response.as_ref().map(|r| r.status);
    attempt.body_sha256 = manifest["body"]["sha256"].as_str().map(str::to_owned);
    attempt.complete = child.status == OperationStatus::Succeeded
        && outcome.disposition == zero_http::HttpDisposition::CompleteResponse;
    attempt.possible_dispatch =
        !dispatches.is_empty() || outcome.dispatch == zero_http::DispatchState::PossiblyDispatched;
    Ok(attempt)
}
fn artifact(
    store: &Store,
    parent: &Operation,
    name: &str,
    expected: &Value,
) -> Result<(), EngineError> {
    let attachments = store.operation_artifacts(&parent.id)?;
    let digest = attachments
        .get(name)
        .ok_or_else(|| error("web experiment artifact missing"))?;
    let actual: Value = serde_json::from_slice(&store.artifact(digest)?)?;
    if &actual != expected {
        return Err(error("web experiment artifact differs"));
    }
    Ok(())
}
fn interrupted(operation: &Operation) -> bool {
    operation.status == OperationStatus::Unknown
        && match &operation.outcome {
            None => true,
            Some(value) => value
                .as_object()
                .is_some_and(|o| o.len() == 1 && o.get("reason").is_some_and(Value::is_string)),
        }
}
pub(crate) fn load(
    store: &Store,
    parent: &Operation,
) -> Result<WebVerificationOutcome, EngineError> {
    let (frozen, _, _) = agent_web_experiment::origin(store, parent)?;
    let session = &parent.session_id;
    let id = &parent.id;
    let recovered = interrupted(parent);
    if recovered {
        store.validate_unknown_operation(parent)?;
    }
    let attachments = store.operation_artifacts(&parent.id)?;
    for (name, value) in [
        (
            "experiment.hypothesis",
            serde_json::to_value(frozen.hypothesis())?,
        ),
        ("experiment.intent", frozen.intent().clone()),
    ] {
        if attachments.contains_key(name) || !recovered {
            artifact(store, parent, name, &value)?;
        }
    }
    let retained: Option<WebVerificationOutcome> = if recovered {
        None
    } else {
        Some(serde_json::from_value(parent.outcome.clone().ok_or_else(
            || error("web experiment has no retained settlement"),
        )?)?)
    };
    if let Some(outcome) = &retained {
        if outcome.attempts.len() > 24 || outcome.artifacts != attachments {
            return Err(error("web experiment matrix/artifact index differs"));
        }
        artifact(
            store,
            parent,
            "experiment.matrix",
            &json!({"schema_version":1,"intent_sha256":frozen.intent_sha256(),"attempts":outcome.attempts,"stop":outcome.stop,"children":outcome.children}),
        )?;
    }
    let mut actual = vec![];
    let mut missing = false;
    for repeat in 0..frozen.repeats() {
        for index in 0..frozen.cases().len() {
            match store
                .get_operation_by_command(session, &format!("{id}:web:case:{index}:{repeat}"))
            {
                Ok(child) => {
                    if missing {
                        return Err(error("web experiment matrix is not a prefix"));
                    }
                    actual.push(attempt(store, &frozen, index, repeat, &child)?);
                }
                Err(zero_store::Error::NotFound(_)) => missing = true,
                Err(e) => return Err(e.into()),
            }
        }
    }
    let stop = retained
        .as_ref()
        .map(|r| r.stop)
        .unwrap_or(Some(WebVerificationStop::Unknown));
    let assessment = zero_web_verification::assess(&frozen, &actual, stop).map_err(error)?;
    let children = actual
        .iter()
        .map(|a| a.operation_id.clone())
        .collect::<Vec<_>>();
    let outcome = if let Some(outcome) = retained {
        if serde_json::to_value(&actual)? != serde_json::to_value(&outcome.attempts)?
            || children != outcome.children
            || serde_json::to_value(&assessment)? != serde_json::to_value(&outcome.assessment)?
            || status(&assessment) != parent.status
        {
            return Err(error(
                "web experiment evidence/assessment/settlement differs",
            ));
        }
        outcome
    } else {
        // Retained terminal matrix, if any, still must agree with actual children.
        // Parent recovery always dominates its pre-settlement proposed assessment.
        if let Some(digest) = attachments.get("experiment.matrix") {
            let value: Value = serde_json::from_slice(&store.artifact(digest)?)?;
            if value["schema_version"] != 1
                || value["intent_sha256"] != frozen.intent_sha256()
                || value["attempts"] != serde_json::to_value(&actual)?
                || value["children"] != serde_json::to_value(&children)?
            {
                return Err(error("interrupted experiment matrix differs"));
            }
        }
        WebVerificationOutcome {
            assessment,
            attempts: actual,
            stop,
            children,
            artifacts: attachments,
            error: Some(
                "experiment owner ended before terminal settlement; no automatic replay".into(),
            ),
        }
    };
    Ok(outcome)
}
