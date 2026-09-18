#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used)]
use std::fs;
use zero_source::{ReviewRequest, SourceBundle, investigation::*, prepare};
fn bundle(files: &[(&str, &str)], selected: Vec<String>) -> (tempfile::TempDir, SourceBundle) {
    let dir = tempfile::tempdir().unwrap();
    for (path, text) in files {
        let full = dir.path().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }
    let review = prepare(&ReviewRequest {
        snapshot: zero_executor::pin_snapshot(dir.path()).unwrap(),
        selected_files: selected,
        question: "Investigate retained source".into(),
        max_hypotheses: 2,
    })
    .unwrap();
    (dir, review.bundle().clone())
}
#[test]
fn listing_and_exact_ranges_keep_hashes_crlf_unicode_and_selected_authority() {
    let (dir, bundle) = bundle(
        &[
            ("src/app.rs", "α first\r\nneedle second\nlast"),
            ("src/empty.rs", ""),
            ("src2/other.rs", "needle hidden\n"),
            ("private.txt", "unselected"),
        ],
        vec![
            "src/app.rs".into(),
            "src/empty.rs".into(),
            "src2/other.rs".into(),
        ],
    );
    let view = SourceInvestigation::new(&bundle);
    let listed = view.list_files(Some("./src/"), 32).unwrap();
    assert_eq!(listed.files.len(), 2);
    assert!(!listed.truncated);
    assert_eq!(listed.files[0].lines, 3);
    assert_eq!(listed.files[1].lines, 0);
    let read = view.read_file("./src/app.rs", 1, 2).unwrap();
    assert_eq!(read.text, "α first\r\nneedle second\n");
    assert_eq!(read.citation.path, "src/app.rs");
    assert_eq!(read.citation.start_line, 1);
    assert_eq!(read.citation.end_line, 2);
    assert_eq!(read.citation.sha256, bundle.files()[0].sha256());
    assert_eq!(read.bundle_sha256, bundle.digest());
    assert!(view.read_file("private.txt", 1, 1).is_err());
    assert!(view.read_file("src/empty.rs", 1, 1).is_err());
    fs::remove_dir_all(dir.path().join("src")).unwrap();
    assert_eq!(view.read_file("src/app.rs", 1, 2).unwrap().text, read.text);
}
#[test]
fn literal_search_returns_whole_lines_and_truthful_result_limits() {
    let (_dir, bundle) = bundle(
        &[
            ("a.rs", "needle needle\nNeedle\n.* [a] needle\nend needle"),
            ("b.rs", "none"),
        ],
        vec!["a.rs".into(), "b.rs".into()],
    );
    let view = SourceInvestigation::new(&bundle);
    let result = view.search_files("needle", None, 3).unwrap();
    assert_eq!(result.matches.len(), 3);
    assert!(!result.truncated);
    assert_eq!(result.matches[0].text, "needle needle\n");
    assert_eq!(result.matches[1].citation.start_line, 3);
    assert_eq!(result.matches[2].citation.end_line, 4);
    assert!(view.search_files("needle", Some("."), 2).unwrap().truncated);
    assert_eq!(view.search_files(".*", None, 1).unwrap().matches.len(), 1);
    assert!(
        view.search_files("NEEDLE", None, 10)
            .unwrap()
            .matches
            .is_empty()
    );
    for hit in result.matches {
        let read = view
            .read_file(
                &hit.citation.path,
                hit.citation.start_line,
                hit.citation.end_line,
            )
            .unwrap();
        assert_eq!(read.text, hit.text);
        assert_eq!(read.citation.sha256, hit.citation.sha256);
    }
    assert!(view.list_files(None, 1).unwrap().truncated);
    assert!(!view.list_files(None, 2).unwrap().truncated);
}
#[test]
fn traversal_absolute_control_and_non_normal_paths_never_expand_authority() {
    let (_dir, bundle) = bundle(&[("app.rs", "one\n")], vec!["app.rs".into()]);
    let view = SourceInvestigation::new(&bundle);
    for path in [
        "../app.rs",
        "./../app.rs",
        "/etc/passwd",
        "app.rs/../x",
        "x//y",
        "x\\y",
        "x\0y",
        "x\ny",
        "C:/x",
        "././app.rs",
    ] {
        assert!(view.read_file(path, 1, 1).is_err(), "read {path:?}");
        assert!(view.list_files(Some(path), 1).is_err(), "list {path:?}");
        assert!(
            view.search_files("one", Some(path), 1).is_err(),
            "search {path:?}"
        );
    }
    assert!(
        view.list_files(Some("unretained"), 32)
            .unwrap()
            .files
            .is_empty()
    );
    for (start, end) in [(0, 1), (2, 1), (1, 2), (1, 201), (u32::MAX, u32::MAX)] {
        assert!(view.read_file("app.rs", start, end).is_err());
    }
    for query in ["", "\n", "\r", "\0"] {
        assert!(view.search_files(query, None, 1).is_err());
    }
    assert!(view.search_files(&"a".repeat(257), None, 1).is_err());
    assert!(view.search_files(&"α".repeat(129), None, 1).is_err());
    assert!(view.search_files("one", None, 0).is_err());
    assert!(view.search_files("one", None, 201).is_err());
    assert!(view.list_files(None, 0).is_err());
    assert!(view.list_files(None, 33).is_err());
}
#[test]
fn output_bound_counts_json_escaping_and_never_returns_partial_cited_line() {
    let big = format!("needle{}\n", "\t".repeat(40000));
    let (_dir, bundle) = bundle(&[("big.rs", &big)], vec!["big.rs".into()]);
    let view = SourceInvestigation::new(&bundle);
    assert!(view.read_file("big.rs", 1, 1).is_err());
    assert!(view.search_files("needle", None, 1).is_err());
    let lines = (0..100)
        .map(|_| format!("needle{}\n", "a".repeat(1000)))
        .collect::<String>();
    let (_dir, bundle) = self::bundle(&[("many.rs", &lines)], vec!["many.rs".into()]);
    let view = SourceInvestigation::new(&bundle);
    let result = view.search_files("needle", None, 200).unwrap();
    assert!(result.truncated);
    assert!(!result.matches.is_empty());
    assert!(result.matches.len() < 100);
    assert!(serde_json::to_vec(&result).unwrap().len() <= MAX_INVESTIGATION_OUTPUT_BYTES);
    assert!(
        result
            .matches
            .iter()
            .all(|m| m.text.len() == 1007 && m.text.ends_with('\n'))
    );
}
#[test]
fn import_hash_tampering_and_symlink_source_cannot_construct_authorized_views() {
    let (dir, bundle) = bundle(&[("app.rs", "retained\n")], vec!["app.rs".into()]);
    let mut data: serde_json::Value = serde_json::from_slice(&bundle.to_bytes().unwrap()).unwrap();
    data["files"][0]["text"] = serde_json::json!("changed");
    assert!(SourceBundle::from_bytes(&serde_json::to_vec(&data).unwrap()).is_err());
    let pin = zero_executor::pin_snapshot(dir.path()).unwrap();
    fs::remove_file(dir.path().join("app.rs")).unwrap();
    std::os::unix::fs::symlink("/etc/passwd", dir.path().join("app.rs")).unwrap();
    assert!(
        prepare(&ReviewRequest {
            snapshot: pin,
            selected_files: vec!["app.rs".into()],
            question: "test".into(),
            max_hypotheses: 1
        })
        .is_err()
    );
    let view = SourceInvestigation::new(&bundle);
    assert_eq!(view.read_file("app.rs", 1, 1).unwrap().text, "retained\n");
}
