use super::*;
use tokio::task::JoinSet;
use zero_protocol::agent::AgentStatus;

pub(crate) struct JoinedTasks {
    tasks: JoinSet<(usize, Result<Reply, EngineError>)>,
    current: Option<RunningGroup>,
    pub used: usize,
}
struct RunningGroup {
    group: Operation,
    children: Vec<Operation>,
    next: usize,
}
impl JoinedTasks {
    pub fn new() -> Self {
        Self {
            tasks: JoinSet::new(),
            current: None,
            used: 0,
        }
    }
    /// Kept outside the caught round future: dropping that future cannot abort its owners.
    pub async fn drain(
        &mut self,
        shared: &Arc<Shared>,
        cancel: &CancellationToken,
    ) -> Result<(), EngineError> {
        if self.current.is_none() {
            return Ok(());
        }
        cancel.cancel();
        while self.tasks.join_next().await.is_some() {}
        let Some(group) = self.current.take() else {
            return Ok(());
        };
        let mut store = lock(&shared.store)?;
        for (index, child) in group.children.iter().enumerate() {
            if matches!(
                store.get_operation(&child.id)?.status,
                OperationStatus::Running | OperationStatus::Admitted
            ) {
                if index >= group.next {
                    store.settle_operation(
                        &child.id,
                        &shared.owner,
                        OperationStatus::Cancelled,
                        &cancelled(),
                    )?;
                } else {
                    store.mark_operation_unknown(
                        &child.id,
                        &shared.owner,
                        "joined owner failed before durable child settlement",
                    )?;
                }
            }
        }
        store.mark_operation_unknown(
            &group.group.id,
            &shared.owner,
            "joined group failed; child receipts require reconciliation",
        )?;
        Ok(())
    }
}
struct ChildGuard {
    shared: Arc<Shared>,
    operation: String,
    cancel: CancellationToken,
    settled: bool,
    _completion: WorkerCompletion,
}
impl ChildGuard {
    fn new(shared: Arc<Shared>, operation: String, cancel: CancellationToken) -> Self {
        shared.workers.count.fetch_add(1, Ordering::AcqRel);
        let completion = WorkerCompletion(Arc::clone(&shared.workers));
        Self {
            shared,
            operation,
            cancel,
            settled: false,
            _completion: completion,
        }
    }
}
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if !self.settled {
            self.cancel.cancel();
            if let Ok(mut control) = self.shared.control.lock() {
                control.closing = true;
                for active in control.active.values() {
                    active.cancel.cancel();
                }
                if let Ok(mut store) = self.shared.store.lock() {
                    let _ = store.mark_operation_unknown(
                        &self.operation,
                        &self.shared.owner,
                        "delegated owner stopped without settlement",
                    );
                }
            }
        }
        // Root alone owns/removes control.active. Completion holds shutdown until this drops.
    }
}
fn cancelled() -> Value {
    json!({"status":"cancelled","text":"","turns":0,"tool_calls":0,"error":"joined child cancelled before dispatch","external_effects_started":false})
}
pub(crate) struct JoinedResult {
    pub output: String,
    pub uncertain: bool,
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_joined(
    shared: &Arc<Shared>,
    session: &str,
    parent: &str,
    command: &str,
    call_id: &str,
    context: &Context,
    batch: PreparedBatch,
    registry: &mut JoinedTasks,
    cancel: CancellationToken,
    events: mpsc::Sender<ExecutionEvent>,
    progress: Option<mpsc::Sender<ExecutionEvent>>,
) -> Result<JoinedResult, EngineError> {
    let commands: Vec<String> = (0..batch.tasks.len())
        .map(|i| format!("{command}:agent:{i}"))
        .collect();
    let group = json!({"kind":"agent_delegation","parent_operation":parent,"call_id":call_id,"tasks":batch.tasks,"child_commands":commands,"delegation_context_sha256":hash(&context.identity)?});
    let mut intents = vec![(command.into(), group)];
    for (index, mut payload) in batch.payloads.into_iter().enumerate() {
        payload["parent_operation"] = json!(parent);
        payload["delegation_group_command"] = json!(command);
        payload["delegation_index"] = json!(index);
        intents.push((commands[index].clone(), payload));
    }
    let operations = lock(&shared.store)?.admit_owned_batch(session, &shared.owner, &intents)?;
    let group = operations[0].clone();
    let children = operations[1..].to_vec();
    registry.used += children.len();
    registry.current = Some(RunningGroup {
        group: group.clone(),
        children: children.clone(),
        next: 0,
    });
    let mut pending: std::collections::VecDeque<_> = batch.actors.into_iter().enumerate().collect();
    let mut uncertain = false;
    loop {
        while !cancel.is_cancelled()
            && !uncertain
            && registry.tasks.len() < context.policy.max_parallel as usize
        {
            let Some((index, actor)) = pending.pop_front() else {
                break;
            };
            let child = &children[index];
            lock(&shared.store)?.append_operation_event(
                &child.id,
                &shared.owner,
                "delegation.dispatch",
                &json!({"group_operation":group.id,"index":index}),
            )?;
            if let Some(group) = &mut registry.current {
                group.next = index + 1;
            }
            let session = session.to_owned();
            let operation = child.id.clone();
            let child_cancel = cancel.child_token();
            let mut guard =
                ChildGuard::new(Arc::clone(shared), operation.clone(), child_cancel.clone());
            let events = events.clone();
            let progress = progress.clone();
            registry.tasks.spawn(async move {
                let result = agent::run_actor(
                    &guard.shared,
                    &session,
                    &operation,
                    actor,
                    child_cancel,
                    events,
                    progress,
                )
                .await;
                guard.settled = result.is_ok();
                drop(guard);
                (index, result)
            });
        }
        let Some(joined) = registry.tasks.join_next().await else {
            break;
        };
        match joined {
            Ok((
                _,
                Ok(Reply::Agent {
                    operation, result, ..
                }),
            )) => {
                if operation.status == OperationStatus::Unknown
                    || result
                        .as_ref()
                        .is_none_or(|r| r.status == AgentStatus::Unknown)
                {
                    uncertain = true;
                    cancel.cancel();
                }
                if operation.status == OperationStatus::Cancelled
                    || result
                        .as_ref()
                        .is_some_and(|r| r.status == AgentStatus::Cancelled)
                {
                    // A child sink can request cancellation independently of the
                    // root token. Never advertise that joined group as complete.
                    cancel.cancel();
                }
            }
            _ => {
                uncertain = true;
                cancel.cancel();
            }
        }
    }
    // Admitted but never launched work is known to have had no external effects.
    {
        let mut store = lock(&shared.store)?;
        for (index, _) in pending {
            store.settle_operation(
                &children[index].id,
                &shared.owner,
                OperationStatus::Cancelled,
                &cancelled(),
            )?;
        }
        for child in &children {
            if store.get_operation(&child.id)?.status == OperationStatus::Running {
                uncertain = true;
                store.mark_operation_unknown(
                    &child.id,
                    &shared.owner,
                    "delegated actor ended without settled result",
                )?;
            }
        }
        let receipt = receipt::derive(&store, &group)?;
        store.retain_operation_artifact(
            &group.id,
            &shared.owner,
            "delegation.result",
            &serde_json::to_vec(&receipt)?,
        )?;
        if uncertain {
            store.mark_operation_unknown_with_outcome(&group.id, &shared.owner, &receipt)?;
        } else {
            store.settle_operation(
                &group.id,
                &shared.owner,
                if cancel.is_cancelled() {
                    OperationStatus::Cancelled
                } else {
                    OperationStatus::Succeeded
                },
                &receipt,
            )?;
        }
        registry.current = None;
        Ok(JoinedResult {
            output: serde_json::to_string(&receipt)?,
            uncertain,
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use futures_util::FutureExt;

    #[tokio::test]
    async fn caught_round_panic_keeps_child_owned_until_cleanup_and_preserves_budget_hold() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path().join("state.db"), None).unwrap();
        let shared = Arc::clone(&engine.shared);
        let session = lock(&shared.store)
            .unwrap()
            .create_session("test", 100)
            .unwrap()
            .id;
        let operations = lock(&shared.store)
            .unwrap()
            .admit_owned_batch(
                &session,
                &shared.owner,
                &[
                    ("group".into(), json!({"kind":"fixture"})),
                    ("started".into(), json!({"kind":"fixture"})),
                    ("pending".into(), json!({"kind":"fixture"})),
                ],
            )
            .unwrap();
        lock(&shared.store)
            .unwrap()
            .reserve_budget(&session, &operations[1].id, 7)
            .unwrap();
        let cancel = CancellationToken::new();
        let cleaning = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let mut registry = JoinedTasks::new();
        registry.current = Some(RunningGroup {
            group: operations[0].clone(),
            children: operations[1..].to_vec(),
            next: 1,
        });
        let mut guard = ChildGuard::new(
            Arc::clone(&shared),
            operations[1].id.clone(),
            cancel.child_token(),
        );
        let cleaned = Arc::clone(&cleaning);
        let released = Arc::clone(&release);
        let panic = std::panic::AssertUnwindSafe(async {
            registry.tasks.spawn(async move {
                guard.cancel.cancelled().await;
                cleaned.notify_one();
                released.notified().await;
                let operation = lock(&guard.shared.store)
                    .unwrap()
                    .mark_operation_unknown(
                        &guard.operation,
                        &guard.shared.owner,
                        "fixture uncertain effect",
                    )
                    .unwrap();
                guard.settled = true;
                drop(guard);
                (
                    0,
                    Ok(Reply::Agent {
                        operation,
                        result: None,
                        duplicate: false,
                    }),
                )
            });
            panic!("injected round panic after child dispatch");
        })
        .catch_unwind()
        .await;
        assert!(panic.is_err());
        assert_eq!(shared.workers.count.load(Ordering::Acquire), 1);
        let owned = Arc::clone(&shared);
        let drain = tokio::spawn(async move { registry.drain(&owned, &cancel).await });
        tokio::time::timeout(std::time::Duration::from_secs(2), cleaning.notified())
            .await
            .unwrap();
        assert!(!drain.is_finished(), "cleanup must be joined, not aborted");
        assert_eq!(shared.workers.count.load(Ordering::Acquire), 1);
        release.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(2), drain)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(shared.workers.count.load(Ordering::Acquire), 0);
        let store = lock(&shared.store).unwrap();
        assert_eq!(
            store.get_operation(&operations[0].id).unwrap().status,
            OperationStatus::Unknown
        );
        assert_eq!(
            store.get_operation(&operations[1].id).unwrap().status,
            OperationStatus::Unknown
        );
        let pending = store.get_operation(&operations[2].id).unwrap();
        assert_eq!(pending.status, OperationStatus::Cancelled);
        assert_eq!(pending.outcome.unwrap()["external_effects_started"], false);
        assert_eq!(store.budget(&session).unwrap().reserved, 7);
        drop(store);
        engine.shutdown().await.unwrap();
    }
}
