#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used)]
use std::{fs, os::unix::fs::PermissionsExt};
use zero_source::{
    ReviewRequest, SearchMode, SnapshotInvestigation, SourceBundle,
    investigation::{MAX_INVESTIGATION_OUTPUT_BYTES, SourceInvestigation},
    prepare,
};
fn fixture(files: &[(&str, &str)], selected: &[&str]) -> (tempfile::TempDir, SourceBundle) {
    let dir = tempfile::tempdir().unwrap();
    for (path, text) in files {
        let file = dir.path().join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }
    let review = prepare(&ReviewRequest {
        snapshot: zero_executor::pin_snapshot(dir.path()).unwrap(),
        selected_files: selected.iter().map(|p| (*p).into()).collect(),
        question: "Review scoped code".into(),
        max_hypotheses: 2,
    })
    .unwrap();
    (dir, review.bundle().clone())
}
#[test]
fn regex_anchors_casefold_and_scopes_preserve_exact_citations() {
    let (dir, bundle) = fixture(
        &[
            (
                "src/a.rs",
                "let TOKEN = 17;\r\nlet token = 23;\nlet token = x;\n.*\n",
            ),
            ("src2/b.rs", "let token = 99;\n"),
            ("private.rs", "let token = 123;\n"),
        ],
        &["src/a.rs", "src2/b.rs"],
    );
    let retained = SourceInvestigation::new(&bundle);
    let snapshot =
        SnapshotInvestigation::prepare(&zero_executor::pin_snapshot(dir.path()).unwrap()).unwrap();
    let pattern = r"^let token = [0-9]+;$";
    let a = retained
        .search_files_with_options(pattern, Some("./src/"), 200, SearchMode::Regex, false)
        .unwrap();
    let b = snapshot
        .search_files_with_options(pattern, Some("src"), 200, SearchMode::Regex, false)
        .unwrap();
    assert_eq!(a.matches.len(), 2);
    assert_eq!(b.matches.len(), 2);
    assert_eq!(a.matches[0].text, "let TOKEN = 17;\r\n");
    assert_eq!(a.matches[1].text, "let token = 23;\n");
    for (old, new) in a.matches.iter().zip(&b.matches) {
        assert_eq!(
            serde_json::to_value(old).unwrap(),
            serde_json::to_value(new).unwrap()
        );
    }
    assert_eq!(
        retained
            .search_files_with_options(pattern, Some("src"), 200, SearchMode::Regex, true)
            .unwrap()
            .matches
            .len(),
        1
    );
    assert_eq!(
        retained
            .search_files_with_options(pattern, None, 200, SearchMode::Regex, false)
            .unwrap()
            .matches
            .len(),
        3
    );
    assert!(
        retained
            .search_files_with_options(pattern, Some("private.rs"), 200, SearchMode::Regex, false)
            .unwrap()
            .matches
            .is_empty()
    );
    assert_eq!(
        retained
            .search_files(".*", None, 200)
            .unwrap()
            .matches
            .len(),
        1
    );
    assert!(
        retained
            .search_files_with_options(r"17;\nlet", None, 200, SearchMode::Regex, false)
            .unwrap()
            .matches
            .is_empty()
    );
    snapshot.cleanup().unwrap();
}
#[test]
fn literal_api_identity_and_unicode_casefold_remain_explicit() {
    let (dir, bundle) = fixture(&[("a", "Σ token.[]\nσ TOKEN.[]\nς ToKeN.[]\n")], &["a"]);
    let retained = SourceInvestigation::new(&bundle);
    let snapshot =
        SnapshotInvestigation::prepare(&zero_executor::pin_snapshot(dir.path()).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(retained.search_files("token.[]", None, 20).unwrap()).unwrap(),
        serde_json::to_value(
            retained
                .search_files_with_options("token.[]", None, 20, SearchMode::Literal, true)
                .unwrap()
        )
        .unwrap()
    );
    assert_eq!(
        serde_json::to_value(snapshot.search_files("token.[]", None, 20).unwrap()).unwrap(),
        serde_json::to_value(
            snapshot
                .search_files_with_options("token.[]", None, 20, SearchMode::Literal, true)
                .unwrap()
        )
        .unwrap()
    );
    assert_eq!(
        retained
            .search_files_with_options("σ", None, 20, SearchMode::Literal, false)
            .unwrap()
            .matches
            .len(),
        3
    );
    assert_eq!(
        snapshot
            .search_files_with_options("TOKEN.[]", None, 20, SearchMode::Literal, false)
            .unwrap()
            .matches
            .len(),
        3
    );
    snapshot.cleanup().unwrap();
}
#[test]
fn invalid_patterns_limits_and_scope_are_explicit_before_snapshot_reads() {
    let (dir, bundle) = fixture(&[("a", "aaaa\n")], &["a"]);
    let retained = SourceInvestigation::new(&bundle);
    let snapshot =
        SnapshotInvestigation::prepare(&zero_executor::pin_snapshot(dir.path()).unwrap()).unwrap();
    for bad in ["[", r"(?=a)", r"(a)\1", "", "a\nb", "\0", "a{100000000}"] {
        assert!(
            retained
                .search_files_with_options(bad, None, 20, SearchMode::Regex, true)
                .is_err(),
            "{bad}"
        );
        assert!(
            snapshot
                .search_files_with_options(bad, None, 20, SearchMode::Regex, true)
                .is_err(),
            "{bad}"
        );
    }
    let nested = format!("{}a{}", "(".repeat(40), ")".repeat(40));
    let long = "a".repeat(257);
    for bad in [&nested, &long] {
        assert!(
            retained
                .search_files_with_options(bad, None, 20, SearchMode::Regex, true)
                .is_err()
        );
    }
    for path in ["../a", "/a", "a/../a", "a//b"] {
        assert!(
            retained
                .search_files_with_options("a", Some(path), 20, SearchMode::Regex, true)
                .is_err()
        );
        assert!(
            snapshot
                .search_files_with_options("a", Some(path), 20, SearchMode::Regex, true)
                .is_err()
        );
    }
    for limit in [0, 201] {
        assert!(
            retained
                .search_files_with_options("a", None, limit, SearchMode::Regex, true)
                .is_err()
        );
    }
    let private = snapshot.root().join("source/a");
    fs::set_permissions(&private, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(private, "tampered").unwrap();
    let error = snapshot
        .search_files_with_options("[", None, 20, SearchMode::Regex, true)
        .unwrap_err()
        .to_string();
    assert!(error.contains("invalid regex"));
    assert!(
        snapshot
            .search_files_with_options("a", None, 20, SearchMode::Regex, true)
            .is_err()
    );
    snapshot.cleanup().unwrap();
}
#[test]
fn result_limit_and_output_bound_do_not_emit_partial_lines() {
    let text = (0..100)
        .map(|_| format!("token{}\r\n", "\t".repeat(1000)))
        .collect::<String>();
    let (dir, bundle) = fixture(&[("a", &text)], &["a"]);
    let retained = SourceInvestigation::new(&bundle);
    let snapshot =
        SnapshotInvestigation::prepare(&zero_executor::pin_snapshot(dir.path()).unwrap()).unwrap();
    for result in [
        serde_json::to_value(
            retained
                .search_files_with_options("^token", None, 200, SearchMode::Regex, true)
                .unwrap(),
        )
        .unwrap(),
        serde_json::to_value(
            snapshot
                .search_files_with_options("^token", None, 200, SearchMode::Regex, true)
                .unwrap(),
        )
        .unwrap(),
    ] {
        assert_eq!(result["truncated"], true);
        assert!(serde_json::to_vec(&result).unwrap().len() <= MAX_INVESTIGATION_OUTPUT_BYTES);
        assert!(!result["matches"].as_array().unwrap().is_empty());
        for hit in result["matches"].as_array().unwrap() {
            assert!(hit["text"].as_str().unwrap().ends_with("\r\n"));
        }
    }
    let result = retained
        .search_files_with_options("^token", None, 1, SearchMode::Regex, true)
        .unwrap();
    assert_eq!(result.matches.len(), 1);
    assert!(result.truncated);
    snapshot.cleanup().unwrap();
}
#[test]
fn snapshot_listing_pages_can_scope_regex_over_all_files_after_original_deletion() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..67 {
        fs::write(
            dir.path().join(format!("f{i:02}.txt")),
            format!("TOKEN{i:02}\r\n"),
        )
        .unwrap();
    }
    let pin = zero_executor::pin_snapshot(dir.path()).unwrap();
    let snapshot = SnapshotInvestigation::prepare(&pin).unwrap();
    fs::remove_dir_all(dir.path()).unwrap();
    let mut cursor = None;
    let mut seen = Vec::new();
    loop {
        let page = snapshot
            .list_files_page(None, 32, cursor.as_deref())
            .unwrap();
        for file in &page.files {
            let found = snapshot
                .search_files_with_options(
                    r"^token[0-9]{2}$",
                    Some(&file.path),
                    1,
                    SearchMode::Regex,
                    false,
                )
                .unwrap();
            assert_eq!(found.matches.len(), 1);
            assert_eq!(found.matches[0].citation.path, file.path);
            seen.push(file.path.clone());
        }
        cursor = page.next_after_path;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(seen.len(), 67);
    assert!(seen.windows(2).all(|p| p[0] < p[1]));
    assert_eq!(
        snapshot
            .search_files_with_options("^TOKEN", None, 200, SearchMode::Regex, true)
            .unwrap()
            .matches
            .len(),
        67
    );
    snapshot.cleanup().unwrap();
}
#[test]
fn nested_quantifiers_zero_width_and_dense_matches_are_finite_one_per_line() {
    let text = format!("{}!\n\nlast\n", "a".repeat(100_000));
    let (dir, bundle) = fixture(&[("a", &text)], &["a"]);
    let retained = SourceInvestigation::new(&bundle);
    let snapshot =
        SnapshotInvestigation::prepare(&zero_executor::pin_snapshot(dir.path()).unwrap()).unwrap();
    assert!(
        retained
            .search_files_with_options("^(a+)+$", None, 200, SearchMode::Regex, true)
            .unwrap()
            .matches
            .is_empty()
    );
    let result = snapshot
        .search_files_with_options("^$", None, 200, SearchMode::Regex, true)
        .unwrap();
    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].text, "\n");
    assert_eq!(result.matches[0].citation.start_line, 2);
    // The dense first line is deliberately too large for an output receipt.
    assert!(
        retained
            .search_files_with_options("a*", None, 200, SearchMode::Regex, true)
            .is_err()
    );
    snapshot.cleanup().unwrap();
}
