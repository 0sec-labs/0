use super::*;
struct Guard<'a> {
    shared: &'a Shared,
    id: String,
    settled: bool,
}
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        if !self.settled {
            if let Ok(mut store) = self.shared.store.lock() {
                let _ = store.mark_operation_unknown(
                    &self.id,
                    &self.shared.owner,
                    "experiment owner ended without terminal evidence",
                );
            }
        }
    }
}
pub(crate) async fn execute_admitted(
    shared: &Arc<Shared>,
    operation: Operation,
    context: &agent_http::Context,
    frozen: FrozenExperiment,
    cancel: CancellationToken,
) -> Result<Operation, EngineError> {
    if operation.status != OperationStatus::Running
        || operation.owner.as_deref() != Some(&shared.owner)
        || operation.payload["execution_intent"] != *frozen.intent()
        || operation.payload["http_context"] != context.identity
        || context.output_version != 2
    {
        return Err(error(
            "admitted experiment differs from captured invocation",
        ));
    }
    let mut guard = Guard {
        shared,
        id: operation.id.clone(),
        settled: false,
    };
    {
        let store = lock(&shared.store)?;
        let (checked, _, _) = agent_web_experiment::origin(&store, &operation)?;
        if checked.intent() != frozen.intent() {
            return Err(error("experiment origin changed"));
        }
    }
    let mut artifacts = std::collections::BTreeMap::new();
    for (name, value) in [
        ("experiment.intent", frozen.intent().clone()),
        (
            "experiment.hypothesis",
            serde_json::to_value(frozen.hypothesis())?,
        ),
    ] {
        let digest = lock(&shared.store)?.retain_operation_artifact(
            &operation.id,
            &shared.owner,
            name,
            &serde_json::to_vec(&value)?,
        )?;
        artifacts.insert(name.into(), digest);
    }
    let mut attempts = vec![];
    let mut stop = None;
    'matrix: for repeat in 0..frozen.repeats() {
        for (index, case) in frozen.cases().iter().enumerate() {
            if cancel.is_cancelled() {
                stop = Some(WebVerificationStop::Cancelled);
                break 'matrix;
            }
            let prepared = context
                .client
                .prepare(case.request.clone())
                .map_err(error)?;
            let payload = frozen
                .child_payload(&operation.id, index, repeat)
                .map_err(error)?;
            if payload["request"] != serde_json::to_value(prepared.intent())? {
                return Err(error("prepared experiment request changed"));
            }
            let child = lock(&shared.store)?
                .admit_owned_batch(
                    &operation.session_id,
                    &shared.owner,
                    &[(
                        format!("{}:web:case:{index}:{repeat}", operation.id),
                        payload,
                    )],
                )?
                .pop()
                .ok_or_else(|| error("experiment child missing"))?;
            let child =
                agent_http::execute_admitted(shared, child, context, prepared, cancel.clone())
                    .await?;
            let attempt = {
                let store = lock(&shared.store)?;
                provenance::attempt(&store, &frozen, index, repeat, &child)?
            };
            let terminal = match child.status {
                OperationStatus::Succeeded => None,
                OperationStatus::Unknown => Some(WebVerificationStop::Unknown),
                OperationStatus::Cancelled => Some(WebVerificationStop::Cancelled),
                _ => Some(WebVerificationStop::PreparationFailed),
            };
            attempts.push(attempt);
            if terminal.is_some() {
                stop = terminal;
                break 'matrix;
            }
        }
    }
    let children = attempts
        .iter()
        .map(|a| a.operation_id.clone())
        .collect::<Vec<_>>();
    let value = json!({"schema_version":1,"intent_sha256":frozen.intent_sha256(),"attempts":attempts,"stop":stop,"children":children});
    let digest = lock(&shared.store)?.retain_operation_artifact(
        &operation.id,
        &shared.owner,
        "experiment.matrix",
        &serde_json::to_vec(&value)?,
    )?;
    artifacts.insert("experiment.matrix".into(), digest);
    let assessment = zero_web_verification::assess(&frozen, &attempts, stop).map_err(error)?;
    let result = WebVerificationOutcome {
        assessment,
        attempts,
        stop,
        artifacts,
        children,
        error: None,
    };
    let mut store = lock(&shared.store)?;
    let value = serde_json::to_value(&result)?;
    let op = if status(&result.assessment) == OperationStatus::Unknown {
        store.mark_operation_unknown_with_outcome(&operation.id, &shared.owner, &value)?
    } else {
        store.settle_operation(
            &operation.id,
            &shared.owner,
            status(&result.assessment),
            &value,
        )?
    };
    guard.settled = true;
    Ok(op)
}
