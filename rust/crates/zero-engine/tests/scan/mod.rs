#![allow(dead_code)]
#[path = "../web/mod.rs"]
mod web;
pub use web::*;
use zero_protocol::{Command, Reply, scan::*};
pub fn profile() -> ScanProfile {
    ScanProfile {
        schema_version: 1,
        kind: ScanKind::ScopedHttp,
        provider: "fixture".into(),
        model: "fixture-model".into(),
        instructions: "Investigate only within captured scope, and submit supported hypotheses."
            .into(),
        http_profile: "target".into(),
        budget_limit: 100,
        currency: ScanCurrency::Units,
        reservation_per_turn: 10,
        max_turns: 4,
        max_hypotheses: 4,
        deadline_ms: 10000,
        context_policy: None,
        delegation_policy: None,
        web_experiment_policy: None,
    }
}
pub fn command(target: &str) -> Command {
    Command::RunScan {
        command_id: "scan-command".into(),
        target: target.into(),
        profile: "web".into(),
    }
}
pub fn snapshot(reply: Reply) -> (ScanSnapshot, bool) {
    match reply {
        Reply::ScanRun { scan, duplicate } => (scan, duplicate),
        other => panic!("{other:?}"),
    }
}
pub fn current(f: &Setup) -> ScanSnapshot {
    let store = zero_store::Store::open_read_only(f.dir.path().join("state.db")).unwrap();
    let scan = store.scan_by_command("scan-command").unwrap().unwrap();
    store.scan_snapshot(&scan.id).unwrap()
}
