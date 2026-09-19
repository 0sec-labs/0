use super::*;
use zero_evaluation::{PythonSearch, PythonSearchInspection, PythonSearchPlan, SearchStep};
#[derive(Debug, Subcommand)]
pub enum SearchCommand {
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
    Status {
        #[arg(long)]
        directory: PathBuf,
    },
}
fn success(report: &PythonSearchInspection) -> bool {
    report.phase == "stopped"
        || report.phase == "completed"
            && report
                .evaluation
                .as_ref()
                .and_then(|e| e.report.as_ref())
                .is_some_and(|r| r.decision == zero_evolution::EvaluationDecision::Eligible)
}
async fn work(
    engine: &Engine,
    search: &mut PythonSearch,
    grants: &HostGrants,
    runner: &zero_plugin_runner::Runner,
    cancel: CancellationToken,
) -> Result<(), Box<dyn Error>> {
    loop {
        if cancel.is_cancelled() {
            search.finish("cancelled")?;
            return Ok(());
        }
        let Some((command, request)) = search.next_request()? else {
            return Ok(());
        };
        let sha = zero_evaluation::digest(&serde_json::to_vec(&serde_json::to_value(&request)?)?);
        let session = search.context().session_id.clone();
        let (events, mut rx) = mpsc::channel(128);
        let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
        let inference = engine.handle(
            Command::Infer {
                session_id: session.clone(),
                command_id: command.clone(),
                provider: search.plan().proposal.provider.clone(),
                reservation: search.plan().proposal.reservation,
                request,
            },
            events,
        );
        tokio::pin!(inference);
        let reply = tokio::select! {reply=&mut inference=>reply,_=cancel.cancelled()=>{engine.shutdown().await?;inference.await}};
        drain.await?;
        let Reply::Inference { operation, .. } = reply else {
            search.finish(if cancel.is_cancelled() {
                "cancelled"
            } else {
                "inference_failed"
            })?;
            return Ok(());
        };
        if cancel.is_cancelled() {
            search.record_failed_inference(&operation, true)?;
            return Ok(());
        }
        let witness =
            match engine.verify_python_search_inference(&session, &command, &operation.id, &sha) {
                Ok(w) => w,
                Err(_) => {
                    search.record_failed_inference(&operation, false)?;
                    return Ok(());
                }
            };
        let step = match search.record_inference(witness) {
            Ok(step) => step,
            Err(_) => {
                let phase = search.phase().ok();
                if !matches!(phase.as_deref(), Some("deadline" | "budget_limit")) {
                    search.finish("proposal_rejected")?;
                }
                return Ok(());
            }
        };
        match step {
            SearchStep::Stop => return Ok(()),
            SearchStep::Experiment { round } => {
                if search
                    .experiment(round, grants, runner, cancel.clone())
                    .await
                    .is_err()
                {
                    if !matches!(
                        search.phase()?.as_str(),
                        "attempt_limit" | "deadline" | "unknown_cleanup"
                    ) {
                        search.finish(if cancel.is_cancelled() {
                            "cancelled"
                        } else {
                            "evaluation_failed"
                        })?;
                    }
                    return Ok(());
                }
                if search.phase()? != "ready" {
                    return Ok(());
                }
            }
            SearchStep::Selected { claim } => {
                if cancel.is_cancelled() {
                    search.finish("cancelled")?;
                    return Ok(());
                }
                let witness = match engine.claim_python_holdout(&claim) {
                    Ok(w) => w,
                    Err(_) => {
                        search.finish("proposal_rejected")?;
                        return Ok(());
                    }
                };
                if search
                    .evaluate(witness, grants, runner, cancel.clone())
                    .await
                    .is_err()
                {
                    search.finish(if cancel.is_cancelled() {
                        "cancelled"
                    } else {
                        "evaluation_failed"
                    })?;
                }
                return Ok(());
            }
        }
    }
}
pub async fn run(
    args: &crate::args::Args,
    command: &SearchCommand,
) -> Result<bool, Box<dyn Error>> {
    if let SearchCommand::Status { directory } = command {
        crate::write_json(&PythonSearch::inspect(directory)?, false).await?;
        return Ok(true);
    }
    let SearchCommand::Run {
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
            "Python search uses its explicit frozen registry/grants/provider profiles".into(),
        );
    }
    let plan: PythonSearchPlan = serde_json::from_slice(&read(plan).await?)?;
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
        state_database: state.to_str().ok_or("state path UTF-8")?.into(),
        session_id: session.clone(),
        command_id: command_id.clone(),
    };
    zero_store::Store::open_read_only(&state)?.get_session(session)?;
    if std::fs::symlink_metadata(output_dir).is_ok() {
        PythonSearch::check_retry(output_dir, &plan, &context, &grants)?;
        let report = PythonSearch::inspect(output_dir)?;
        let ok = success(&report);
        crate::write_json(&report, false).await?;
        return Ok(ok);
    }
    let source = zero_evolution::Registry::open_read_only(source_registry)?;
    let mut search = PythonSearch::create(output_dir, &source, plan.clone(), &grants, context)?;
    drop(source);
    let engine = Arc::new(Engine::open_with_backends(
        &state,
        args.docker_bin.clone(),
        args.smolvm_bin.clone(),
    )?);
    let result=async{
        if let Some(path)=&args.providers{crate::providers::configure(&engine,path).await?;}
        if let Some(model)=&args.hosted_model{crate::hosted_provider::configure(&engine,model,args.hosted_host.as_deref(),args.hosted_token_env.as_deref().unwrap_or("0SEC_CLOUD_TOKEN"),args.hosted_timeout_ms.unwrap_or(300_000)).await?;}
        let docker=args.docker_bin.as_ref().map(|p|zero_executor::DockerExecutor::with_binary(p.clone())).unwrap_or_default();
        let runner=zero_plugin_runner::Runner::new(zero_sandbox::SandboxExecutor::with_backends(docker,zero_smolvm::SmolvmConfig::default()));
        let cancel=CancellationToken::new();let now:u64=SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis().try_into()?;
        let task=work(&engine,&mut search,&grants,&runner,cancel.clone());tokio::pin!(task);
        tokio::select!{result=&mut task=>result?,_=tokio::time::sleep(Duration::from_millis(plan.proposal.expires_at_ms.saturating_sub(now)))=>{cancel.cancel();engine.shutdown().await?;task.await?;},_=crate::server::shutdown_signal()=>{cancel.cancel();engine.shutdown().await?;task.await?;}}
        Ok::<(),Box<dyn Error>>(())
    }.await;
    engine.shutdown().await?;
    result?;
    drop(search);
    let report = PythonSearch::inspect(output_dir)?;
    let ok = success(&report);
    crate::write_json(&report, false).await?;
    Ok(ok)
}
