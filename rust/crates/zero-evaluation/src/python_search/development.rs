use super::*;
use crate::{Attempt, Lane, Variant};
use std::sync::Arc;
use zero_plugin_runner::{Runner, UntrustedReply};
impl PythonSearch {
    fn save_attempt(&self, round: usize, attempt: &Attempt) -> Result<()> {
        let raw = serde_json::to_string(attempt)?;
        if raw.len() > 256 * 1024 {
            return Err(invalid("Development attempt evidence bound"));
        }
        self.conn.execute("INSERT INTO development_attempts(round,idx,evidence) VALUES(?1,?2,?3) ON CONFLICT(round,idx) DO UPDATE SET evidence=excluded.evidence",params![round,attempt.index,raw])?;
        Ok(())
    }
    pub async fn experiment(
        &mut self,
        round: usize,
        grants: &HostGrants,
        runner: &Runner,
        cancel: CancellationToken,
    ) -> Result<DevelopmentFeedback> {
        if cancel.is_cancelled() || now()? >= self.intent.plan.proposal.expires_at_ms {
            return Err(invalid("Development cancelled/expired"));
        }
        let phase: String =
            self.conn
                .query_row("SELECT phase FROM search WHERE singleton=1", [], |r| {
                    r.get(0)
                })?;
        let (candidate, source_sha, kind, feedback): (String, String, String, Option<String>) =
            self.conn.query_row(
                "SELECT candidate,source_sha,kind,feedback FROM rounds WHERE idx=?1",
                [round],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?;
        if phase != "experiment_ready" || kind != "experiment" || feedback.is_some() {
            return Err(invalid("Development experiment cannot replay"));
        }
        let cases: Vec<_> = self
            .intent
            .plan
            .proposal
            .cases
            .iter()
            .filter(|c| c.lane == Lane::Development)
            .cloned()
            .collect();
        let count = cases.len() * self.intent.plan.proposal.repeats;
        let slots: usize =
            self.conn
                .query_row("SELECT slots FROM search WHERE singleton=1", [], |r| {
                    r.get(0)
                })?;
        if slots + count > self.intent.plan.max_development_attempts {
            self.finish("attempt_limit")?;
            return Err(invalid("Development attempt cap"));
        }
        self.conn.execute(
            "UPDATE search SET slots=?1,phase='experiment_running' WHERE singleton=1",
            [slots + count],
        )?;
        let experiment_root = self.root.join(format!("development-{round}"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&experiment_root)?;
        }
        let mut instance = crate::driver::instance_for(
            &experiment_root,
            &self.source,
            grants,
            &candidate,
            &self.intent.plan.proposal.engine_artifact,
            &self.intent.plan.proposal.evaluator_artifact,
            0,
        )?;
        let mut attempts = vec![];
        let mut deadline = false;
        'schedule: for repeat in 0..self.intent.plan.proposal.repeats {
            for case in &cases {
                if cancel.is_cancelled() || now()? >= self.intent.plan.proposal.expires_at_ms {
                    deadline = now()? >= self.intent.plan.proposal.expires_at_ms;
                    break 'schedule;
                }
                let mut attempt = Attempt {
                    index: attempts.len(),
                    variant: Variant::Candidate,
                    case_id: case.id.clone(),
                    repeat,
                    state: "preparing".into(),
                    owner: Some(self.intent.id.clone()),
                    lease_id: None,
                    staging: None,
                    execution_id: None,
                    request_digest: None,
                    sandbox: None,
                    output: None,
                    error: None,
                    settled: false,
                };
                let stage = experiment_root.join(format!("attempt-{}", attempt.index));
                attempt.staging = Some(stage.to_string_lossy().into_owned());
                self.save_attempt(round, &attempt)?;
                let call = instance.harness.begin_call(
                    &instance.pin,
                    &self.intent.id,
                    &self.intent.plan.proposal.plugin,
                    &self.intent.plan.proposal.tool,
                    case.input.clone(),
                )?;
                attempt.lease_id = Some(call.lease().id.clone());
                self.save_attempt(round, &attempt)?;
                let prepared = match runner.prepare_in(
                    &instance.harness,
                    call,
                    &self.intent.plan.proposal.plugin,
                    self.intent.plan.proposal.launch.clone(),
                    &stage,
                ) {
                    Ok(prepared) => prepared,
                    Err(rejected) => {
                        let zero_plugin_runner::RejectedCall {
                            mut call,
                            error,
                            owned_staging,
                        } = *rejected;
                        attempt.error = Some(error.to_string());
                        let removed = match owned_staging {
                            None => true,
                            Some(owned) if owned == stage => {
                                match std::fs::remove_dir_all(&owned) {
                                    Ok(()) => true,
                                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
                                    Err(_) => false,
                                }
                            }
                            Some(_) => false,
                        };
                        attempt.state = if removed { "finished" } else { "unknown" }.into();
                        self.save_attempt(round, &attempt)?;
                        if removed {
                            instance.harness.complete_settled(&mut call)?;
                            attempt.settled = true;
                            self.save_attempt(round, &attempt)?;
                        }
                        attempts.push(attempt);
                        if !removed {
                            break 'schedule;
                        }
                        continue;
                    }
                };
                attempt.execution_id = Some(prepared.execution_id().into());
                attempt.request_digest = Some(
                    prepared
                        .request_digest()
                        .map_err(|e| invalid(&e.to_string()))?,
                );
                attempt.state = "running".into();
                self.save_attempt(round, &attempt)?;
                let child = cancel.child_token();
                if now()? >= self.intent.plan.proposal.expires_at_ms {
                    deadline = true;
                    child.cancel();
                }
                let wait = prepared.start(child.clone(), Arc::new(|_| {})).wait();
                tokio::pin!(wait);
                let remaining = self
                    .intent
                    .plan
                    .proposal
                    .expires_at_ms
                    .saturating_sub(now()?);
                let result = tokio::select! {result=&mut wait=>result,_=tokio::time::sleep(std::time::Duration::from_millis(remaining))=>{deadline=true;child.cancel();wait.await}};
                match result {
                    Err(error) => {
                        attempt.state = "unknown".into();
                        attempt.error = Some(format!("owned Development runner failed: {error}"));
                        self.save_attempt(round, &attempt)?;
                        attempts.push(attempt);
                        break 'schedule;
                    }
                    Ok(mut outcome) => {
                        let settled = outcome.backend_settled();
                        attempt.sandbox = outcome.sandbox.take();
                        match outcome.reply {
                            Ok(UntrustedReply::Result(value)) => attempt.output = Some(value),
                            Ok(UntrustedReply::Error(_)) => {
                                attempt.error = Some("plugin RPC error".into())
                            }
                            Err(error) => attempt.error = Some(error.to_string()),
                        }
                        let identity=attempt.sandbox.as_ref().is_some_and(|r|r.execution_id==attempt.execution_id.as_deref().unwrap_or("") && matches!((&self.intent.plan.proposal.launch.backend,&r.artifact),(zero_protocol::sandbox::SandboxBackend::Docker{image},zero_protocol::sandbox::SandboxArtifact::Docker{resolved_image_id:Some(id),..}) if image==id));
                        if !identity {
                            attempt.error =
                                Some("observed Development backend identity differs".into());
                        }
                        attempt.state = if settled { "finished" } else { "unknown" }.into();
                        self.save_attempt(round, &attempt)?;
                        if settled {
                            instance.harness.complete_settled(&mut outcome.call)?;
                            attempt.settled = true;
                            self.save_attempt(round, &attempt)?;
                        }
                        attempts.push(attempt);
                        if !settled {
                            break 'schedule;
                        }
                    }
                }
            }
        }
        let feedback = feedback_from_attempts(
            &source_sha,
            &cases,
            self.intent.plan.proposal.repeats,
            &attempts,
        )?;
        self.conn.execute(
            "UPDATE rounds SET feedback=?1 WHERE idx=?2",
            params![serde_json::to_string(&feedback)?, round],
        )?;
        let phase = if deadline {
            "deadline"
        } else if cancel.is_cancelled() {
            "cancelled"
        } else if attempts.iter().any(|a| !a.settled) {
            "unknown_cleanup"
        } else if attempts
            .iter()
            .any(|a| a.error.as_deref() == Some("observed Development backend identity differs"))
        {
            "evaluation_failed"
        } else if attempts.len() == count {
            "ready"
        } else {
            "evaluation_failed"
        };
        self.conn
            .execute("UPDATE search SET phase=?1 WHERE singleton=1", [phase])?;
        Ok(feedback)
    }
}
pub(super) fn feedback_from_attempts(
    source: &str,
    cases: &[crate::Case],
    repeats: usize,
    attempts: &[Attempt],
) -> Result<DevelopmentFeedback> {
    let mut seen = std::collections::BTreeSet::new();
    let mut feedback = vec![];
    for (idx, a) in attempts.iter().enumerate() {
        let case = cases
            .iter()
            .find(|c| c.id == a.case_id)
            .ok_or_else(|| invalid("Development evidence case differs"))?;
        if a.index != idx
            || a.variant != Variant::Candidate
            || a.repeat >= repeats
            || !seen.insert((&a.case_id, a.repeat))
        {
            return Err(invalid("Development evidence schedule differs"));
        }
        feedback.push(DevelopmentCaseFeedback {
            case_id: a.case_id.clone(),
            repeat: a.repeat,
            solved: a.settled
                && a.state == "finished"
                && a.error.is_none()
                && a.output.as_ref() == Some(&case.expected),
            error: a
                .error
                .as_ref()
                .map(|_| "execution or response validation failed".into()),
        });
    }
    Ok(DevelopmentFeedback {
        source_sha256: source.into(),
        attempted: attempts.len(),
        settled: attempts.iter().filter(|a| a.settled).count(),
        solved: feedback.iter().filter(|c| c.solved).count(),
        completed: attempts.len() == cases.len() * repeats
            && attempts.iter().all(|a| {
                a.settled
                    && a.state == "finished"
                    && a.sandbox.as_ref().is_some_and(|r| {
                        r.status == zero_protocol::execution::ExecutionStatus::Exited
                            && matches!(
                                r.cleanup,
                                zero_protocol::sandbox::SandboxCleanup::Confirmed
                            )
                    })
                    && a.error.as_deref() != Some("observed Development backend identity differs")
            }),
        cases: feedback,
    })
}
