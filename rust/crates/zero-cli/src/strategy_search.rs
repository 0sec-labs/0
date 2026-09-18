//! One immutable account for advisory proposals and independently measured search.
use crate::strategy::Format;
use clap::Subcommand;
use std::{
    error::Error,
    path::{Path, PathBuf},
};
use zero_protocol::{Command, Reply, strategy_search::StrategySearchPlan};

#[derive(Debug, Subcommand)]
pub enum SearchCommand {
    /// Prepare/import/inspect full-history source evidence; never activates a candidate.
    Eligibility {
        #[command(subcommand)]
        command: crate::strategy_registry::EligibilityCommand,
    },
    /// Freeze a private versioned search plan and aggregate account; starts no model call.
    Create {
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        plan: PathBuf,
    },
    /// Run the bounded proposal/evaluation loop under the retained account.
    Run {
        #[arg(long)]
        campaign: String,
    },
    /// Inspect aggregate charges, holds and current controller state without taking ownership.
    Status {
        #[arg(long)]
        campaign: String,
        #[arg(long, value_enum, default_value = "json")]
        format: Format,
    },
    /// Read a bounded page of admitted candidate evaluations.
    Candidates {
        #[arg(long)]
        campaign: String,
        #[arg(long, default_value_t = 0)]
        after_sequence: u64,
        #[arg(long, default_value_t=50, value_parser=clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, value_enum, default_value = "json")]
        format: Format,
    },
    /// Inspect retained candidate identity and independently measured Development results.
    Candidate {
        #[arg(long)]
        campaign: String,
        #[arg(long)]
        candidate: String,
        #[arg(long, value_enum, default_value = "json")]
        format: Format,
    },
    /// Reconstruct whole search history and measurements; grants no eligibility or activation.
    Report {
        #[arg(long)]
        campaign: String,
        #[arg(long, value_enum, default_value = "json")]
        format: Format,
    },
}
impl SearchCommand {
    pub fn requires_dispatch(&self) -> bool {
        matches!(self, Self::Create { .. } | Self::Run { .. })
    }
}
pub async fn command(command: &SearchCommand) -> Result<Command, Box<dyn Error>> {
    Ok(match command {
        SearchCommand::Create { command_id, plan } => {
            let bytes = crate::providers::read_bounded(plan).await?;
            let plan: StrategySearchPlan = serde_json::from_slice(&bytes)
                .map_err(|_| "Invalid private strategy search plan JSON")?;
            plan.validate()
                .map_err(|_| "Invalid strategy search plan authority, schedules or bounds")?;
            Command::CreateStrategySearch {
                command_id: command_id.clone(),
                plan: Box::new(plan),
            }
        }
        SearchCommand::Run { campaign } => Command::RunStrategySearch {
            campaign_id: campaign.clone(),
        },
        _ => return Err("Strategy search inspection does not dispatch".into()),
    })
}

