//! `0sec-native connect <repo-url>` — cloud enrollment readiness and optional scan dispatch.
//!
//! Resolves cloud credentials, checks enrollment status via GET /api/enrollment/status,
//! and optionally creates scans (--run) and schedules (--schedule). Never performs
//! clone or POST by default. The token never leaves memory or enters error output.

use std::{error::Error, time::Duration};
use tokio_util::sync::CancellationToken;
use zero_cloud_client::{CloudClient, CloudError, EnrollmentOrg};

#[derive(Debug, clap::Args)]
pub struct ConnectArgs {
    /// HTTPS GitHub repository URL (positional).
    pub repo: String,

    /// Only check enrollment readiness; do not create a scan or clone.
    #[arg(long, conflicts_with_all = ["run", "schedule"])]
    pub setup_only: bool,

    /// Create a scan and detect/use a test command.
    #[arg(long)]
    pub run: bool,

    /// Create a recurring schedule (implies --run).
    #[arg(long, requires = "run")]
    pub schedule: bool,

    /// Explicit cron expression for --schedule.
    #[arg(long, requires = "schedule")]
    pub cron: Option<String>,

    /// Explicit test command; skip detection.
    #[arg(long)]
    pub test_command: Option<String>,

    /// Explicit cloud host.
    #[arg(long, global = false)]
    pub host: Option<String>,

