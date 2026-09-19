use serde_json::json;
use sha2::{Digest, Sha256};
use zero_protocol::{
    model::{Completion, CompletionStatus, Content, Usage},
    session::OperationStatus,
};
use zero_store::{PythonHoldoutClaim, Store};
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
struct Fixture {
    dir: tempfile::TempDir,
    store: Store,
    session: String,
}
impl Fixture {
    fn new(limit: u64) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("state.sqlite")).unwrap();
        store.claim_engine_epoch("owner").unwrap();
        let session = store.create_session("host", limit).unwrap().id;
        Self {
            dir,
            store,
            session,
        }
    }
    fn proposal(&mut self, command: &str, final_usage: bool, settle: bool) -> PythonHoldoutClaim {
        let source = "print('candidate')\n";
        let request = json!({"model":"fixture","input":[],"instructions":"frozen host intent","tools":[{"name":"submit_python_candidate"}],"max_output_tokens":128});
        let payload = json!({"kind":"responses_inference","provider":"fixture","request":request,"rates":{"input":1000000,"cached_input":1000000,"output":1000000},"reservation":1});
        let op = self
            .store
            .admit_command(&self.session, command, &payload)
            .unwrap()
            .operation;
        self.store.begin_operation(&op.id, "owner").unwrap();
        self.store.reserve_budget(&self.session, &op.id, 1).unwrap();
        let completion = Completion {
            status: CompletionStatus::Completed,
            response_id: None,
            content: vec![Content::ToolCall {
                id: "call".into(),
                name: "submit_python_candidate".into(),
                arguments: json!({"action":"propose","source_utf8":source,"rationale":"fixture"}),
            }],
            usage: Some(Usage {
                input_tokens: 1,
                output_tokens: 1,
                cached_input_tokens: 0,
            }),
            usage_is_final: final_usage,
            replay: vec![],
            error: None,
        };
        if settle {
            self.store.settle_budget(&self.session, &op.id, 2).unwrap();
        }
        self.store
            .settle_operation(
                &op.id,
                "owner",
                OperationStatus::Succeeded,
                &serde_json::to_value(completion).unwrap(),
            )
            .unwrap();
        PythonHoldoutClaim {
            session_id: self.session.clone(),
            command_id: command.into(),
            operation_id: op.id,
            request_sha256: hash(&serde_json::to_vec(&request).unwrap()),
            intent_sha256: hash(b"intent"),
            suite_sha256: hash(b"private inputs and oracle"),
            candidate_sha256: hash(b"generation"),
            source_sha256: hash(source.as_bytes()),
        }
    }
}
#[test]
fn exact_retry_is_inert_and_changed_selection_cannot_reexpose_suite() {
    let mut f = Fixture::new(100);
    let claim = f.proposal("proposal", true, true);
    let receipt = f.store.claim_python_holdout("owner", &claim).unwrap();
    assert_eq!(receipt.receipt().proposal_charge, 2);
    assert_eq!(
        f.store
            .claim_python_holdout("owner", &claim)
            .unwrap()
            .receipt(),
        receipt.receipt()
    );
    for field in [
        "candidate",
        "suite",
        "intent",
        "source",
        "request",
        "command",
    ] {
        let mut altered = claim.clone();
        match field {
            "candidate" => altered.candidate_sha256 = hash(b"new"),
            "suite" => altered.suite_sha256 = hash(b"new"),
            "intent" => altered.intent_sha256 = hash(b"new"),
            "source" => altered.source_sha256 = hash(b"new"),
            "request" => altered.request_sha256 = hash(b"new"),
            _ => altered.command_id = "other".into(),
        };
        assert!(
            f.store.claim_python_holdout("owner", &altered).is_err(),
            "{field}"
        );
    }
    let second = f.proposal("second", true, true);
    assert!(f.store.claim_python_holdout("owner", &second).is_err());
    assert!(f.store.claim_python_holdout("stale-owner", &claim).is_err());
    assert_eq!(
        f.store.verify_python_holdout(&claim).unwrap().receipt(),
        receipt.receipt()
    );
}
#[test]
fn missing_final_usage_unsettled_charge_and_over_budget_cannot_authorize_execution() {
    for (final_usage, settled, limit) in [(false, true, 100), (true, false, 100), (true, true, 1)] {
        let mut f = Fixture::new(limit);
        let claim = f.proposal("proposal", final_usage, settled);
        assert!(f.store.claim_python_holdout("owner", &claim).is_err());
        assert!(
            !f.store
                .events(&f.session, 0, 100)
                .unwrap()
                .iter()
                .any(|e| e.kind == "python_holdout_exposed")
        );
    }
}
#[test]
fn deleted_event_or_corrupt_receipt_cannot_refresh_exposure() {
    for mutation in ["event", "receipt", "marker"] {
        let mut f = Fixture::new(100);
        let claim = f.proposal("proposal", true, true);
        let receipt = f.store.claim_python_holdout("owner", &claim).unwrap();
        let conn = rusqlite::Connection::open(f.dir.path().join("state.sqlite")).unwrap();
        match mutation {
            "event" => {
                conn.execute("DELETE FROM events WHERE kind='python_holdout_exposed'", [])
                    .unwrap();
            }
            "receipt" => {
                conn.execute(
                    "UPDATE artifacts SET bytes=x'00' WHERE digest=?1",
                    [&receipt.receipt().receipt_sha256],
                )
                .unwrap();
            }
            _ => {
                let marker=serde_json::to_vec(&json!({"schema_version":1,"kind":"python_holdout_consumed","suite_sha256":claim.suite_sha256})).unwrap();
                conn.execute("DELETE FROM artifacts WHERE digest=?1", [hash(&marker)])
                    .unwrap();
            }
        }
        assert!(f.store.verify_python_holdout(&claim).is_err(), "{mutation}");
        assert!(
            f.store.claim_python_holdout("owner", &claim).is_err(),
            "{mutation}"
        );
    }
}
#[test]
fn concurrent_distinct_proposals_consume_one_suite() {
    let mut f = Fixture::new(100);
    let a = f.proposal("a", true, true);
    let b = f.proposal("b", true, true);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mut joins = vec![];
    for claim in [a, b] {
        let path = f.dir.path().join("state.sqlite");
        let barrier = barrier.clone();
        joins.push(std::thread::spawn(move || {
            let mut store = Store::open(path).unwrap();
            barrier.wait();
            store.claim_python_holdout("owner", &claim).is_ok()
        }));
    }
    assert_eq!(
        joins
            .into_iter()
            .filter_map(|j| j.join().unwrap().then_some(()))
            .count(),
        1
    );
}

#[test]
fn missing_admission_settlement_or_accounting_witness_cannot_authorize_execution() {
    for kind in ["command_admitted", "operation_settled", "budget_settled"] {
        let mut f = Fixture::new(100);
        let claim = f.proposal("proposal", true, true);
        let conn = rusqlite::Connection::open(f.dir.path().join("state.sqlite")).unwrap();
        conn.execute("DELETE FROM events WHERE kind=?1", [kind])
            .unwrap();
        assert!(
            f.store.claim_python_holdout("owner", &claim).is_err(),
            "{kind}"
        );
    }
}
