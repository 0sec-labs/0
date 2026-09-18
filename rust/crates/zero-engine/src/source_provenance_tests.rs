#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs};
use zero_protocol::{
    model::{Completion, CompletionStatus, Content},
    source::ReviewRequest,
};

struct Fixture {
    _dir: tempfile::TempDir,
    db: std::path::PathBuf,
    source: std::path::PathBuf,
    store: Store,
    session: String,
    parent: String,
    child: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("a.js"), "return input;\n").unwrap();
        let request = SourceReviewRequest {
            provider: "local".into(),
            model: "fixture".into(),
            reservation: 5,
            source: ReviewRequest {
                snapshot: zero_executor::pin_snapshot(&source).unwrap(),
                selected_files: vec!["a.js".into()],
                question: "Assess input trust".into(),
                max_hypotheses: 2,
            },
        };
        let prepared = zero_source::prepare(&request.source)
            .unwrap()
            .request(&request.model)
            .unwrap();
        // Missing final usage is valid evidence, and does not authorize release of a billing hold.
        let completion = Completion {
            status: CompletionStatus::Completed,
            response_id: Some("response".into()),
            content: vec![Content::ToolCall {
                id: "submit".into(),
                name: "submit_source_hypotheses".into(),
                arguments: json!({"hypotheses":[{"title":"Input claim","claimed_severity":"low","explanation":"Unverified return of input","citations":[{"path":"a.js","sha256":prepared.bundle().files()[0].sha256(),"start_line":1,"end_line":1}]}]}),
            }],
            usage: None,
            usage_is_final: false,
            replay: vec![],
            error: None,
        };
        let review = prepared.accept(&completion).unwrap();
        let db = dir.path().join("state.db");
        let mut store = Store::open(&db).unwrap();
        let session = store.create_session("fixture", 10).unwrap().id;
        let parent_payload = json!({"kind":"source_hypothesis_review","request":request,"endpoint":"http://127.0.0.1/fixture","wire_api":"responses","rates":{"input":1,"cached_input":1,"output":1}});
        let parent = store
            .admit_command(&session, "review", &parent_payload)
            .unwrap()
            .operation
            .id;
        store.begin_operation(&parent, "owner").unwrap();
        let mut artifacts = BTreeMap::new();
        for (name, bytes) in [
            ("source.bundle", prepared.bundle().to_bytes().unwrap()),
            ("source.request", prepared.request_bytes().unwrap()),
            (
                "source.completion",
                serde_json::to_vec(&completion).unwrap(),
            ),
            (
                "source.review",
                zero_source::review_result_bytes(&review).unwrap(),
            ),
        ] {
            artifacts.insert(
                name.to_string(),
                store
                    .retain_operation_artifact(&parent, "owner", name, &bytes)
                    .unwrap(),
            );
        }
        let child_payload = json!({"parent_operation":parent,"kind":"source_review_inference","request_artifact":artifacts["source.request"],"endpoint":parent_payload["endpoint"],"wire_api":parent_payload["wire_api"],"rates":parent_payload["rates"]});
        let child = store
            .admit_command(&session, &format!("{parent}:model:0"), &child_payload)
            .unwrap()
            .operation
            .id;
        store.begin_operation(&child, "owner").unwrap();
        store.reserve_budget(&session, &child, 5).unwrap();
        store.settle_operation(&child,"owner",OperationStatus::Succeeded,&json!({"completion_artifact":artifacts["source.completion"],"usage":null,"usage_is_final":false})).unwrap();
        store
            .settle_operation(
                &parent,
                "owner",
                OperationStatus::Succeeded,
                &json!(SourceReviewOutcome {
                    review: Some(review),
                    artifacts,
                    inference_operation: Some(child.clone()),
                    external_effects_started: true,
                    error: None,
                }),
            )
            .unwrap();
        Self {
            _dir: dir,
            db,
            source,
            store,
            session,
            parent,
            child,
        }
    }
    fn mutate(&self, id: &str, column: &str, f: impl FnOnce(&mut Value)) {
        assert!(matches!(column, "payload" | "outcome"));
        let conn = rusqlite::Connection::open(&self.db).unwrap();
        let sql = format!("SELECT {column} FROM operations WHERE id=?1");
        let raw: String = conn.query_row(&sql, [id], |r| r.get(0)).unwrap();
        let mut value: Value = serde_json::from_str(&raw).unwrap();
        f(&mut value);
        conn.execute(
            &format!("UPDATE operations SET {column}=?1 WHERE id=?2"),
            rusqlite::params![value.to_string(), id],
        )
        .unwrap();
    }
    fn reject(&self) {
        assert!(load(&self.store, &self.session, &self.parent).is_err());
    }
    fn replace_artifact(&self, name: &str, value: &Value) {
        let bytes = serde_json::to_vec(value).unwrap();
        self.replace_artifact_bytes(name, value, bytes);
    }
    fn replace_artifact_bytes(&self, name: &str, value: &Value, bytes: Vec<u8>) {
        let digest = format!("sha256:{}", zero_plugin::sha256(&bytes));
        let conn = rusqlite::Connection::open(&self.db).unwrap();
        conn.execute(
            "INSERT INTO artifacts(digest,bytes) VALUES(?1,?2)",
            rusqlite::params![digest, bytes],
        )
        .unwrap();
        conn.execute(
            "UPDATE operation_artifacts SET digest=?1 WHERE operation_id=?2 AND name=?3",
            rusqlite::params![digest, self.parent, name],
        )
        .unwrap();
        self.mutate(&self.parent, "outcome", |v| {
            v["artifacts"][name] = json!(digest)
        });
        match name {
            "source.request" => self.mutate(&self.child, "payload", |v| {
                v["request_artifact"] = json!(digest)
            }),
            "source.completion" => self.mutate(&self.child, "outcome", |v| {
                v["completion_artifact"] = json!(digest)
            }),
            "source.review" => {
                self.mutate(&self.parent, "outcome", |v| v["review"] = value.clone())
            }
            _ => (),
        }
    }
}
#[test]
fn equivalent_json_bytes_cannot_change_the_submission_artifact_identity() {
    for name in ["source.request", "source.completion"] {
        let f = Fixture::new();
        let digest = f.store.operation_artifacts(&f.parent).unwrap()[name].clone();
        let value: Value = serde_json::from_slice(&f.store.artifact(&digest).unwrap()).unwrap();
        f.replace_artifact_bytes(name, &value, serde_json::to_vec_pretty(&value).unwrap());
        f.reject();
    }
}
#[test]
fn genuine_dedicated_evidence_survives_source_deletion_and_keeps_billing_hold() {
    let f = Fixture::new();
    fs::remove_dir_all(&f.source).unwrap();
    assert!(load(&f.store, &f.session, &f.parent).is_ok());
    let reopened = Store::open_read_only(&f.db).unwrap();
    assert!(load(&reopened, &f.session, &f.parent).is_ok());
    assert_eq!(f.store.budget(&f.session).unwrap().reserved, 5);
}
#[test]
fn dedicated_child_and_parent_authority_mutations_are_rejected() {
    for (column, key, value) in [
        ("payload", "parent_operation", json!("other")),
        ("payload", "kind", json!("agent_inference")),
        ("payload", "request_artifact", json!("sha256:wrong")),
        ("payload", "endpoint", json!("different-provider")),
        ("payload", "wire_api", json!("anthropic")),
        ("payload", "rates", json!({})),
        ("outcome", "completion_artifact", json!("sha256:wrong")),
        ("outcome", "usage", json!({"input_tokens":9})),
        ("outcome", "usage_is_final", json!(true)),
    ] {
        let f = Fixture::new();
        f.mutate(&f.child, column, |v| v[key] = value);
        f.reject();
    }
    for key in ["question", "max_hypotheses", "selected_files"] {
        let f = Fixture::new();
        f.mutate(&f.parent, "payload", |v| {
            v["request"]["source"][key] = match key {
                "question" => json!("Different task"),
                "max_hypotheses" => json!(3),
                _ => json!(["a.js", "a.js"]),
            }
        });
        f.reject();
    }
    let f = Fixture::new();
    rusqlite::Connection::open(&f.db)
        .unwrap()
        .execute(
            "UPDATE operations SET status='unknown' WHERE id=?1",
            [&f.child],
        )
        .unwrap();
    f.reject();
}
#[test]
fn missing_or_corrupt_request_and_completion_cannot_use_old_summary() {
    for name in ["source.request", "source.completion"] {
        let f = Fixture::new();
        let conn = rusqlite::Connection::open(&f.db).unwrap();
        conn.execute(
            "DELETE FROM operation_artifacts WHERE operation_id=?1 AND name=?2",
            rusqlite::params![f.parent, name],
        )
        .unwrap();
        f.reject();
        let f = Fixture::new();
        let digest = f.store.operation_artifacts(&f.parent).unwrap()[name].clone();
        rusqlite::Connection::open(&f.db)
            .unwrap()
            .execute(
                "UPDATE artifacts SET bytes=?1 WHERE digest=?2",
                rusqlite::params![b"{}".as_slice(), digest],
            )
            .unwrap();
        f.reject();
    }
}
#[test]
fn consistent_hashes_do_not_replace_request_completion_or_claim_validation() {
    for name in ["source.request", "source.completion", "source.review"] {
        let f = Fixture::new();
        let digest = f.store.operation_artifacts(&f.parent).unwrap()[name].clone();
        let mut value: Value = serde_json::from_slice(&f.store.artifact(&digest).unwrap()).unwrap();
        match name {
            "source.request" => value["instructions"] = json!("Forged instructions"),
            "source.completion" => {
                value["content"][0]["arguments"]["hypotheses"][0]["citations"][0]["end_line"] =
                    json!(99)
            }
            "source.review" => value["hypotheses"][0]["claim"]["title"] = json!("Forged title"),
            _ => unreachable!(),
        }
        f.replace_artifact(name, &value);
        f.reject();
    }
}

#[test]
fn succeeded_source_outcome_cannot_hide_a_retained_error() {
    let f = Fixture::new();
    f.mutate(&f.parent, "outcome", |v| {
        v["error"] = json!("retained failure")
    });
    f.reject();
}
