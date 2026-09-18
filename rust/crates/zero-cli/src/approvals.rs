//! Exact-invocation permission receipts; no tool-wide grants.
use clap::Subcommand;
use std::{error::Error, path::Path};
use zero_protocol::approvals::ToolApprovalDecision;
#[derive(Debug, Subcommand)]
pub enum ApprovalsCommand {
    /// Read exact tool approval receipts; approval is not proof of execution.
    List {
        #[arg(long)]
        session: String,
        #[arg(long)]
        root: Option<String>,
        #[arg(long, default_value_t = 0)]
        after_sequence: u64,
        #[arg(long,default_value_t=50,value_parser=clap::value_parser!(u32).range(1..=100))]
        limit: u32,
    },
    Show {
        #[arg(long)]
        session: String,
        #[arg(long)]
        approval: String,
        /// Include the complete hash-checked invocation intent, not just its preview.
        #[arg(long)]
        full_intent: bool,
    },
}
pub async fn run(path: &Path, command: ApprovalsCommand) -> Result<bool, Box<dyn Error>> {
    let path = path.to_owned();
    let task = tokio::task::spawn_blocking(move || match command {
        ApprovalsCommand::List {
            session,
            root,
            after_sequence,
            limit,
        } => zero_engine::read_tool_approvals(
            &path,
            &session,
            root.as_deref(),
            after_sequence,
            limit,
        )
        .map(|approvals| serde_json::json!({"type":"tool_approvals","approvals":approvals})),
        ApprovalsCommand::Show {
            session,
            approval,
            full_intent,
        } => {
            let record = zero_engine::read_tool_approval(&path, &session, &approval)?;
            if full_intent {
                let intent = zero_engine::read_tool_approval_intent(&path, &session, &approval)?;
                Ok(serde_json::json!({"type":"tool_approval","approval":record,"intent":intent}))
            } else {
                Ok(serde_json::json!({"type":"tool_approval","approval":record}))
            }
        }
    });
    let reply = tokio::select! {result=tokio::time::timeout(std::time::Duration::from_secs(5),task)=>result.map_err(|_|"Approval read deadline exceeded")???,_=crate::server::shutdown_signal()=>return Err("Approval read interrupted".into())};
    crate::write_json(&reply, false).await?;
    Ok(true)
}

/// Both identity and exact retained digest must be explicitly supplied by the operator.
pub fn console_decision(
    line: &str,
) -> Result<(String, String, ToolApprovalDecision), &'static str> {
    let parts = line.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 3
        || parts[1].len() > 4096
        || parts[2].len() != 71
        || !parts[2].starts_with("sha256:")
        || !parts[2]
            .strip_prefix("sha256:")
            .unwrap_or("")
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(
            "Use /approve APPROVAL_ID INTENT_SHA256 or /deny APPROVAL_ID INTENT_SHA256; inspect the exact intent first",
        );
    }
    let decision = match parts[0] {
        "/approve" => ToolApprovalDecision::Approve,
        "/deny" => ToolApprovalDecision::Deny,
        _ => return Err("Approval requires an explicit /approve or /deny command"),
    };
    Ok((parts[1].into(), parts[2].into(), decision))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permission_parser_requires_exact_explicit_digest_and_no_default_choice() {
        let hash = format!("sha256:{}", "a".repeat(64));
        for prefix in ["/approve", "/deny"] {
            assert!(console_decision(&format!("{prefix} id {hash}")).is_ok());
            assert!(console_decision(&format!("{prefix} id")).is_err());
            assert!(console_decision(&format!("{prefix} id {hash} extra")).is_err());
        }
        for prefix in ["yes", "/answer", "/dismiss", "approve"] {
            assert!(console_decision(&format!("{prefix} id {hash}")).is_err());
        }
        assert!(console_decision(&format!("/approve id {}", "a".repeat(64))).is_err());
    }
}
