//! Explicit trusted-host registry operations; never model tools or evaluator pass flags.
use clap::Subcommand;
use std::path::PathBuf;

#[derive(Debug, Subcommand)]
pub enum RegistryCommand {
    /// Install a fresh, explicitly trusted unmeasured baseline with real strategy capture.
    Bootstrap {
        #[arg(long)]
        host: PathBuf,
        #[arg(long)]
        baseline: PathBuf,
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        reason: String,
    },
    /// Retain a candidate changing only the advisory component; grants no eligibility.
    Register {
        #[arg(long)]
        registry: PathBuf,
        #[arg(long)]
        baseline_generation: String,
        #[arg(long)]
        advisory: PathBuf,
    },
    /// Inspect actual registry identity, current state and strategy capture without activation.
    Status {
        #[arg(long)]
        registry: PathBuf,
        #[arg(long, value_enum, default_value = "json")]
        format: crate::strategy::Format,
    },
}

#[derive(Debug, Subcommand)]
pub enum EligibilityCommand {
    /// Recompute source evidence and required bindings; does not import or grant anything.
    Prepare {
        #[arg(long)]
        registry: PathBuf,
        #[arg(long)]
        campaign: String,
        #[arg(long, value_enum, default_value = "json")]
        format: crate::strategy::Format,
    },
    /// Import independently validated campaign evidence; never accepts report JSON or a pass flag.
    Import {
        #[arg(long)]
        registry: PathBuf,
        #[arg(long)]
        campaign: String,
        #[arg(long)]
        command_id: String,
        #[arg(long)]
        expected_evidence: String,
    },
    /// Reassess a retained import offline and show its current usability separately.
    Show {
        #[arg(long)]
        registry: PathBuf,
        #[arg(long)]
        receipt: String,
        #[arg(long, value_enum, default_value = "json")]
        format: crate::strategy::Format,
    },
}

#[derive(Debug, Subcommand)]
pub enum StrategySessionCommand {
    /// Capture the configured real strategy generation/epoch before accepting a prompt.
    Create {
        #[arg(long, default_value_t = 0)]
        budget_limit: u64,
    },
}

use std::{error::Error, path::Path};

async fn output(
    value: &impl serde::Serialize,
    format: crate::strategy::Format,
    label: &str,
) -> Result<(), Box<dyn Error>> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("Strategy registry response exceeds 2 MiB display bound".into());
    }
    match format {
        crate::strategy::Format::Json => crate::write_json(value, false).await?,
        crate::strategy::Format::Text => {
            use tokio::io::AsyncWriteExt;
            let text = format!(
                "{}\n{}\n",
                label,
                crate::console::terminal_text(&serde_json::to_string_pretty(value)?)
            );
            if text.len() > 4 * 1024 * 1024 {
                return Err("Strategy registry text exceeds display bound".into());
            }
            let mut stdout = tokio::io::stdout();
            tokio::select! {
                result=tokio::time::timeout(std::time::Duration::from_secs(5),async {stdout.write_all(text.as_bytes()).await?;stdout.flush().await})=>result.map_err(|_|"Strategy registry output deadline exceeded")??,
                _=crate::server::shutdown_signal()=>return Err("Strategy registry output interrupted".into()),
            }
        }
    }
    Ok(())
}

pub async fn run_registry(command: &RegistryCommand) -> Result<bool, Box<dyn Error>> {
    match command {
        RegistryCommand::Bootstrap {
            host,
            baseline,
            command_id,
            reason,
        } => {
            let receipt =
                crate::strategy_host::bootstrap(host, baseline, command_id, reason).await?;
            output(
                &receipt,
                crate::strategy::Format::Json,
                "trusted_unmeasured_baseline",
            )
            .await?;
        }
        RegistryCommand::Register {
            registry,
            baseline_generation,
            advisory,
        } => {
            let advice = crate::strategy_host::advisory(advisory).await?;
            let path = registry.clone();
            let baseline = baseline_generation.clone();
            let value = tokio::task::spawn_blocking(move || -> Result<_, String> {
                // Candidate registration never initializes a missing registry.
                let existing =
                    zero_evolution::Registry::open_read_only(&path).map_err(|e| e.to_string())?;
                let base = existing.generation(&baseline).map_err(|e| e.to_string())?;
                drop(existing);
                let registry =
                    zero_evolution::Registry::open(path, "native-host", &serde_json::json!({}))
                        .map_err(|e| e.to_string())?;
                zero_harness::Harness::new(registry, base.engine_artifact)
                    .register_strategy_candidate(&baseline, &advice)
                    .map_err(|e| e.to_string())
            })
            .await?
            .map_err(std::io::Error::other)?;
            output(
                &value,
                crate::strategy::Format::Json,
                "Candidate retained; no eligibility or activation granted",
            )
            .await?;
        }
        RegistryCommand::Status { registry, format } => {
            let path = registry.clone();
            let value = tokio::task::spawn_blocking(move || registry_status(&path))
                .await?
                .map_err(std::io::Error::other)?;
            output(&value,*format,"Registry snapshot at read time; runtime capture is separate from measured eligibility").await?;
        }
    }
    Ok(true)
}

pub async fn run_eligibility(
    state: &Path,
    command: &EligibilityCommand,
) -> Result<bool, Box<dyn Error>> {
    eligibility(state, command, false).await
}

pub async fn run_search_eligibility(
    state: &Path,
    command: &EligibilityCommand,
) -> Result<bool, Box<dyn Error>> {
    eligibility(state, command, true).await
}

