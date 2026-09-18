#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::PermissionsExt};
use zero_protocol::model::{
    Completion, CompletionStatus, Content, ResponsesRequest, ToolDefinition,
};
use zero_source::{
    PreparedReview, PreparedSubmission, SnapshotInvestigation, SourceBundle, VerificationState,
    adaptive_submission_tool, submission_tool,
};
fn view(files: &[(&str, &[u8])]) -> (tempfile::TempDir, SnapshotInvestigation) {
    let dir = tempfile::tempdir().unwrap();
    for (path, bytes) in files {
        fs::write(dir.path().join(path), bytes).unwrap();
    }
    let pin = zero_executor::pin_snapshot(dir.path()).unwrap();
    let view = SnapshotInvestigation::prepare(&pin).unwrap();
    (dir, view)
}
fn request(max: u32) -> ResponsesRequest {
    ResponsesRequest {
        model: "actual-model".into(),
        instructions: "actual host instructions".into(),
        input: vec![
            json!({"role":"user","content":"investigate"}),
            json!({"type":"reasoning","encrypted_content":"opaque-retained-reasoning"}),
            json!({"type":"function_call","call_id":"prior","name":"read_source_lines","arguments":"{}"}),
            json!({"type":"function_call_output","call_id":"prior","output":"retained source"}),
        ],
        tools: vec![
            adaptive_submission_tool(max).unwrap(),
            ToolDefinition {
                name: "read_source_lines".into(),
                description: "read".into(),
                parameters: json!({"type":"object"}),
            },
        ],
        max_output_tokens: 8192,
    }
}
fn completion(args: Value) -> Completion {
    Completion {
        status: CompletionStatus::Completed,
        response_id: Some("actual-response".into()),
        content: vec![Content::ToolCall {
            id: "final-submission".into(),
            name: "submit_source_hypotheses".into(),
            arguments: args,
        }],
        usage: None,
        usage_is_final: false,
        replay: vec![json!({"opaque":"original-replay"})],
        error: None,
    }
}
fn claim(bundle: &SourceBundle) -> Value {
    json!({"title":"Unverified fixture","claimed_severity":"low","explanation":"Proposed observation only","citations":[{"path":"a.js","sha256":bundle.files()[0].sha256(),"start_line":1,"end_line":1}]})
}
fn hash(value: &impl serde::Serialize) -> String {
    format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value).unwrap())
    )
}
#[test]
fn adaptive_selection_uses_private_bytes_and_hashes_actual_request_and_original_completion() {
    let (dir, view) = view(&[("a.js", b"original\r\nsecond\n"), ("b.js", b"other\n")]);
    fs::remove_file(dir.path().join("a.js")).unwrap();
    fs::write(dir.path().join("b.js"), "changed host").unwrap();
    let bundle = view
        .selected_bundle(&["b.js".into(), "a.js".into()], "actual question", 2)
        .unwrap();
    assert_eq!(bundle.files()[0].text(), "original\r\nsecond\n");
    assert_eq!(bundle.files()[1].text(), "other\n");
    let portable = SourceBundle::from_bytes(&bundle.to_bytes().unwrap()).unwrap();
    assert_eq!(portable.digest(), bundle.digest());
    let actual = request(2);
    let prepared = PreparedSubmission::for_request(bundle.clone(), actual.clone()).unwrap();
    assert_eq!(prepared.request_digest(), hash(&actual));
    assert_eq!(
        prepared.request_bytes().unwrap(),
        serde_json::to_vec(&actual).unwrap()
    );
    let response =
        completion(json!({"selected_files":["b.js","a.js"],"hypotheses":[claim(&bundle)]}));
    let result = prepared.accept_adaptive(&response).unwrap();
    assert_eq!(result.request_sha256, hash(&actual));
    assert_eq!(result.completion_sha256, hash(&response));
    assert_eq!(result.model, "actual-model");
    assert_eq!(result.hypotheses[0].state, VerificationState::Unverified);
    assert!(prepared.accept(&response).is_err());
    view.cleanup().unwrap();
}
#[test]
fn selected_bundle_rejects_private_tamper_duplicates_paths_and_size_bounds() {
    let large = vec![b'x'; 128 * 1024 + 1];
    let (dir, view) = view(&[
        ("a.js", b"original"),
        ("binary", b"\xff"),
        ("nul", b"a\0b"),
        ("large", &large),
    ]);
    for selected in [
        vec!["a.js".into(), "a.js".into()],
        vec!["../a.js".into()],
        vec!["./a.js".into()],
        vec!["missing".into()],
        vec!["binary".into()],
        vec!["nul".into()],
        vec!["large".into()],
        vec!["a.js".into(); 33],
    ] {
        assert!(view.selected_bundle(&selected, "question", 2).is_err());
    }
    assert!(view.selected_bundle(&[], "", 2).is_err());
    assert!(view.selected_bundle(&[], "q", 0).is_err());
    assert!(view.selected_bundle(&[], "q", 33).is_err());
    let private = view.root().join("source/a.js");
    fs::set_permissions(&private, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(private, b"tampered").unwrap();
    assert!(
        view.selected_bundle(&["a.js".into()], "question", 2)
            .is_err()
    );
    assert_eq!(fs::read(dir.path().join("a.js")).unwrap(), b"original");
    view.cleanup().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let names: Vec<_> = (0..5).map(|i| format!("f{i}")).collect();
    for n in &names {
        fs::write(dir.path().join(n), vec![b'x'; 128 * 1024]).unwrap();
    }
    let view =
        SnapshotInvestigation::prepare(&zero_executor::pin_snapshot(dir.path()).unwrap()).unwrap();
    assert!(view.selected_bundle(&names, "q", 1).is_err());
    view.cleanup().unwrap();
}
#[test]
fn adaptive_selection_and_citations_cannot_be_forged_or_mixed_with_tools() {
    let (_dir, view) = view(&[("a.js", b"original\n"), ("b.js", b"unselected\n")]);
    let bundle = view.selected_bundle(&["a.js".into()], "q", 1).unwrap();
    let prepared = PreparedSubmission::for_request(bundle.clone(), request(1)).unwrap();
    for mutation in 0..6 {
        let mut args = json!({"selected_files":["a.js"],"hypotheses":[claim(&bundle)]});
        match mutation {
            0 => args["selected_files"] = json!(["b.js"]),
            1 => args["selected_files"] = json!(["a.js", "a.js"]),
            2 => {
                args["hypotheses"][0]["citations"][0]["sha256"] =
                    json!(format!("sha256:{}", "0".repeat(64)))
            }
            3 => args["hypotheses"][0]["citations"][0]["end_line"] = json!(2),
            4 => args["hypotheses"][0]["citations"][0]["path"] = json!("b.js"),
            _ => args["unexpected"] = json!(true),
        };
        assert!(prepared.accept_adaptive(&completion(args)).is_err());
    }
    let mut mixed = completion(json!({"selected_files":["a.js"],"hypotheses":[]}));
    mixed.content.push(Content::ToolCall {
        id: "other".into(),
        name: "read_source_lines".into(),
        arguments: json!({}),
    });
    assert!(prepared.accept_adaptive(&mixed).is_err());
    let mut wrong = request(2);
    assert!(PreparedSubmission::for_request(bundle.clone(), wrong.clone()).is_err());
    wrong = request(1);
    wrong.tools.push(adaptive_submission_tool(1).unwrap());
    assert!(PreparedSubmission::for_request(bundle.clone(), wrong).is_err());
    let mut oversized = request(1);
    oversized.instructions = "x".repeat(4 * 1024 * 1024);
    assert!(PreparedSubmission::for_request(bundle, oversized).is_err());
    view.cleanup().unwrap();
}
#[test]
fn empty_adaptive_bundle_is_explicit_version_two_and_accepts_no_claims_only() {
    let (_dir, view) = view(&[("binary", b"\xff\0")]);
    let bundle = view
        .selected_bundle(&[], "no hypotheses proposed", 2)
        .unwrap();
    let raw: Value = serde_json::from_slice(&bundle.to_bytes().unwrap()).unwrap();
    assert_eq!(raw["version"], 2);
    assert!(bundle.files().is_empty());
    let bundle = SourceBundle::from_bytes(&bundle.to_bytes().unwrap()).unwrap();
    let mut legacy = raw;
    legacy["version"] = json!(1);
    assert!(SourceBundle::from_bytes(&serde_json::to_vec(&legacy).unwrap()).is_err());
    assert!(
        PreparedReview::from_bundle(bundle.clone())
            .request("model")
            .is_err()
    );
    let prepared = PreparedSubmission::for_request(bundle.clone(), request(2)).unwrap();
    let response = completion(json!({"selected_files":[],"hypotheses":[]}));
    assert!(
        prepared
            .accept_adaptive(&response)
            .unwrap()
            .hypotheses
            .is_empty()
    );
    let invented = json!({"title":"invented","claimed_severity":"low","explanation":"none","citations":[{"path":"binary","sha256":format!("sha256:{}","0".repeat(64)),"start_line":1,"end_line":1}]});
    assert!(
        prepared
            .accept_adaptive(&completion(
                json!({"selected_files":[],"hypotheses":[invented]})
            ))
            .is_err()
    );
    assert!(submission_tool(0).is_err());
    assert!(adaptive_submission_tool(33).is_err());
    view.cleanup().unwrap();
}
