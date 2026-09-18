#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::fs;
use zero_protocol::model::{Completion, CompletionStatus, Content};
use zero_source::*;
fn fixture() -> (tempfile::TempDir, ReviewRequest) {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("app.js"), "const x = 1;\nreturn x;\n").unwrap();
    fs::write(dir.path().join("unselected.txt"), "not sent to model").unwrap();
    let pin = zero_executor::pin_snapshot(dir.path()).unwrap();
    (
        dir,
        ReviewRequest {
            snapshot: pin,
            selected_files: vec!["app.js".into()],
            question: "Find input validation mistakes".into(),
            max_hypotheses: 2,
        },
    )
}
fn claim(bundle: &SourceBundle) -> Value {
    json!({"title":"Possible missing validation","claimed_severity":"high","explanation":"This is only an assessment.","citations":[{"path":"app.js","sha256":bundle.files()[0].sha256(),"start_line":1,"end_line":2}]})
}
fn completion(arguments: Value) -> Completion {
    Completion {
        status: CompletionStatus::Completed,
        response_id: Some("response-1".into()),
        content: vec![Content::ToolCall {
            id: "submission-1".into(),
            name: "submit_source_hypotheses".into(),
            arguments,
        }],
        usage: None,
        usage_is_final: false,
        replay: vec![],
        error: None,
    }
}
#[test]
fn retained_bytes_survive_source_mutation_and_portable_roundtrip() {
    let (dir, request) = fixture();
    let prepared = prepare(&request).unwrap();
    fs::write(dir.path().join("app.js"), "changed").unwrap();
    let bundle = SourceBundle::from_bytes(&prepared.bundle().to_bytes().unwrap()).unwrap();
    assert_eq!(bundle.digest(), prepared.bundle().digest());
    assert_eq!(bundle.files()[0].text(), "const x = 1;\nreturn x;\n");
    let submission = PreparedReview::from_bundle(bundle)
        .request("fixture-model")
        .unwrap();
    assert!(
        !serde_json::to_string(&submission.request().input)
            .unwrap()
            .contains("not sent to model")
    );
    let result = submission
        .accept(&completion(
            json!({"hypotheses":[claim(submission.bundle())]}),
        ))
        .unwrap();
    assert_eq!(result.hypotheses[0].state, VerificationState::Unverified);
    assert_eq!(result.model, "fixture-model");
    assert_eq!(result.provider_response_id.as_deref(), Some("response-1"));
    assert_eq!(result.request_sha256, submission.request_digest());
    assert_eq!(result.bundle_sha256, prepared.bundle().digest());
    assert!(prepare(&request).is_err());
}
#[test]
fn rejects_paths_hash_mismatch_and_symlinks_including_unselected() {
    let (dir, request) = fixture();
    for path in [
        "../app.js",
        "/etc/passwd",
        "a/../app.js",
        "a\\app.js",
        "app.js/",
    ] {
        let mut bad = request.clone();
        bad.selected_files = vec![path.into()];
        assert!(prepare(&bad).is_err());
    }
    let mut bad = request.clone();
    bad.selected_files.push("app.js".into());
    assert!(prepare(&bad).is_err());
    let mut bad = request.clone();
    bad.snapshot.files[0].digest = format!("sha256:{}", "0".repeat(64));
    assert!(prepare(&bad).is_err());
    fs::remove_file(dir.path().join("unselected.txt")).unwrap();
    std::os::unix::fs::symlink("app.js", dir.path().join("unselected.txt")).unwrap();
    assert!(prepare(&request).is_err());
}
#[test]
fn rejects_non_utf8_nul_and_file_selection_limits() {
    let (dir, mut request) = fixture();
    for data in [vec![0xff], vec![0], vec![b'a'; MAX_FILE_BYTES + 1]] {
        fs::write(dir.path().join("app.js"), data).unwrap();
        request.snapshot = zero_executor::pin_snapshot(dir.path()).unwrap();
        assert!(prepare(&request).is_err());
    }
    let (_, mut request) = fixture();
    request.max_hypotheses = 33;
    assert!(prepare(&request).is_err());
    request.max_hypotheses = 1;
    request.question = " ".into();
    assert!(prepare(&request).is_err());
}
#[test]
fn imported_bundle_validates_retained_bytes_manifest_and_unknown_fields() {
    let (_dir, request) = fixture();
    let prepared = prepare(&request).unwrap();
    let data: Value = serde_json::from_slice(&prepared.bundle().to_bytes().unwrap()).unwrap();
    for mutation in 0..4 {
        let mut bad = data.clone();
        match mutation {
            0 => bad["files"][0]["text"] = json!("invented"),
            1 => bad["files"][0]["path"] = json!("../app.js"),
            2 => bad["version"] = json!(2),
            _ => bad["authority"] = json!("trusted"),
        };
        assert!(SourceBundle::from_bytes(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
    assert!(SourceBundle::from_bytes(&vec![b' '; MAX_ARTIFACT_BYTES + 1]).is_err());
}
#[test]
fn citations_are_bound_to_selected_hash_and_real_lines() {
    let (_dir, request) = fixture();
    let submission = prepare(&request).unwrap().request("fixture").unwrap();
    for mutation in 0..6 {
        let mut c = claim(submission.bundle());
        match mutation {
            0 => c["citations"][0]["path"] = json!("unselected.txt"),
            1 => c["citations"][0]["sha256"] = json!(format!("sha256:{}", "0".repeat(64))),
            2 => c["citations"][0]["start_line"] = json!(0),
            3 => c["citations"][0]["end_line"] = json!(3),
            4 => c["claimed_severity"] = json!("verified"),
            _ => c["state"] = json!("reproduced"),
        };
        assert!(
            submission
                .accept(&completion(json!({"hypotheses":[c]})))
                .is_err()
        );
    }
}
#[test]
fn prose_duplicates_other_tools_refusals_and_incomplete_are_never_submissions() {
    let (_dir, request) = fixture();
    let submission = prepare(&request).unwrap().request("fixture").unwrap();
    let valid = completion(json!({"hypotheses":[]}));
    assert!(submission.accept(&valid).unwrap().hypotheses.is_empty());
    for mutation in 0..6 {
        let mut bad = valid.clone();
        match mutation {
            0 => {
                bad.content = vec![Content::Text {
                    text: "Confirmed vulnerability".into(),
                }]
            }
            1 => bad.content.push(bad.content[0].clone()),
            2 => bad.content.push(Content::ToolCall {
                id: "evil".into(),
                name: "exec".into(),
                arguments: json!({}),
            }),
            3 => bad.content.push(Content::Refusal { text: "no".into() }),
            4 => bad.status = CompletionStatus::Incomplete,
            _ => bad.error = Some("error".into()),
        };
        assert!(submission.accept(&bad).is_err());
    }
    let claims = vec![claim(submission.bundle()); 3];
    assert!(
        submission
            .accept(&completion(json!({"hypotheses":claims})))
            .is_err()
    );
}
#[test]
fn line_count_preserves_crlf_and_does_not_invent_trailing_or_empty_lines() {
    let (dir, mut request) = fixture();
    for (text, count) in [("", 0), ("\n", 1), ("a\r\nb", 2), ("a\n", 1)] {
        fs::write(dir.path().join("app.js"), text).unwrap();
        request.snapshot = zero_executor::pin_snapshot(dir.path()).unwrap();
        let prepared = prepare(&request).unwrap();
        assert_eq!(prepared.bundle().files()[0].line_count(), count);
        assert_eq!(prepared.bundle().files()[0].text(), text);
    }
}

#[test]
fn aggregate_text_and_index_limits_reject_before_provider_request() {
    let dir = tempfile::tempdir().unwrap();
    let mut selected = vec![];
    for i in 0..5 {
        let path = format!("file{i}.txt");
        fs::write(dir.path().join(&path), vec![b'x'; MAX_FILE_BYTES]).unwrap();
        selected.push(path);
    }
    let mut request = ReviewRequest {
        snapshot: zero_executor::pin_snapshot(dir.path()).unwrap(),
        selected_files: selected,
        question: "Review".into(),
        max_hypotheses: 1,
    };
    assert!(prepare(&request).is_err());
    request.selected_files.truncate(4);
    assert!(prepare(&request).is_ok());
    request.snapshot.files[0].bytes = 64 * 1024 * 1024 + 1;
    assert!(prepare(&request).is_err());
}
#[test]
fn strict_request_and_claim_schema_rejects_unknown_fields_and_duplicate_citations() {
    let (_dir, request) = fixture();
    let mut raw = serde_json::to_value(&request).unwrap();
    raw["allow_network"] = json!(true);
    assert!(serde_json::from_value::<ReviewRequest>(raw).is_err());
    let submission = prepare(&request).unwrap().request("fixture").unwrap();
    let mut c = claim(submission.bundle());
    let duplicate = c["citations"][0].clone();
    c["citations"].as_array_mut().unwrap().push(duplicate);
    assert!(
        submission
            .accept(&completion(json!({"hypotheses":[c]})))
            .is_err()
    );
    assert!(
        submission
            .accept(&completion(json!({"hypotheses":[],"verified":true})))
            .is_err()
    );
}