pub async fn readonly(path: &Path, command: &SearchCommand) -> Result<bool, Box<dyn Error>> {
    if let SearchCommand::Eligibility { command } = command {
        return crate::strategy_registry::run_search_eligibility(path, command).await;
    }
    let (campaign, format) = match command {
        SearchCommand::Status { campaign, format }
        | SearchCommand::Candidates {
            campaign, format, ..
        }
        | SearchCommand::Candidate {
            campaign, format, ..
        }
        | SearchCommand::Report { campaign, format } => (campaign.clone(), *format),
        _ => return Err("Strategy search mutation requires an owning engine".into()),
    };
    let (kind, after, limit, candidate) = match command {
        SearchCommand::Status { .. } => (0, 0, 50, String::new()),
        SearchCommand::Candidates {
            after_sequence,
            limit,
            ..
        } => (1, *after_sequence, *limit, String::new()),
        SearchCommand::Candidate { candidate, .. } => (2, 0, 50, candidate.clone()),
        _ => (3, 0, 50, String::new()),
    };
    let path = path.to_owned();
    let reply = tokio::task::spawn_blocking(move || -> Result<Reply, zero_engine::EngineError> {
        Ok(match kind {
            0 => Reply::StrategySearchStatus {
                snapshot: zero_engine::read_strategy_search_status(&path, &campaign)?,
            },
            1 => Reply::StrategySearchCandidates {
                page: zero_engine::read_strategy_search_candidates(&path, &campaign, after, limit)?,
            },
            2 => Reply::StrategySearchCandidate {
                candidate: zero_engine::read_strategy_search_candidate(
                    &path, &campaign, &candidate,
                )?,
            },
            _ => Reply::StrategySearchReport {
                report: zero_engine::read_strategy_search_report(&path, &campaign)?,
            },
        })
    })
    .await??;
    if serde_json::to_vec(&reply)?.len() > 2 * 1024 * 1024 {
        return Err("Strategy search display exceeds 2 MiB bound".into());
    }
    match format {
        Format::Json => crate::write_json(&reply, false).await?,
        Format::Text => crate::strategy::write_text(&render(&reply)?).await?,
    }
    Ok(true)
}
fn render(reply: &Reply) -> Result<String, Box<dyn Error>> {
    use std::fmt::Write;
    let mut out = String::from(match reply {
        Reply::StrategySearchReport { report } if report.schema_version == 1 => {
            "Development search only — no protected Final, canary, eligibility or activation.\n"
        }
        _ => {
            "Search inspection — measurements are not eligibility, canary completion or activation.\n"
        }
    });
    match reply {
        Reply::StrategySearchStatus { snapshot } => {
            out.push_str(&crate::strategy::render(&Reply::CampaignStatus {
                snapshot: snapshot.campaign.clone(),
            })?);
            writeln!(
                out,
                "Proposal attempts {}, candidates {}; active proposals {}, Unknown proposals {}",
                snapshot.proposal_attempts,
                snapshot.candidates,
                snapshot.active_proposals,
                snapshot.unknown_proposals
            )?;
        }
        Reply::StrategySearchCandidates { page } => {
            for c in &page.candidates {
                writeln!(
                    out,
                    "Candidate {} — generation {}, proposal {}, sequence {}",
                    crate::console::terminal_text(&c.id),
                    crate::console::terminal_text(&c.candidate_generation),
                    crate::console::terminal_text(&c.proposal_id),
                    c.sequence
                )?;
            }
            writeln!(
                out,
                "Next after sequence: {}",
                page.next_after_sequence
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "exhausted".into())
            )?;
        }
        Reply::StrategySearchCandidate { candidate } => {
            candidate_text(&mut out, candidate)?;
        }
        Reply::StrategySearchReport { report } => {
            if !matches!(
                (report.schema_version, report.qualification.as_str()),
                (1, "development_only") | (2, "adaptive_search_fixture")
            ) || (report.schema_version == 1
                && (report.selection.is_some() || report.final_measurement.is_some()))
                || (report.final_measurement.is_some() && report.selection.is_none())
            {
                return Err("Unexpected strategy search qualification".into());
            }
            writeln!(
                out,
                "Campaign {}; report {}",
                crate::console::terminal_text(&report.campaign_id),
                crate::console::terminal_text(&report.report_sha256)
            )?;
            out.push_str("Retained report has no snapshot timestamp; use search status for a fresh aggregate snapshot.\n");
            crate::strategy::usage(&mut out, &report.usage);
            if let Some(stop) = &report.stop_reason {
                writeln!(out, "Stop: {}", crate::console::terminal_text(stop))?;
            }
            for p in &report.proposals {
                writeln!(
                    out,
                    "Proposal attempt {}: {:?}; operation {}",
                    p.proposal.attempt_index,
                    p.operation_status,
                    crate::console::terminal_text(&p.proposal.operation_id)
                )?;
                if let Some(error) = &p.error {
                    writeln!(
                        out,
                        "Proposal result: {}",
                        crate::console::terminal_text(error)
                    )?;
                }
                if let Some(output) = &p.output {
                    match output {
                        zero_protocol::strategy_search::SearchProposalOutput::Propose {
                            rationale,
                            ..
                        } => writeln!(
                            out,
                            "Model rationale (untrusted): {}",
                            crate::console::terminal_text(rationale)
                        )?,
                        zero_protocol::strategy_search::SearchProposalOutput::SelectFinal {
                            evaluation_id,
                            rationale,
                        } => {
                            writeln!(
                                out,
                                "Model selected evaluation {} (untrusted rationale): {}",
                                crate::console::terminal_text(evaluation_id),
                                crate::console::terminal_text(rationale)
                            )?;
                        }
                        zero_protocol::strategy_search::SearchProposalOutput::Stop { reason } => {
                            writeln!(
                                out,
                                "Model stop reason (untrusted): {}",
                                crate::console::terminal_text(reason)
                            )?
                        }
                    }
                }
            }
            for c in &report.evaluations {
                candidate_text(&mut out, c)?;
            }
            if report.schema_version == 2 {
                if let Some(selection) = &report.selection {
                    writeln!(
                        out,
                        "Protected Final selection: {}; candidate {}; exposure {}; allocated run slots {} at {}",
                        crate::console::terminal_text(&selection.evaluation_id),
                        crate::console::terminal_text(&selection.candidate_generation),
                        crate::console::terminal_text(&selection.exposure_id),
                        selection.run_count,
                        selection.schedule_start
                    )?;
                    writeln!(
                        out,
                        "Protected suite {}; Final pair {}",
                        crate::console::terminal_text(&selection.suite_sha256),
                        crate::console::terminal_text(&selection.final_pair_sha256)
                    )?;
                    out.push_str("Selection seals further proposals; allocated slots do not prove execution or completion.\n");
                } else {
                    out.push_str("Protected Final: no retained selection; stopping does not select a winner.\n");
                }
                if let Some(measurement) = &report.final_measurement {
                    if measurement
                        .cases
                        .iter()
                        .any(|case| case.lane != zero_protocol::campaign::CampaignLane::Final)
                    {
                        return Err("Protected Final measurement contains a different lane".into());
                    }
                    writeln!(
                        out,
                        "Independent protected Final measurement: {:?}",
                        measurement.decision
                    )?;
                    for reason in &measurement.reasons {
                        writeln!(
                            out,
                            "Measurement reason: {}",
                            crate::console::terminal_text(reason)
                        )?;
                    }
                    crate::strategy::cases(&mut out, &measurement.cases);
                    if let Some(digest) = &measurement.matrix_sha256 {
                        writeln!(
                            out,
                            "Final matrix {}",
                            crate::console::terminal_text(digest)
                        )?;
                    }
                } else {
                    out.push_str(
                        "Protected Final measurement unavailable; no completed outcome inferred.\n",
                    );
                }
                out.push_str("Full-history source evidence must be independently imported before measured eligibility; import never activates a candidate.\n");
            }
        }
        _ => return Err("Unexpected strategy search inspection response".into()),
    }
    if out.len() > 2 * 1024 * 1024 {
        return Err("Strategy search text exceeds display bound".into());
    }
    Ok(out)
}
fn candidate_text(
    out: &mut String,
    c: &zero_protocol::strategy_search::SearchEvaluationReport,
) -> Result<(), Box<dyn Error>> {
    use std::fmt::Write;
    if c.cases
        .iter()
        .any(|case| case.lane != zero_protocol::campaign::CampaignLane::Development)
    {
        return Err("Search candidate contains a protected-lane result".into());
    }
    writeln!(
        out,
        "Candidate {} — Development improvement: {}",
        crate::console::terminal_text(&c.evaluation.id),
        c.improved
    )?;
    writeln!(
        out,
        "Generation {}; paired evidence {}",
        crate::console::terminal_text(&c.evaluation.candidate_generation),
        crate::console::terminal_text(&c.evaluation.evaluation_pair_sha256)
    )?;
    for reason in &c.reasons {
        writeln!(
            out,
            "Measurement reason: {}",
            crate::console::terminal_text(reason)
        )?;
    }
    crate::strategy::cases(out, &c.cases);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use serde_json::json;
    use zero_protocol::{campaign::CampaignUsage, strategy_search::StrategySearchReport};
    fn report() -> StrategySearchReport {
        serde_json::from_value(json!({"schema_version":1,"campaign_id":"search","config_sha256":"config","qualification":"development_only","proposals":[{"proposal":{"id":"p","campaign_id":"search","command_id":"p","session_id":"s","operation_id":"op","attempt_index":0,"owner":"owner","request_sha256":"request","feedback_sha256":null,"sequence":1},"operation_status":"succeeded","output":{"action":"propose","advisory":{"schema_version":1,"advisory_utf8":"advice"},"rationale":"hostile\u{1b}[2J success claim"},"error":null}],"evaluations":[],"usage":CampaignUsage{model_reserved_micro_usd:10,model_charged_micro_usd:7,..Default::default()},"stop_reason":"model_stop","report_sha256":"report"})).unwrap()
    }
    #[test]
    fn search_text_separates_rationale_qualification_and_aggregate_holds() {
        let text = render(&Reply::StrategySearchReport { report: report() }).unwrap();
        assert!(text.contains("no protected Final, canary, eligibility or activation"));
        assert!(text.contains("7 charged, 10 held"));
        assert!(text.contains("Model rationale (untrusted)"));
        assert!(text.contains("fresh aggregate snapshot"));
        assert!(!text.contains('\u{1b}'));
        let mut invalid = report();
        invalid.qualification = "eligible".into();
        assert!(render(&Reply::StrategySearchReport { report: invalid }).is_err());
    }
    #[test]
    fn unselected_v2_report_does_not_infer_final_or_eligibility() {
        let mut report = report();
        report.schema_version = 2;
        report.qualification = "adaptive_search_fixture".into();
        report.proposals[0].output =
            Some(zero_protocol::strategy_search::SearchProposalOutput::Stop {
                reason: "Enough investigation\u{1b}[2J".into(),
            });
        let text = render(&Reply::StrategySearchReport {
            report: report.clone(),
        })
        .unwrap();
        assert!(text.contains("no retained selection"));
        assert!(text.contains("measurement unavailable"));
        assert!(text.contains("7 charged, 10 held"));
        assert!(!text.contains('\u{1b}'));
        report.final_measurement = Some(zero_protocol::strategy_search::SearchFinalReport {
            cases: vec![],
            decision: zero_protocol::strategy::StrategyDecision::ImprovedForFixtureSuite,
            reasons: vec![],
            matrix_sha256: None,
        });
        assert!(render(&Reply::StrategySearchReport { report }).is_err());
    }

    #[test]
    fn full_search_import_requires_identity_and_has_no_caller_success_flag() {
        let base = [
            "native",
            "strategy",
            "search",
            "eligibility",
            "import",
            "--registry",
            "r",
            "--campaign",
            "c",
            "--command-id",
            "i",
        ];
        assert!(crate::args::Args::try_parse_from(base).is_err());
        let mut valid = base.to_vec();
        valid.extend(["--expected-evidence", "sha256:example"]);
        assert!(crate::args::Args::try_parse_from(&valid).is_ok());
        valid.push("--pass");
        assert!(crate::args::Args::try_parse_from(valid).is_err());
    }

    #[test]
    fn search_has_no_final_canary_activation_or_budget_reset_flags() {
        for suffix in [
            vec!["--final"],
            vec!["--force-final"],
            vec!["--canary"],
            vec!["--auto-promote"],
            vec!["--budget-limit", "100"],
            vec!["--lane", "final"],
        ] {
            let mut args = vec!["native", "strategy", "search", "run", "--campaign", "c"];
            args.extend(suffix);
            assert!(crate::args::Args::try_parse_from(args).is_err());
        }
        assert!(
            crate::args::Args::try_parse_from([
                "native",
                "strategy",
                "search",
                "candidates",
                "--campaign",
                "c",
                "--limit",
                "0"
            ])
            .is_err()
        );
        assert!(
            crate::args::Args::try_parse_from([
                "native",
                "strategy",
                "search",
                "run",
                "--campaign",
                "c"
            ])
            .is_ok()
        );
    }
}
