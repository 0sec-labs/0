use crate::{Attempt, Plan, Report, Result, Variant, invalid, ledger::Ledger, score};
use std::{collections::BTreeSet, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;
use zero_evolution::{PreparedState, Registry};
use zero_harness::{GenerationPin, Harness, HostGrants};
use zero_plugin_runner::{Runner, UntrustedReply};
struct Instance {
    harness: Harness,
    pin: GenerationPin,
}
/// Same-user host is trusted. Private files protect the oracle from guests, not
/// a malicious controller/user with access to the host account.
pub struct Evaluation {
    ledger: Ledger,
    instances: Option<[Instance; 2]>,
}
impl Evaluation {
    /// Read one bounded SQLite snapshot without claiming an owner or recovering work.
    pub fn inspect(root: &Path) -> Result<crate::Inspection> {
        crate::inspect::inspect(root)
    }
    /// Root must not exist. Source is read-only: production is never bootstrapped
    /// or activated. Only verified generation/plugin artifact closure is copied.
    pub fn create(root: &Path, source: &Registry, plan: Plan, grants: &HostGrants) -> Result<Self> {
        plan.validate()?;
        if source.artifact(&plan.host_policy_artifact)? != grants.artifact_bytes()? {
            return Err(invalid("host grants identity mismatch"));
        }
        source.artifact(&plan.evaluator_artifact)?;
        for generation in [&plan.baseline, &plan.candidate] {
            let m = source.generation(generation)?;
            if m.engine_artifact != plan.engine_artifact
                || m.policy_artifact != plan.host_policy_artifact
            {
                return Err(invalid("variant engine/host policy drift"));
            }
        }
        let ledger = Ledger::create(root, plan)?;
        let baseline = instance(&ledger, source, grants, 0)?;
        let candidate = instance(&ledger, source, grants, 1)?;
        Ok(Self {
            ledger,
            instances: Some([baseline, candidate]),
        })
    }
    /// Reopen only for durable inspection. Previously started attempts never
    /// replay; Unknown retains its lease/staging and requires external fencing.
    pub fn reopen(root: &Path) -> Result<Self> {
        Ok(Self {
            ledger: Ledger::reopen(root)?,
            instances: None,
        })
    }
    pub fn attempts(&self) -> Result<Vec<Attempt>> {
        self.ledger.attempts()
    }
    pub fn report(&self) -> Result<Option<Report>> {
        self.ledger.report()
    }
    /// One frozen schedule, serial fresh guests. Dropping this future cancels the
    /// current runner waiter; its durable attempt remains unfinished/Unknown.
    pub async fn run(&mut self, runner: &Runner, cancel: CancellationToken) -> Result<Report> {
        if let Some(report) = self.ledger.report()? {
            return Ok(report);
        }
        if self.ledger.started()? || self.instances.is_none() {
            return self.finalize();
        }
        self.ledger.begin()?;
        let attempts = self.ledger.attempts()?;
        for mut attempt in attempts {
            if cancel.is_cancelled() {
                break;
            }
            if !self.ledger.can_reserve_attempt(attempt.index)? {
                attempt.error =
                    Some("serialized evidence capacity cannot cover next attempt".into());
                self.ledger.save(&attempt)?;
                break;
            }
            let case = self
                .ledger
                .plan
                .cases
                .iter()
                .find(|c| c.id == attempt.case_id)
                .ok_or_else(|| invalid("attempt case missing"))?;
            let index = if attempt.variant == Variant::Baseline {
                0
            } else {
                1
            };
            let instance = &mut self
                .instances
                .as_mut()
                .ok_or_else(|| invalid("instances not prepared"))?[index];
            let stage = self.ledger.root.join(format!("attempt-{}", attempt.index));
            attempt.state = "preparing".into();
            attempt.owner = Some(self.ledger.owner.clone());
            attempt.staging = Some(stage.to_string_lossy().into_owned());
            self.ledger.save(&attempt)?; // path intent precedes lease/files/dispatch
            let call = match instance.harness.begin_call(
                &instance.pin,
                &self.ledger.owner,
                &self.ledger.plan.plugin,
                &self.ledger.plan.tool,
                case.input.clone(),
            ) {
                Ok(call) => call,
                Err(error) => {
                    attempt.state = "finished".into();
                    attempt.settled = true;
                    attempt.error = Some(error.to_string());
                    self.ledger.save(&attempt)?;
                    continue;
                }
            };
            attempt.lease_id = Some(call.lease().id.clone());
            self.ledger.save(&attempt)?;
            let prepared = match runner.prepare_in(
                &instance.harness,
                call,
                &self.ledger.plan.plugin,
                self.ledger.plan.launch.clone(),
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
                        Some(owned) if owned == stage => match std::fs::remove_dir_all(&owned) {
                            Ok(()) => true,
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
                            Err(_) => false,
                        },
                        Some(_) => false,
                    };
                    attempt.state = "finished".into();
                    self.ledger.save(&attempt)?; // durable pre-dispatch failure before lease release
                    if removed {
                        instance.harness.complete_settled(&mut call)?;
                        attempt.settled = true;
                        self.ledger.save(&attempt)?;
                    }
                    if !removed {
                        break;
                    } else {
                        continue;
                    }
                }
            };
            attempt.execution_id = Some(prepared.execution_id().into());
            attempt.request_digest = Some(
                prepared
                    .request_digest()
                    .map_err(|e| invalid(&e.to_string()))?,
            );
            attempt.state = "running".into();
            self.ledger.save(&attempt)?;
            let mut outcome = match prepared
                .start(cancel.clone(), Arc::new(|_| {}))
                .wait()
                .await
            {
                Ok(outcome) => outcome,
                Err(error) => {
                    attempt.state = "unknown".into();
                    attempt.error = Some(format!("owned runner task failed: {error}"));
                    self.ledger.save(&attempt)?;
                    break;
                }
            };
            let backend_settled = outcome.backend_settled();
            attempt.sandbox = outcome.sandbox.take();
            match outcome.reply {
                Ok(UntrustedReply::Result(value)) => attempt.output = Some(value),
                Ok(UntrustedReply::Error(_)) => attempt.error = Some("plugin RPC error".into()),
                Err(error) => attempt.error = Some(error.to_string()),
            }
            let identity_matches = attempt.sandbox.as_ref().is_some_and(|r| {
                use zero_protocol::sandbox::{SandboxArtifact, SandboxBackend};
                r.execution_id == attempt.execution_id.as_deref().unwrap_or("")
                    && match (&self.ledger.plan.launch.backend, &r.artifact) {
                        (
                            SandboxBackend::Docker { image },
                            SandboxArtifact::Docker {
                                resolved_image_id: Some(id),
                                ..
                            },
                        ) => image == id,
                        (
                            SandboxBackend::Smolvm { archive_digest, .. },
                            SandboxArtifact::SmolvmArchive { digest },
                        ) => archive_digest == digest,
                        _ => false,
                    }
            });
            if !identity_matches {
                attempt.error = Some("observed backend/execution identity mismatch".into());
            }
            attempt.state = if backend_settled {
                "finished"
            } else {
                "unknown"
            }
            .into();
            self.ledger.save(&attempt)?; // outcome before cross-database lease release
            if backend_settled {
                instance.harness.complete_settled(&mut outcome.call)?;
                attempt.settled = true;
                self.ledger.save(&attempt)?;
            } else {
                break;
            }
        }
        self.finalize()
    }
    fn finalize(&self) -> Result<Report> {
        for mut a in self.ledger.attempts()? {
            if a.state == "running" || a.state == "preparing" {
                a.state = "unknown".into();
                a.error = Some("unfinished attempt; no replay or cleanup assertion".into());
                self.ledger.save(&a)?;
            }
        }

        let report = score::score(
            &self.ledger.run,
            &self.ledger.plan,
            &self.ledger.attempts()?,
        )?;
        self.ledger.finish(&report)?;
        Ok(report)
    }
}
fn instance(
    ledger: &Ledger,
    source: &Registry,
    grants: &HostGrants,
    index: usize,
) -> Result<Instance> {
    let generation = if index == 0 {
        &ledger.plan.baseline
    } else {
        &ledger.plan.candidate
    };
    let manifest = source.generation(generation)?;
    let mut target = Registry::open(
        ledger.root.join(format!("variant-{index}.sqlite")),
        &manifest.state_schema,
        &serde_json::json!({"evaluation_only":true}),
    )?;
    let mut artifacts = BTreeSet::from([
        manifest.engine_artifact.clone(),
        manifest.policy_artifact.clone(),
        ledger.plan.evaluator_artifact.clone(),
    ]);
    for (component, id) in &manifest.components {
        if !component.starts_with("plugin:") {
            return Err(invalid("only plugin generations supported"));
        }
        let plugin = zero_plugin::Manifest::parse(&source.artifact(id)?)?;
        artifacts.insert(id.clone());
        for artifact in plugin.artifacts {
            artifacts.insert(format!("sha256:{}", artifact.sha256));
        }
    }
    let mut total = 0;
    for id in artifacts {
        let bytes = source.artifact(&id)?;
        total += bytes.len();
        if total > 64 * 1024 * 1024 {
            return Err(invalid("variant artifacts exceed 64 MiB"));
        }
        if target.put_artifact(&bytes)? != id {
            return Err(invalid("artifact identity drift"));
        }
    }
    if target.register_generation(&manifest)? != *generation {
        return Err(invalid("generation identity drift"));
    }
    let eligibility = target.authorize_baseline(
        generation,
        "unmeasured evaluation-only private bootstrap; never production eligibility",
    )?;
    let mut harness = Harness::new(target, ledger.plan.engine_artifact.clone());
    let switch = harness.prepare_activation(
        generation,
        &eligibility,
        &harness.current()?,
        grants,
        |m, s| {
            Ok(PreparedState {
                state_schema: m.state_schema.clone(),
                state: s.state.clone(),
            })
        },
    )?;
    let pin = harness.commit(switch)?;
    Ok(Instance { harness, pin })
}
