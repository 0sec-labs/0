use super::*;
use zero_protocol::verification::Disposition;
impl Engine {
    pub(crate) async fn verify_web_hypothesis(
        &self,
        session: String,
        command: String,
        mut request: WebVerificationRequest,
        events: mpsc::Sender<ExecutionEvent>,
    ) -> Result<Reply, EngineError> {
        let receiver = {
            let mut control = lock(&self.shared.control)?;
            let frozen = {
                let store = lock(&self.shared.store)?;
                match store.get_operation_by_command(&session, &command) {
                    Ok(operation) => {
                        if operation.payload["kind"] != "host_web_verification" {
                            return Err(error("conflicting web verification retry"));
                        }
                        let frozen =
                            FrozenPlan::from_intent(&operation.payload["execution_intent"])
                                .map_err(error)?;
                        let policy = serde_json::from_value(
                            frozen.intent()["inherited_tool_approval_policy"].clone(),
                        )?;
                        let retry = FrozenPlan::new(
                            &session,
                            request.plan.clone(),
                            frozen.intent()["http_context"].clone(),
                            policy,
                        )
                        .map_err(error)?;
                        request.plan = retry.plan().clone();
                        if retry.intent() != frozen.intent()
                            || serde_json::to_value(&request)? != operation.payload["request"]
                        {
                            return Err(error("conflicting web verification retry"));
                        }
                        store.validate_web_verification_parent(&operation)?;
                        let result = if operation.outcome.is_some()
                            || operation.status == OperationStatus::Unknown
                        {
                            Some(
                                provenance::report(
                                    &store,
                                    &session,
                                    &frozen.plan().web_operation_id,
                                    &operation.id,
                                )?
                                .outcome,
                            )
                        } else {
                            None
                        };
                        return Ok(Reply::WebVerification {
                            operation,
                            result,
                            duplicate: true,
                        });
                    }
                    Err(zero_store::Error::NotFound(_)) => {}
                    Err(e) => return Err(e.into()),
                }
                prepare(&store, &session, request.plan.clone())?
            };
            if control.closing
                || control.active.contains_key(&session)
                || control.active.len() >= 64
            {
                return Err(error("engine closing or session busy"));
            }
            if request.expected_intent_sha256 != frozen.intent_sha256()
                || request
                    .approved_intent_sha256
                    .as_deref()
                    .is_some_and(|s| s != frozen.intent_sha256())
                || frozen.approval_required()
                    && request.approved_intent_sha256.as_deref() != Some(frozen.intent_sha256())
            {
                return Err(error(
                    "web verification intent or explicit plan approval differs",
                ));
            }
            request.plan = frozen.plan().clone();
            let identity = frozen.intent()["http_context"].clone();
            let name = identity["profile_name"]
                .as_str()
                .ok_or_else(|| error("HTTP profile name missing"))?;
            let client = lock(&self.shared.http)?
                .get(name)
                .cloned()
                .ok_or_else(|| error("HTTP profile not configured"))?;
            if identity["profile"] != serde_json::to_value(client.policy())?
                || identity["profile_sha256"] != client.policy_sha256()
            {
                return Err(error("HTTP profile changed since web review"));
            }
            for (index, case) in frozen.plan().cases.iter().enumerate() {
                let prepared = client.prepare(case.request.clone()).map_err(error)?;
                // Owned batch admission has a 4 MiB payload ceiling. Check it
                // before any parent admission; Store operation IDs are UUIDs.
                let payload = provenance::child_payload(
                    "00000000-0000-0000-0000-000000000000",
                    &frozen,
                    index,
                    frozen.plan().repeats - 1,
                    prepared.intent(),
                )?;
                if serde_json::to_vec(&payload)?.len() > 4 * 1024 * 1024 {
                    return Err(error(
                        "web verification child exceeds owned-admission bound",
                    ));
                }
            }
            let context = agent_http::Context {
                identity,
                client,
                output_version: 2,
            };
            let operation = {
                let mut store = lock(&self.shared.store)?;
                let admission=store.admit_command(&session,&command,&json!({"kind":"host_web_verification","request":request,"execution_intent":frozen.intent(),"intent_sha256":frozen.intent_sha256(),"plan_sha256":frozen.plan_sha256(),"http_context":context.identity,"http_output_version":2}))?;
                store.begin_operation(&admission.operation.id, &self.shared.owner)?
            };
            let cancel = CancellationToken::new();
            control.active.insert(
                session.clone(),
                Active {
                    command_id: command.clone(),
                    execution_id: command,
                    cancel: cancel.clone(),
                },
            );
            emit_admission(&events, &operation, &operation.command_id, &cancel);
            let (sender, receiver) = oneshot::channel();
            let mut guard =
                WorkerGuard::new(self.shared.clone(), &session, &operation.id, cancel.clone());
            tokio::spawn(async move {
                let result = run(&guard.shared, &operation, frozen, context, cancel).await;
                guard.settled = result.is_ok();
                drop(guard);
                let _ = sender.send(result);
            });
            receiver
        };
        receiver
            .await
            .map_err(|_| error("web verification owner stopped before settlement"))?
    }
}
pub(super) fn status(assessment: &WebVerificationAssessment) -> OperationStatus {
    match assessment.disposition {
        Disposition::ObservedForPlan | Disposition::NotObserved => OperationStatus::Succeeded,
        Disposition::Inconclusive => OperationStatus::Failed,
        Disposition::Cancelled => OperationStatus::Cancelled,
        Disposition::Unknown => OperationStatus::Unknown,
    }
}
async fn run(
    shared: &Arc<Shared>,
    parent: &Operation,
    frozen: FrozenPlan,
    context: agent_http::Context,
    cancel: CancellationToken,
) -> Result<Reply, EngineError> {
    let mut artifacts = std::collections::BTreeMap::new();
    for (name, value) in [
        (
            "web.verification.plan",
            serde_json::to_value(frozen.plan())?,
        ),
        ("web.verification.intent", frozen.intent().clone()),
    ] {
        let digest = lock(&shared.store)?.retain_operation_artifact(
            &parent.id,
            &shared.owner,
            name,
            &serde_json::to_vec(&value)?,
        )?;
        artifacts.insert(name.into(), digest);
    }
    let mut attempts = vec![];
    let mut stop = None;
    'matrix: for repeat in 0..frozen.plan().repeats {
        for (index, case) in frozen.plan().cases.iter().enumerate() {
            if cancel.is_cancelled() {
                stop = Some(WebVerificationStop::Cancelled);
                break 'matrix;
            }
            let prepared = context
                .client
                .prepare(case.request.clone())
                .map_err(error)?;
            let payload =
                provenance::child_payload(&parent.id, &frozen, index, repeat, prepared.intent())?;
            let child = {
                let mut store = lock(&shared.store)?;
                store
                    .admit_owned_batch(
                        &parent.session_id,
                        &shared.owner,
                        &[(format!("{}:web:case:{index}:{repeat}", parent.id), payload)],
                    )?
                    .pop()
                    .ok_or_else(|| error("owned web child admission missing"))?
            };
            let child =
                agent_http::execute_admitted(shared, child, &context, prepared, cancel.clone())
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
    let matrix = json!({"schema_version":1,"intent_sha256":frozen.intent_sha256(),"attempts":attempts,"stop":stop,"children":children});
    let digest = lock(&shared.store)?.retain_operation_artifact(
        &parent.id,
        &shared.owner,
        "web.verification.matrix",
        &serde_json::to_vec(&matrix)?,
    )?;
    artifacts.insert("web.verification.matrix".into(), digest);
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
    let operation = if status(&result.assessment) == OperationStatus::Unknown {
        store.mark_operation_unknown_with_outcome(&parent.id, &shared.owner, &value)?
    } else {
        store.settle_operation(
            &parent.id,
            &shared.owner,
            status(&result.assessment),
            &value,
        )?
    };
    Ok(Reply::WebVerification {
        operation,
        result: Some(result),
        duplicate: false,
    })
}