async fn eligibility(
    state: &Path,
    command: &EligibilityCommand,
    search: bool,
) -> Result<bool, Box<dyn Error>> {
    match command {
        EligibilityCommand::Prepare {
            registry,
            campaign,
            format,
        } => {
            let state = state.to_owned();
            let registry = registry.clone();
            let campaign = campaign.clone();
            let value = tokio::task::spawn_blocking(move || {
                if search {
                    serde_json::to_value(zero_engine::prepare_strategy_search_eligibility(
                        &state, &registry, &campaign,
                    )?)
                } else {
                    serde_json::to_value(zero_engine::prepare_strategy_eligibility(
                        &state, &registry, &campaign,
                    )?)
                }
                .map_err(zero_engine::EngineError::from)
            })
            .await??;
            output(
                &value,
                *format,
                "Independent evidence preparation; no eligibility or activation granted",
            )
            .await?;
        }
        EligibilityCommand::Import {
            registry,
            campaign,
            command_id,
            expected_evidence,
        } => {
            if !zero_protocol::is_sha256(expected_evidence) {
                return Err("Expected evidence must be a canonical sha256 digest".into());
            }
            let state = state.to_owned();
            let registry = registry.clone();
            let campaign = campaign.clone();
            let command = command_id.clone();
            let expected = expected_evidence.clone();
            // The bridge resolves exact retained command identity before any source/config lookup.
            let mut task = tokio::task::spawn_blocking(move || {
                let request = zero_protocol::strategy_registry::StrategyImportRequest {
                    command_id: command,
                    campaign_id: campaign,
                    expected_evidence_sha256: expected,
                };
                if search {
                    zero_engine::import_strategy_search_eligibility(&state, &registry, &request)
                } else {
                    zero_engine::import_strategy_eligibility(&state, &registry, &request)
                }
            });
            let mut interrupted = false;
            let value = tokio::select! {
                result=&mut task=>result??,
                _=crate::server::shutdown_signal()=>{interrupted=true;task.await??},
            };
            output(
                &value,
                crate::strategy::Format::Json,
                "Measured scoped eligibility; not candidate activation or a completed canary",
            )
            .await?;
            return Ok(!interrupted);
        }
        EligibilityCommand::Show {
            registry,
            receipt,
            format,
        } => {
            if !zero_protocol::is_sha256(receipt) {
                return Err("Receipt must be a canonical sha256 digest".into());
            }
            let registry = registry.clone();
            let receipt = receipt.clone();
            let value = tokio::task::spawn_blocking(move || {
                if search {
                    zero_engine::read_strategy_search_eligibility_receipt(&registry, &receipt)
                } else {
                    zero_engine::read_strategy_eligibility_receipt(&registry, &receipt)
                }
            })
            .await??;
            output(
                &value,
                *format,
                "Retained measured scope; current usability is separate from runtime activation",
            )
            .await?;
        }
    }
    Ok(true)
}

fn registry_status(path: &Path) -> Result<serde_json::Value, String> {
    let registry = zero_evolution::Registry::open_read_only(path).map_err(|e| e.to_string())?;
    let identity = registry.identity().map_err(|e| e.to_string())?;
    let current = registry.current().map_err(|e| e.to_string())?;
    let state = serde_json::json!({"epoch":current.epoch,"generation":current.generation,"state_schema":current.state_schema,"state_sha256":current.state_digest});
    let strategy = if let Some(generation) = &current.generation {
        let manifest = registry.generation(generation).map_err(|e| e.to_string())?;
        if manifest.configuration.get("native_plugin_graph") == Some(&serde_json::json!(2))
            || manifest.configuration.get("strategy").is_some()
            || manifest
                .components
                .keys()
                .any(|k| k.starts_with("strategy:"))
        {
            let harness = zero_harness::Harness::new(registry, manifest.engine_artifact);
            let capture = harness
                .inspect_strategy_capture()
                .map_err(|e| e.to_string())?;
            if capture.generation != *generation
                || capture.epoch != current.epoch
                || capture.state_sha256 != current.state_digest
                || capture.registry != identity
            {
                return Err(
                    "Registry state changed during strategy inspection; retry readonly status"
                        .into(),
                );
            }
            Some(
                serde_json::json!({"generation":capture.generation,"epoch":capture.epoch,"advisory_sha256":capture.advisory_sha256,"host_policy_sha256":capture.host_policy_sha256}),
            )
        } else {
            None
        }
    } else {
        None
    };
    let observed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok(
        serde_json::json!({"registry":identity,"current":state,"strategy":strategy,"observed_at_ms":observed,"qualification":"runtime_registry_state_only"}),
    )
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    #[test]
    fn bound_create_accepts_global_host_in_either_position_and_offline_retry() {
        let command = [
            "strategy",
            "create",
            "--command-id",
            "c",
            "--plan",
            "plan.json",
            "--candidate-generation",
            "generation",
        ];
        for position in 0..3 {
            let mut args = vec!["native"];
            if position == 0 {
                args.extend(["--strategy-host", "host.json"]);
            }
            args.extend(command);
            if position == 1 {
                args.extend(["--strategy-host", "host.json"]);
            }
            assert!(crate::args::Args::try_parse_from(args).is_ok());
        }
    }

    #[test]
    fn no_activation_or_caller_pass_route() {
        for args in [
            vec![
                "native",
                "strategy",
                "registry",
                "activate",
                "--generation",
                "candidate",
            ],
            vec![
                "native",
                "strategy",
                "eligibility",
                "import",
                "--registry",
                "registry.db",
                "--campaign",
                "c",
                "--command-id",
                "i",
            ],
            vec![
                "native",
                "strategy",
                "eligibility",
                "import",
                "--registry",
                "registry.db",
                "--campaign",
                "c",
                "--command-id",
                "i",
                "--expected-evidence",
                "digest",
                "--pass",
            ],
        ] {
            assert!(crate::args::Args::try_parse_from(args).is_err());
        }
    }
}
