#![allow(clippy::unwrap_used)]
use serde_json::json;
use sha2::{Digest, Sha256};
use zero_protocol::{
    OperationStatus,
    agent::AgentStatus,
    managed_scan::*,
    scan::*,
    source::{SecurityConclusion, VerificationState},
    web::*,
};
pub fn hash(v: &impl serde::Serialize) -> String {
    format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(v).unwrap())
    )
}
pub fn canonical(v: &impl serde::Serialize) -> String {
    hash(&serde_json::to_value(v).unwrap())
}
pub fn id(n: u32) -> String {
    format!("12345678-1234-4234-8234-{n:012x}")
}
pub fn fixture() -> (ManagedScanGrant, ScanSnapshot, ScanReport) {
    let profile:ScanProfile=serde_json::from_value(json!({"schema_version":1,"kind":"scoped_http","provider":"fixture","model":"model","instructions":"Investigate the authorized target.","http_profile":"target","budget_limit":100,"currency":"usd","reservation_per_turn":10,"max_turns":4,"max_hypotheses":4,"deadline_ms":1000})).unwrap();
    let policy=serde_json::from_value(json!({"schema_version":1,"base_url":"https://example.test/","in_scope":["example.test"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":[],"denied_path_prefixes":[],"allowed_methods":["GET"],"allowed_headers":[],"limits":{"timeout_ms":1000,"max_request_body_bytes":1000,"max_response_wire_bytes":4096,"max_response_decoded_bytes":4096,"max_request_header_bytes":4096,"max_request_headers":16,"max_response_header_bytes":4096,"max_response_headers":16,"max_dns_answers":8,"max_dns_cname_depth":4,"max_dns_queries":8},"rate":{"default":{"requests_per_interval":10,"interval_ms":1000,"burst":10},"per_host":{},"jitter_ms":0},"budget":{"max_requests":10,"max_request_body_bytes":10000,"max_response_decoded_bytes":40960}})).unwrap();
    let grant=ManagedScanGrant{contract_version:MANAGED_SCAN_CONTRACT.into(),cloud_scan_id:id(1),organization_id:id(2),dispatch_id:id(3),grant_revision:"host-policy-r1".into(),expires_at_ms:10000,target:"https://example.test/".into(),scan_profile_name:"managed".into(),scan_profile:profile,http_policy:policy,providers:serde_json::from_value(json!({"fixture":{"endpoint":"https://provider.test/responses","wire_api":"responses","rates":{"input":1000000,"cached_input":1000000,"output":1000000}}})).unwrap()};
    let profile_sha = canonical(&grant.http_policy);
    let scan_id = id(4);
    let session_id = id(5);
    let controller = id(6);
    let root = id(7);
    let scan = ScanRecord {
        schema_version: 1,
        id: scan_id.clone(),
        command_id: grant.command_id(),
        session_id: session_id.clone(),
        controller_operation_id: controller,
        root_operation_id: root.clone(),
        input_target: grant.target.clone(),
        target: grant.target.clone(),
        profile_name: grant.scan_profile_name.clone(),
        intent_sha256: format!("sha256:{}", "a".repeat(64)),
        profile_sha256: canonical(&grant.scan_profile),
        http_account_id: canonical(
            &json!({"session_id":session_id,"original_root_command":format!("scan:{scan_id}:root"),"profile_sha256":profile_sha}),
        ),
        created_at_ms: 1000,
        deadline_at_ms: 2000,
        sequence: 1,
    };
    let review:WebReviewResult=serde_json::from_value(json!({"schema_version":1,"request_sha256":format!("sha256:{}","b".repeat(64)),"completion_sha256":format!("sha256:{}","c".repeat(64)),"submission_call_id":"submit","model":"model","provider_response_id":null,"hypotheses":[],"evidence":[]})).unwrap();
    let outcome = ScanOutcome {
        schema_version: 1,
        scan_id: scan.id.clone(),
        root_status: OperationStatus::Succeeded,
        agent_status: Some(AgentStatus::Completed),
        stop_reason: ScanStopReason::Submitted,
        close_reason: None,
        http_usage: ScanHttpUsage::default(),
        completeness: ScanCompleteness::CompletedWorkflow,
        started_at_ms: 1000,
        completed_at_ms: 1500,
        review_sha256: Some(hash(&review)),
        budget: zero_protocol::BudgetSnapshot {
            limit: 100,
            charged: 3,
            reserved: 0,
        },
        currency: ScanCurrency::Usd,
        summary: ScanClaimSummary::default(),
        security_conclusion: SecurityConclusion::NotEstablished,
        vulnerability_reportable: false,
        error_code: None,
    };
    let web = WebWorkflowReport {
        schema_version: 1,
        report_kind: WebReportKind::WebObservations,
        verification_state: VerificationState::Unverified,
        security_conclusion: SecurityConclusion::NotEstablished,
        run: WebRun {
            session_id: scan.session_id.clone(),
            operation_id: root,
            command_id: format!("scan:{scan_id}:root"),
            operation_status: OperationStatus::Succeeded,
            agent_status: Some(AgentStatus::Completed),
            error: None,
            authority: WebHttpAuthority {
                profile_name: "target".into(),
                profile_sha256: profile_sha,
                account_id: scan.http_account_id.clone(),
                profile: grant.http_policy.clone(),
            },
            review: Some(review),
            artifacts: [("web.review".into(), outcome.review_sha256.clone().unwrap())]
                .into_iter()
                .collect(),
        },
        observations: vec![],
        observations_truncated: false,
        verifications: vec![],
        experiments: vec![],
    };
    let report = ScanReport {
        schema_version: 1,
        kind: ScanReportKind::Retained,
        scan: scan.clone(),
        outcome: outcome.clone(),
        web: Some(web),
        observations_next_after_sequence: None,
    };
    let snapshot = ScanSnapshot {
        scan,
        controller_status: OperationStatus::Succeeded,
        root_status: OperationStatus::Succeeded,
        phase: ScanPhase::Terminal,
        close_reason: None,
        budget: outcome.budget.clone(),
        http_usage: outcome.http_usage.clone(),
        currency: outcome.currency,
        result: Some(ScanResult {
            outcome,
            publication: ScanPublication::Retained {
                report_sha256: hash(&report),
            },
        }),
        observed_sequence: 12,
        observed_at_ms: 2000,
    };
    (grant, snapshot, report)
}