    /// Token environment variable name.
    #[arg(long, global = false, default_value = "0SEC_CLOUD_TOKEN")]
    pub token_env: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectResult {
    state: String,
    repo: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    org: Option<EnrollmentOrg>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scan_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    schedule_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    test_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scan_url: Option<String>,
}

pub async fn run(options: &ConnectArgs) -> Result<u8, Box<dyn Error>> {
    // Validate repo URL format up front.
    let repo = normalize_repo_url(&options.repo)?;
    let cancel = CancellationToken::new();

    // Resolve credentials using the same pattern as hosted::run.
    let creds = crate::hosted::credentials::resolve(
        options.host.as_deref(),
        &options.token_env,
    )
    .await?;

    let client = CloudClient::new(
        &creds.host,
        &creds.token,
        Duration::from_secs(30),
        1024 * 1024,
    )?;

    // 1. Check enrollment readiness.
    let status = match client.enrollment_status(&repo, cancel.clone()).await {
        Ok(s) => s,
        Err(CloudError::Unauthorized) => {
            return error_result("token-rejected", None, &repo);
        }
        Err(CloudError::Forbidden) => {
            return error_result("enrollment-forbidden", None, &repo);
        }
        Err(e) => {
            return error_result("enrollment-check-failed", Some(&e.to_string()), &repo);
        }
    };

    if status.authenticated != true {
        return error_result("not-authenticated", None, &repo);
    }
    if status.org.slug.is_empty() || status.org.id.is_empty() || status.org.name.is_empty() {
        return error_result("enrollment-check-failed", None, &repo);
    }
    if !status.installation.installed {
        let result = ConnectResult {
            state: "action-required".into(),
            repo: repo.clone(),
            reason: Some("github-app-not-installed".into()),
            action_url: status.installation.install_url.clone(),
            org: None,
            scan_id: None,
            schedule_id: None,
            test_command: None,
            scan_url: None,
        };
        crate::write_json(&result, false).await?;
        return Ok(1);
    }
    if status.repo_accessible != true {
        return error_result("repo-not-accessible", None, &repo);
    }

    // Enrollment is OK.
    if options.setup_only || (!options.run && !options.schedule) {
        // Default or --setup-only: just report readiness.
        let result = ConnectResult {
            state: "ready".into(),
            repo: repo.clone(),
            reason: None,
            action_url: None,
            org: Some(status.org),
            scan_id: None,
            schedule_id: None,
            test_command: None,
            scan_url: None,
        };
        crate::write_json(&result, false).await?;
        return Ok(0);
    }

    // --run (and possibly --schedule) path.
    // Detect or use explicit test command.
    let test_command = match &options.test_command {
        Some(cmd) => cmd.clone(),
        None => {
            // No detection without a local checkout; require explicit.
            crate::write_json(
                &ConnectResult {
                    state: "action-required".into(),
                    repo: repo.clone(),
                    reason: Some("no-test-command".into()),
                    action_url: None,
                    org: None,
                    scan_id: None,
                    schedule_id: None,
                    test_command: None,
                    scan_url: None,
                },
                false,
            )
            .await?;
            return Ok(1);
        }
    };

    // A failed lookup is not an empty schedule list: do not risk duplicate work.
    let list = match client
        .check_existing_schedules(&repo, cancel.clone())
        .await
    {
        Ok(list) => list,
        Err(error) => {
            return error_result("schedule-lookup-failed", Some(&error.to_string()), &repo);
        }
    };
    if let Some(sched) = list.schedules.first() {
        crate::write_json(
            &ConnectResult {
                state: "no-open".into(),
                repo: repo.clone(),
                reason: None,
                action_url: None,
                org: None,
                scan_id: None,
                schedule_id: Some(sched.id.clone()),
                test_command: Some(test_command),
                scan_url: None,
            },
            false,
        )
        .await?;
        return Ok(0);
    }

    // Create the scan (POST /api/scans).
    let secure_config = serde_json::json!({
        "repo": repo,
        "test_command": test_command,
    });

    let scan = match client
        .create_scan(&repo, &secure_config, cancel.clone())
        .await
    {
        Ok(s) => s,
        Err(e) => {
            return error_result("scan-creation-failed", Some(&e.to_string()), &repo);
        }
    };

    let mut result = ConnectResult {
        state: "ready".into(),
        repo: repo.clone(),
        reason: None,
        action_url: None,
        org: None,
        scan_id: Some(scan.id.clone()),
        schedule_id: None,
        test_command: Some(test_command.clone()),
        scan_url: Some(format!("/{}/scans/{}", status.org.slug, scan.id)),
    };

    // Create schedule only when explicitly requested and when the scan supplied a target.
    if options.schedule {
        let cron = options
            .cron
            .clone()
            .unwrap_or_else(|| "0 3 * * *".into());
        let target_id = match scan.target_id.as_deref() {
            Some(target_id) => target_id,
            None => {
                crate::write_json(
                    &ConnectResult {
                        state: "action-required".into(),
                        repo: repo.clone(),
                        reason: Some("schedule-creation-failed".into()),
                        action_url: None,
                        org: None,
                        scan_id: Some(scan.id),
                        schedule_id: None,
                        test_command: Some(test_command),
                        scan_url: result.scan_url.clone(),
                    },
                    false,
                )
                .await?;
                return Ok(1);
            }
        };
        match client
            .create_schedule(target_id, &cron, &secure_config, cancel.clone())
            .await
        {
            Ok(sched) => {
                result.schedule_id = Some(sched.id);
            }
            Err(_) => {
                let partial = ConnectResult {
                    state: "action-required".into(),
                    repo: repo.clone(),
                    reason: Some("schedule-creation-failed".into()),
                    action_url: None,
                    org: None,
                    scan_id: Some(scan.id),
                    schedule_id: None,
                    test_command: Some(test_command),
                    scan_url: result.scan_url.clone(),
                };
                crate::write_json(&partial, false).await?;
                return Ok(1);
            }
        }
    }

    crate::write_json(&result, false).await?;
    Ok(0)
}

fn normalize_repo_url(raw: &str) -> Result<String, Box<dyn Error>> {
    let clean = raw
        .trim()
        .strip_prefix("https://")
        .ok_or("Repository URL must be an HTTPS GitHub URL (https://github.com/owner/repo)")?
        .strip_suffix(".git")
        .unwrap_or(raw.trim().strip_prefix("https://").expect("validated prefix"))
        .trim_end_matches('/');
    let mut parts = clean.split('/');
    if parts.next() != Some("github.com")
        || parts.next().filter(|part| !part.is_empty()).is_none()
        || parts.next().filter(|part| !part.is_empty()).is_none()
        || parts.next().is_some()
    {
        return Err("Invalid repository URL: expected https://github.com/owner/repo".into());
    }
    Ok(format!("https://{clean}"))
}

fn error_result(reason: &str, _detail: Option<&str>, repo: &str) -> Result<u8, Box<dyn Error>> {
    let result = ConnectResult {
        state: "action-required".into(),
        repo: repo.into(),
        reason: Some(reason.into()),
        action_url: None,
        org: None,
        scan_id: None,
        schedule_id: None,
        test_command: None,
        scan_url: None,
    };
    serde_json::to_writer(std::io::stdout(), &result)?;
    println!();
    Ok(1)
}