//! Host-owned paired strategy qualification. Read paths never acquire engine ownership.
use clap::{Subcommand, ValueEnum};
use std::{
    error::Error,
    fmt::Write,
    path::{Path, PathBuf},
};
use zero_protocol::{Command, Reply, campaign::*, strategy::*};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum Lane {
    Development,
    Final,
}
impl From<Lane> for CampaignLane {
    fn from(lane: Lane) -> Self {
        match lane {
            Lane::Development => Self::Development,
            Lane::Final => Self::Final,
        }
    }
}
#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum Format {
    Json,
    Text,
}
#[derive(Debug, Subcommand)]
pub enum StrategyCommand {
    /// Bootstrap or inspect a real host-owned advisory registry.
    Registry {
        #[command(subcommand)]
        command: crate::strategy_registry::RegistryCommand,
    },
    /// Prepare/import independent measured evidence or inspect a retained scoped grant.
    Eligibility {
        #[command(subcommand)]
        command: crate::strategy_registry::EligibilityCommand,
    },
    /// Create an explicitly strategy-bound session with captured generation and host authority.
    Session {
        #[command(subcommand)]
        command: crate::strategy_registry::StrategySessionCommand,
    },
    /// Run a prompt using the session's immutable host template and advisory.
    Agent {
        #[arg(long)]
        session: String,
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        prompt: String,
        #[arg(long)]
        continuation: Option<String>,
    },
    /// Retain a private, frozen host plan; does not run either evaluation lane.
    Create {
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        plan: PathBuf,
        /// Bind before evaluation to the configured real baseline/epoch and this inert candidate.
        #[arg(long)]
        candidate_generation: Option<String>,
    },
    /// Run one explicit lane. Final requires completed development and consumes protected exposure.
    Run {
        #[arg(long)]
        campaign: String,
        #[arg(long, value_enum)]
        lane: Lane,
    },
    /// Inspect aggregate holds and actual charges, including while an engine owns the state.
    Status {
        #[arg(long)]
        campaign: String,
        #[arg(long, value_enum, default_value = "json")]
        format: Format,
    },
    /// Read a bounded metadata page, without private scenarios or provider requests.
    Runs {
        #[arg(long)]
        campaign: String,
        #[arg(long, default_value_t = 0)]
        after_sequence: u64,
        #[arg(long, default_value_t=50, value_parser=clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, value_enum, default_value = "json")]
        format: Format,
    },
    /// Revalidate retained measurements. Qualification never grants promotion or security verification.
    Report {
        #[arg(long)]
        campaign: String,
        #[arg(long, value_enum, default_value = "json")]
        format: Format,
    },
    /// Development measurements only; this view excludes protected final outcomes.
    DevFeedback {
        #[arg(long)]
        campaign: String,
        #[arg(long, value_enum, default_value = "json")]
        format: Format,
    },
}
impl StrategyCommand {
    pub fn requires_dispatch(&self) -> bool {
        matches!(
            self,
            Self::Create { .. } | Self::Run { .. } | Self::Session { .. } | Self::Agent { .. }
        )
    }
}
pub async fn command(command: &StrategyCommand) -> Result<Command, Box<dyn Error>> {
    Ok(match command {
        StrategyCommand::Create {
            command_id,
            plan,
            candidate_generation,
        } => {
            let bytes = crate::providers::read_bounded(plan).await?;
            let plan: StrategyPlan =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid private strategy plan JSON")?;
            plan.validate()
                .map_err(|_| "Invalid strategy plan authority, schedule or bounds")?;
            if let Some(candidate_generation) = candidate_generation {
                Command::CreateBoundStrategyCampaign {
                    command_id: command_id.clone(),
                    plan: Box::new(plan),
                    candidate_generation: candidate_generation.clone(),
                }
            } else {
                Command::CreateStrategyCampaign {
                    command_id: command_id.clone(),
                    plan: Box::new(plan),
                }
            }
        }
        StrategyCommand::Session {
            command: crate::strategy_registry::StrategySessionCommand::Create { budget_limit },
        } => Command::CreateStrategySession {
            budget_limit: *budget_limit,
        },
        StrategyCommand::Agent {
            session,
            command_id,
            prompt,
            continuation,
        } => Command::RunStrategyAgent {
            session_id: session.clone(),
            command_id: command_id.clone(),
            prompt: prompt.clone(),
            continuation_of: continuation.clone(),
        },
        StrategyCommand::Run { campaign, lane } => Command::RunStrategyCampaign {
            campaign_id: campaign.clone(),
            lane: (*lane).into(),
        },
        _ => return Err("Strategy inspection does not dispatch".into()),
    })
}
pub async fn readonly(path: &Path, command: &StrategyCommand) -> Result<bool, Box<dyn Error>> {
    match command {
        StrategyCommand::Registry { command } => {
            return crate::strategy_registry::run_registry(command).await;
        }
        StrategyCommand::Eligibility { command } => {
            return crate::strategy_registry::run_eligibility(path, command).await;
        }
        _ => {}
    }
    let path = path.to_owned();
    let (id, format) = match command {
        StrategyCommand::Status { campaign, format }
        | StrategyCommand::Runs {
            campaign, format, ..
        }
        | StrategyCommand::Report { campaign, format }
        | StrategyCommand::DevFeedback { campaign, format } => (campaign.clone(), *format),
        _ => return Err("Strategy mutation requires an owning engine".into()),
    };
    let kind = match command {
        StrategyCommand::Status { .. } => 0,
        StrategyCommand::Runs { .. } => 1,
        StrategyCommand::Report { .. } => 2,
        _ => 3,
    };
    let (after, limit) = match command {
        StrategyCommand::Runs {
            after_sequence,
            limit,
            ..
        } => (*after_sequence, *limit),
        _ => (0, 50),
    };
    let reply = tokio::task::spawn_blocking(move || -> Result<Reply, zero_engine::EngineError> {
        Ok(match kind {
            0 => Reply::CampaignStatus {
                snapshot: zero_engine::read_campaign_status(&path, &id)?,
            },
            1 => Reply::CampaignRuns {
                page: zero_engine::read_campaign_runs(&path, &id, after, limit)?,
            },
            2 => Reply::StrategyCampaignReport {
                report: zero_engine::read_strategy_report(&path, &id)?,
            },
            _ => Reply::StrategyDevelopmentFeedback {
                feedback: zero_engine::read_strategy_development_feedback(&path, &id)?,
            },
        })
    })
    .await??;
    match format {
        Format::Json => crate::write_json(&reply, false).await?,
        Format::Text => write_text(&render(&reply)?).await?,
    }
    Ok(true)
}
async fn write_text(text: &str) -> Result<(), Box<dyn Error>> {
    use tokio::io::AsyncWriteExt;
    let mut out = tokio::io::stdout();
    tokio::select! {
        result=tokio::time::timeout(std::time::Duration::from_secs(5),async {out.write_all(text.as_bytes()).await?;out.flush().await})=>result.map_err(|_|"Strategy output deadline exceeded")??,
        _=crate::server::shutdown_signal()=>return Err("Strategy output interrupted".into()),
    }
    Ok(())
}
fn safe(s: &str) -> String {
    crate::console::terminal_text(s)
}
fn usage(out: &mut String, u: &CampaignUsage) {
    let _ = writeln!(
        out,
        "Model micro-USD: {} charged, {} held; {} calls",
        u.model_charged_micro_usd, u.model_reserved_micro_usd, u.model_calls
    );
    let _ = writeln!(
        out,
        "HTTP: {} requests; {} request-body bytes; {} response bytes charged, {} held",
        u.http_requests,
        u.http_request_body_bytes,
        u.http_response_charged_bytes,
        u.http_response_reserved_bytes
    );
    let _ = writeln!(
        out,
        "Runs: {} admitted, {} active, {} unknown; {} experiments admitted",
        u.runs, u.active_runs, u.unknown_runs, u.experiments
    );
    out.push_str("Holds remain reserved. Actual charges may exceed estimates; admission limits are not an invoice guarantee.\n");
}
fn cases(out: &mut String, rows: &[StrategyCaseResult]) {
    for row in rows {
        let _ = writeln!(
            out,
            "{} {:?}/{:?} repeat {}: {:?}; matched {}; supported {}; unsupported {}; run {}",
            safe(&row.scenario_id),
            row.lane,
            row.variant,
            row.repeat_index,
            row.disposition,
            row.matched,
            row.supported_findings,
            row.unsupported_claims,
            safe(&row.run_id)
        );
        if let Some(error) = &row.error {
            let _ = writeln!(out, "  {}", safe(error));
        }
    }
}
fn render(reply: &Reply) -> Result<String, Box<dyn Error>> {
    // Retained inputs are bounded by the controller; independently bound this display surface.
    if serde_json::to_vec(reply)?.len() > 2 * 1024 * 1024 {
        return Err("Strategy inspection exceeds display bound".into());
    }
    let mut out = String::from(
        "qualification_only — no promotion, eligibility or security verification granted\n",
    );
    match reply {
        Reply::CampaignStatus { snapshot: s } => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            writeln!(
                out,
                "Campaign {}: {:?}",
                safe(&s.campaign.id),
                s.campaign.status
            )?;
            writeln!(
                out,
                "Snapshot as of event {} at {} ms UTC ({} ms ago; not live admission authority)",
                s.as_of_sequence,
                s.as_of_ms,
                now.saturating_sub(s.as_of_ms)
            )?;
            usage(&mut out, &s.usage);
            let l = &s.campaign.plan.limits;
            writeln!(
                out,
                "Limits: {} model micro-USD / {} calls / {} HTTP requests / {} request-body bytes / {} response bytes / {} experiments / {} runs / {} parallel runs",
                l.model_micro_usd,
                l.model_calls,
                l.http_requests,
                l.http_request_body_bytes,
                l.http_response_decoded_bytes,
                l.experiments,
                l.runs,
                l.max_parallel_runs
            )?;
            out.push_str("Cancelled closes new admissions; inspect active/unknown runs and holds for cleanup state.\n");
        }
        Reply::CampaignRuns { page } => {
            out.push_str("Retained run metadata; statuses are not qualification verdicts.\n");
            for r in &page.runs {
                writeln!(
                    out,
                    "{} {:?}/{:?} {} repeat {}: {:?}; session {}; operation {}",
                    safe(&r.id),
                    r.lane,
                    r.variant,
                    safe(&r.scenario_id),
                    r.repeat_index,
                    r.status,
                    safe(&r.session_id),
                    safe(r.operation_id.as_deref().unwrap_or("not admitted"))
                )?;
            }
            writeln!(
                out,
                "Next after-sequence: {}",
                page.next_after_sequence
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "exhausted".into())
            )?;
        }
        Reply::StrategyCampaignReport { report: r } => {
            if r.qualification != "qualification_only" {
                return Err("Unknown strategy report qualification".into());
            }
            writeln!(
                out,
                "Campaign {} — {:?}; completed lanes {:?}",
                safe(&r.campaign_id),
                r.decision,
                r.completed_lanes
            )?;
            writeln!(
                out,
                "Retained report {}; evidence {}",
                safe(&r.report_sha256),
                safe(&r.evidence_sha256)
            )?;
            out.push_str("Report usage has no snapshot timestamp; use strategy status for a fresh aggregate snapshot.\n");
            usage(&mut out, &r.usage);
            for reason in &r.reasons {
                writeln!(out, "Reason: {}", safe(reason))?;
            }
            cases(&mut out, &r.case_results);
        }
        Reply::StrategyDevelopmentFeedback { feedback: f } => {
            if f.cases.iter().any(|r| r.lane != CampaignLane::Development) {
                return Err("Development feedback contains protected lane rows".into());
            }
            writeln!(
                out,
                "Campaign {} — development measurements only; no final verdict",
                safe(&f.campaign_id)
            )?;
            cases(&mut out, &f.cases);
        }
        _ => return Err("Unexpected strategy inspection response".into()),
    }
    if out.len() > 2 * 1024 * 1024 {
        return Err("Strategy text exceeds display bound".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn report() -> StrategyReport {
        serde_json::from_value(json!({"schema_version":1,"qualification":"qualification_only","campaign_id":"campaign","plan_sha256":"plan","baseline_sha256":"base","candidate_sha256":"candidate","evaluator_version":"fixture","renderer_version":"renderer","suite_sha256":"suite","completed_lanes":["development"],"decision":"inconclusive","reasons":["protected_final_not_run","hostile\u{1b}[2Jtext"],"case_results":[],"usage":CampaignUsage{model_reserved_micro_usd:10,model_charged_micro_usd:17,unknown_runs:1,..Default::default()},"evidence_sha256":"evidence","report_sha256":"report"})).unwrap()
    }
    #[test]
    fn report_distinguishes_retained_holds_qualification_and_inert_text() {
        let rendered = render(&Reply::StrategyCampaignReport { report: report() }).unwrap();
        assert!(rendered.contains("qualification_only"));
        assert!(rendered.contains("17 charged, 10 held"));
        assert!(rendered.contains("protected_final_not_run"));
        assert!(rendered.contains("strategy status for a fresh"));
        assert!(!rendered.contains('\u{1b}'));
        let mut invalid = report();
        invalid.qualification = "eligible".into();
        assert!(render(&Reply::StrategyCampaignReport { report: invalid }).is_err());
    }
    #[test]
    fn development_feedback_rejects_final_rows_and_never_prints_final_verdict() {
        let mut f = StrategyDevelopmentFeedback {
            schema_version: 1,
            campaign_id: "campaign".into(),
            plan_sha256: "plan".into(),
            baseline_sha256: "base".into(),
            candidate_sha256: "candidate".into(),
            cases: vec![],
        };
        let text = render(&Reply::StrategyDevelopmentFeedback {
            feedback: f.clone(),
        })
        .unwrap();
        assert!(text.contains("development measurements only; no final verdict"));
        f.cases.push(serde_json::from_value(json!({"schedule_index":1,"run_id":"run","session_id":"session","operation_id":null,"scenario_id":"protected","family":"final-family","lane":"final","variant":"candidate","repeat_index":0,"disposition":"unknown","matched":false,"supported_findings":0,"unsupported_claims":0,"observations":[],"model_charged_micro_usd":0,"model_reserved_micro_usd":10,"error":null})).unwrap());
        assert!(render(&Reply::StrategyDevelopmentFeedback { feedback: f }).is_err());
    }
    #[test]
    fn explicit_lane_is_required_and_no_standalone_cancel_is_advertised() {
        use clap::Parser;
        assert!(
            crate::args::Args::try_parse_from(["native", "strategy", "run", "--campaign", "c"])
                .is_err()
        );
        assert!(
            crate::args::Args::try_parse_from([
                "native",
                "strategy",
                "run",
                "--campaign",
                "c",
                "--lane",
                "final"
            ])
            .is_ok()
        );
        assert!(
            crate::args::Args::try_parse_from(["native", "strategy", "cancel", "--campaign", "c"])
                .is_err()
        );
    }
}
