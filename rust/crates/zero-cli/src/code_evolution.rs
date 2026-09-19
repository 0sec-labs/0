//! One host-authorized model proposal followed by offline Python fixture measurement.
use clap::Subcommand;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use zero_engine::Engine;
use zero_evaluation::{
    PythonEvolutionInspection, PythonEvolutionPlan, PythonProposal, PythonProposalContext,
};
use zero_harness::HostGrants;
use zero_plugin::{Capability, HostPolicy};
use zero_protocol::{Command, Reply};
#[derive(Debug, Subcommand)]
pub enum CodeEvolutionCommand {
    /// Generate one bounded Python plugin candidate and independently evaluate it; no promotion.
    Run {
        #[arg(long)]
        session: String,
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        source_registry: PathBuf,
        #[arg(long)]
        plan: PathBuf,
        #[arg(long)]
        grants: PathBuf,
        #[arg(long)]
        output_dir: PathBuf,
    },
    /// Inspect retained proposal and recheck original paid inference/exposure; never replay.
    Status {
        #[arg(long)]
        directory: PathBuf,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    enabled: bool,
    trusted: bool,
    grants: BTreeSet<Capability>,
}
async fn read(path: &Path) -> Result<Vec<u8>, Box<dyn Error>> {
    tokio::select! {
        value=tokio::time::timeout(Duration::from_secs(5),crate::providers::read_bounded(path))=>value.map_err(|_|"Python evolution input deadline exceeded")?,
        _=crate::server::shutdown_signal()=>Err("Python evolution input interrupted".into()),
    }
}
fn success(report: &PythonEvolutionInspection) -> bool {
    report.phase == "model_stop"
        || report.phase == "completed"
            && report
                .evaluation
                .as_ref()
                .and_then(|e| e.report.as_ref())
                .is_some_and(|r| r.decision == zero_evolution::EvaluationDecision::Eligible)
}
async fn work(
    engine: &Engine,
    proposal: &mut PythonProposal,
    grants: &HostGrants,
    runner: &zero_plugin_runner::Runner,
    cancel: CancellationToken,
) -> Result<(), Box<dyn Error>> {
    if cancel.is_cancelled() {
        proposal.finish("cancelled")?;
        return Ok(());
    }
    proposal.begin_proposal()?;
    let context = proposal.context().clone();
    let command = Command::Infer {
        session_id: context.session_id,
        command_id: context.command_id,
        provider: proposal.plan().provider.clone(),
        reservation: proposal.plan().reservation,
        request: proposal.request(),
    };
    let (events, mut rx) = mpsc::channel(128);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let inference = engine.handle(command, events);
    tokio::pin!(inference);
    let reply = tokio::select! {
        reply=&mut inference=>reply,
        _=cancel.cancelled()=>{engine.shutdown().await?;inference.await},
    };
    drain.await?;
    let claim = match reply {
        Reply::Inference { operation, .. } => match proposal.record_inference(&operation) {
            Ok(claim) => claim,
            Err(_) => {
                proposal.finish(if cancel.is_cancelled() {
                    "cancelled"
                } else {
                    "proposal_rejected"
                })?;
                return Ok(());
            }
        },
        _ => {
            proposal.finish(if cancel.is_cancelled() {
                "cancelled"
            } else {
                "inference_failed"
            })?;
            return Ok(());
        }
    };
    let Some(claim) = claim else { return Ok(()) };
    if cancel.is_cancelled() {
        proposal.finish("cancelled")?;
        return Ok(());
    }
    let exposure = match engine.claim_python_holdout(&claim) {
        Ok(exposure) => exposure,
        Err(_) => {
            proposal.finish("exposure_rejected")?;
            return Ok(());
        }
    };
    if proposal
        .evaluate(exposure, grants, runner, cancel)
        .await
        .is_err()
    {
        proposal.finish("evaluation_failed")?;
    }
    Ok(())
}
pub async fn run(
    args: &crate::args::Args,
    command: &CodeEvolutionCommand,
) -> Result<bool, Box<dyn Error>> {
    if let CodeEvolutionCommand::Status { directory } = command {
        let report = PythonProposal::inspect(directory)?;
        crate::write_json(&report, false).await?;
        return Ok(true);
    }
    let CodeEvolutionCommand::Run {
        session,
        command_id,
        source_registry,
        plan,
        grants,
        output_dir,
    } = command
    else {
        unreachable!()
    };
    if args.harness_config.is_some()
        || args.strategy_host.is_some()
        || args.http_profiles.is_some()
        || args.scan_profiles.is_some()
        || args.review_profiles.is_some()
    {
        return Err(
            "Python evolution uses only its explicit frozen registry/grants and provider profiles"
                .into(),
        );
    }
    let plan: PythonEvolutionPlan = serde_json::from_slice(&read(plan).await?)?;
    plan.validate()?;
    let policies: BTreeMap<String, Policy> = serde_json::from_slice(&read(grants).await?)?;
    let grants = HostGrants::new(
        policies
            .into_iter()
            .map(|(id, p)| {
                (
                    id,
                    HostPolicy {
                        enabled: p.enabled,
                        trusted: p.trusted,
                        grants: p.grants,
                    },
                )
            })
            .collect(),
    );
    let state = args.state.canonicalize()?;
    let context = PythonProposalContext {
        state_database: state.to_str().ok_or("state path must be UTF-8")?.into(),
        session_id: session.clone(),
        command_id: command_id.clone(),
    };
    zero_store::Store::open_read_only(&state)?.get_session(session)?;
    if std::fs::symlink_metadata(output_dir).is_ok() {
        PythonProposal::check_retry(output_dir, &plan, &context, &grants)?;
        let report = PythonProposal::inspect(output_dir)?;
        let ok = success(&report);
        crate::write_json(&report, false).await?;
        return Ok(ok);
    }
    let source = zero_evolution::Registry::open_read_only(source_registry)?;
    let mut proposal = PythonProposal::create(output_dir, &source, plan.clone(), &grants, context)?;
    drop(source);
    let engine = Arc::new(Engine::open_with_backends(
        &state,
        args.docker_bin.clone(),
        args.smolvm_bin.clone(),
    )?);
    let result=async {
        if let Some(path)=&args.providers {crate::providers::configure(&engine,path).await?;}
        if let Some(model)=&args.hosted_model {
            crate::hosted_provider::configure(&engine,model,args.hosted_host.as_deref(),args.hosted_token_env.as_deref().unwrap_or("0SEC_CLOUD_TOKEN"),args.hosted_timeout_ms.unwrap_or(300_000)).await?;
        }
        let docker=args.docker_bin.as_ref().map(|p|zero_executor::DockerExecutor::with_binary(p.clone())).unwrap_or_default();
        let runner=zero_plugin_runner::Runner::new(zero_sandbox::SandboxExecutor::with_backends(docker,zero_smolvm::SmolvmConfig::default()));
        let cancel=CancellationToken::new();
        let now:u64=SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis().try_into()?;
        let deadline=Duration::from_millis(plan.expires_at_ms.saturating_sub(now));
        let task=work(&engine,&mut proposal,&grants,&runner,cancel.clone());
        tokio::pin!(task);
        tokio::select! {
            result=&mut task=>result?,
            _=tokio::time::sleep(deadline)=>{cancel.cancel();engine.shutdown().await?;task.await?;},
            _=crate::server::shutdown_signal()=>{cancel.cancel();engine.shutdown().await?;task.await?;},
        }
        Ok::<(),Box<dyn Error>>(())
    }.await;
    engine.shutdown().await?;
    result?;
    drop(proposal);
    let report = PythonProposal::inspect(output_dir)?;
    let ok = success(&report);
    crate::write_json(&report, false).await?;
    Ok(ok)
}
