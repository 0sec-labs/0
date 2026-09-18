//! Explicit web workflow inspection and host-frozen verification. Reads never contact a target.
use clap::{Args, Subcommand, ValueEnum};
use std::{
    error::Error,
    path::{Path, PathBuf},
    time::Duration,
};
use zero_protocol::{Command, Reply, web::*};
#[derive(Debug, Args)]
pub struct Target {
    #[arg(long)]
    session: String,
    #[arg(long)]
    operation: String,
}
#[derive(Debug, Args)]
pub struct Decision {
    #[command(flatten)]
    target: Target,
    #[arg(long)]
    hypothesis: String,
    #[arg(long)]
    command_id: String,
    #[arg(long)]
    expected_revision: u64,
    #[arg(long, default_value = "")]
    note: String,
}
#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum Format {
    Json,
    Markdown,
    Html,
}
#[derive(Debug, Subcommand)]
pub enum WebCommand {
    /// Discover explicitly enabled web runs, including partial and cancelled roots.
    Runs {
        #[arg(long)]
        session: String,
        #[arg(long)]
        before_sequence: Option<u64>,
        #[arg(long,default_value_t=20,value_parser=clap::value_parser!(u32).range(1..=32))]
        limit: u32,
    },
    /// Inspect one run's validated submission or retained partial state.
    Show {
        #[command(flatten)]
        target: Target,
    },
    /// List retained HTTP operation metadata; an empty page may still advance the cursor.
    Observations {
        #[command(flatten)]
        target: Target,
        #[arg(long, default_value_t = 0)]
        after_sequence: u64,
        #[arg(long,default_value_t=32,value_parser=clap::value_parser!(u32).range(1..=32))]
        limit: u32,
    },
    /// Discover model-proposed experiments, including partial or unknown work.
    Experiments {
        #[command(flatten)]
        target: Target,
        #[arg(long, default_value_t = 0)]
        after_sequence: u64,
        #[arg(long,default_value_t=20,value_parser=clap::value_parser!(u32).range(1..=32))]
        limit: u32,
    },
    /// Inspect a conjecture, its model predictions and independently measured feedback.
    Experiment {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        experiment: String,
    },
    Findings {
        #[command(flatten)]
        target: Target,
        #[arg(long, default_value_t = 0)]
        offset: u32,
        #[arg(long,default_value_t=32,value_parser=clap::value_parser!(u32).range(1..=32))]
        limit: u32,
    },
    Finding {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        hypothesis: String,
        #[arg(long, default_value_t = 0)]
        after_revision: u64,
        #[arg(long,default_value_t=50,value_parser=clap::value_parser!(u32).range(1..=100))]
        limit: u32,
    },
    /// Accept for operator follow-up; evidence remains unverified.
    Accept(Decision),
    Suppress(Decision),
    Reopen(Decision),
    /// Inspect validated redacted HTTP metadata, not a fresh request.
    Evidence {
        #[command(flatten)]
        target: Target,
    },
    /// Read <=64 KiB of retained redacted bytes as base64 with exact manifest identity.
    Range {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        expected_manifest: String,
        #[arg(long, default_value_t = 0)]
        offset: u64,
        #[arg(long,default_value_t=65536,value_parser=clap::value_parser!(u32).range(1..=65536))]
        limit: u32,
    },
    /// Freeze and preview the complete verification intent without dispatch or approval.
    VerifyPrepare {
        #[arg(long)]
        session: String,
        #[arg(long)]
        plan: PathBuf,
    },
    /// Execute a fresh exact host matrix. --approve-plan requires the complete preview digest.
    Verify {
        #[arg(long)]
        session: String,
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        plan: PathBuf,
        #[arg(long)]
        expected_intent: String,
        #[arg(long)]
        approve_plan: Option<String>,
    },
    /// Export retained observations and explicitly linked plan-qualified assessments.
    Report {
        #[command(flatten)]
        target: Target,
        #[arg(long = "verification")]
        verifications: Vec<String>,
        #[arg(long = "experiment")]
        experiments: Vec<String>,
        #[arg(long, value_enum, default_value = "json")]
        format: Format,
    },
}
impl WebCommand {
    pub fn requires_dispatch(&self) -> bool {
        matches!(self, Self::Verify { .. })
    }
}
async fn plan(path: &Path) -> Result<WebVerificationPlan, Box<dyn Error>> {
    let bytes = tokio::select! {r=tokio::time::timeout(Duration::from_secs(5),crate::providers::read_bounded(path))=>r.map_err(|_|"Web plan read deadline exceeded")??,_=crate::server::shutdown_signal()=>return Err("Web plan read interrupted".into())};
    serde_json::from_slice(&bytes).map_err(|_| "Invalid web verification plan JSON".into())
}
pub async fn command(value: &WebCommand) -> Result<Command, Box<dyn Error>> {
    let WebCommand::Verify {
        session,
        command_id,
        plan: path,
        expected_intent,
        approve_plan,
    } = value
    else {
        return Err("Web read command cannot dispatch".into());
    };
    if !zero_protocol::is_sha256(expected_intent)
        || approve_plan.as_ref().is_some_and(|d| d != expected_intent)
    {
        return Err("--expected-intent must be a complete SHA256 digest; --approve-plan must equal it exactly".into());
    }
    Ok(Command::VerifyWebHypothesis {
        session_id: session.clone(),
        command_id: command_id.clone(),
        request: WebVerificationRequest {
            plan: plan(path).await?,
            expected_intent_sha256: expected_intent.clone(),
            approved_intent_sha256: approve_plan.clone(),
        },
    })
}
async fn inspect<T: Send + 'static>(
    read: impl FnOnce() -> Result<T, zero_engine::EngineError> + Send + 'static,
) -> Result<T, Box<dyn Error>> {
    let task = tokio::task::spawn_blocking(read);
    tokio::select! {r=tokio::time::timeout(Duration::from_secs(5),task)=>Ok(r.map_err(|_|"Web evidence read deadline exceeded")???),_=crate::server::shutdown_signal()=>Err("Web evidence read interrupted".into())}
}
pub async fn readonly(state: &Path, value: &WebCommand) -> Result<bool, Box<dyn Error>> {
    let path = state.to_owned();
    let reply = match value {
        WebCommand::Runs {
            session,
            before_sequence,
            limit,
        } => {
            let (session, before, limit) = (session.clone(), *before_sequence, *limit);
            Reply::WebRuns {
                page: inspect(move || zero_engine::read_web_runs(&path, &session, before, limit))
                    .await?,
            }
        }
        WebCommand::Show { target } => {
            let (s, id) = (target.session.clone(), target.operation.clone());
            Reply::WebRun {
                run: inspect(move || zero_engine::read_web_run(&path, &s, &id)).await?,
            }
        }
        WebCommand::Observations {
            target,
            after_sequence,
            limit,
        } => {
            let (s, id, after, limit) = (
                target.session.clone(),
                target.operation.clone(),
                *after_sequence,
                *limit,
            );
            Reply::WebHttpOperations {
                page: inspect(move || {
                    zero_engine::read_web_http_operations(&path, &s, &id, after, limit)
                })
                .await?,
            }
        }
        WebCommand::Experiments {
            target,
            after_sequence,
            limit,
        } => {
            let (session, root, after, limit) = (
                target.session.clone(),
                target.operation.clone(),
                *after_sequence,
                *limit,
            );
            Reply::WebExperiments {
                page: inspect(move || {
                    zero_engine::read_web_experiments(&path, &session, &root, after, limit)
                })
                .await?,
            }
        }
        WebCommand::Experiment { target, experiment } => {
            let (session, root, id) = (
                target.session.clone(),
                target.operation.clone(),
                experiment.clone(),
            );
            Reply::WebExperiment {
                experiment: inspect(move || {
                    zero_engine::read_web_experiment(&path, &session, &root, &id)
                })
                .await?,
            }
        }
        WebCommand::Findings {
            target,
            offset,
            limit,
        } => {
            let (s, id, offset, limit) = (
                target.session.clone(),
                target.operation.clone(),
                *offset,
                *limit,
            );
            Reply::WebFindings {
                findings: inspect(move || {
                    zero_engine::read_web_findings(&path, &s, &id, offset, limit)
                })
                .await?,
            }
        }
        WebCommand::Finding {
            target,
            hypothesis,
            after_revision,
            limit,
        } => {
            let (s, id, h, after, limit) = (
                target.session.clone(),
                target.operation.clone(),
                hypothesis.clone(),
                *after_revision,
                *limit,
            );
            let (finding, history) =
                inspect(move || zero_engine::read_web_finding(&path, &s, &id, &h, after, limit))
                    .await?;
            Reply::WebFinding { finding, history }
        }
        WebCommand::Evidence { target } => {
            let (s, id) = (target.session.clone(), target.operation.clone());
            Reply::HttpEvidence {
                evidence: inspect(move || zero_engine::read_http_metadata(&path, &s, &id)).await?,
            }
        }
        WebCommand::Range {
            target,
            expected_manifest,
            offset,
            limit,
        } => {
            let (s, id, d, o, l) = (
                target.session.clone(),
                target.operation.clone(),
                expected_manifest.clone(),
                *offset,
                *limit,
            );
            Reply::HttpEvidenceRange {
                range: inspect(move || zero_engine::read_http_range(&path, &s, &id, &d, o, l))
                    .await?,
            }
        }
        WebCommand::VerifyPrepare {
            session,
            plan: input,
        } => {
            let (s, p) = (session.clone(), plan(input).await?);
            Reply::WebVerificationPrepared {
                preparation: inspect(move || zero_engine::prepare_web_verification(&path, &s, p))
                    .await?,
            }
        }
        WebCommand::Report {
            target,
            verifications,
            experiments,
            format,
        } => {
            let (s, id, links, experiments, format) = (
                target.session.clone(),
                target.operation.clone(),
                verifications.clone(),
                experiments.clone(),
                *format,
            );
            let report = inspect(move || {
                zero_engine::read_web_workflow_report_with_experiments(
                    &path,
                    &s,
                    &id,
                    &links,
                    &experiments,
                )
            })
            .await?;
            let format = match format {
                Format::Json => zero_report::WebReportFormat::Json,
                Format::Markdown => zero_report::WebReportFormat::Markdown,
                Format::Html => zero_report::WebReportFormat::Html,
            };
            let text = zero_report::render_web_report(&report, format)?;
            write_report(&text).await?;
            return Ok(true);
        }
        WebCommand::Accept(d) | WebCommand::Suppress(d) | WebCommand::Reopen(d) => {
            let status = match value {
                WebCommand::Accept(_) => WebTriageStatus::Accepted,
                WebCommand::Suppress(_) => WebTriageStatus::Suppressed,
                _ => WebTriageStatus::New,
            };
            let engine = zero_engine::Engine::open(state, None)?;
            let (events, _receiver) = tokio::sync::mpsc::channel(1);
            let reply = engine
                .handle(
                    Command::TriageWebFinding {
                        session_id: d.target.session.clone(),
                        command_id: d.command_id.clone(),
                        web_operation_id: d.target.operation.clone(),
                        hypothesis_id: d.hypothesis.clone(),
                        status,
                        expected_revision: d.expected_revision,
                        note: d.note.clone(),
                    },
                    events,
                )
                .await;
            engine.shutdown().await?;
            reply
        }
        WebCommand::Verify { .. } => {
            return Err("Verification requires the owned dispatch path".into());
        }
    };
    let success = !matches!(reply, Reply::Error { .. });
    crate::write_json(&reply, false).await?;
    Ok(success)
}

async fn write_report(text: &str) -> Result<(), Box<dyn Error>> {
    use tokio::io::AsyncWriteExt;
    let mut stdout = tokio::io::stdout();
    tokio::select! {r=tokio::time::timeout(Duration::from_secs(5),async{stdout.write_all(text.as_bytes()).await?;stdout.write_all(b"\n").await?;stdout.flush().await})=>r.map_err(|_|"Web report output deadline exceeded")??,_=crate::server::shutdown_signal()=>return Err("Web report output interrupted".into())}
    Ok(())
}
