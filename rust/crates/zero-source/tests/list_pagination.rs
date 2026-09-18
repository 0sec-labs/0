#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used)]
use std::{collections::BTreeSet, fs};
use zero_executor::pin_snapshot;
use zero_source::{
    ReviewRequest, SnapshotInvestigation, investigation::SourceInvestigation, prepare,
};
fn files(paths: &[String]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for name in paths.iter().rev() {
        let path = dir.path().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "retained\n").unwrap();
    }
    dir
}
#[test]
fn full_snapshot_pages_reach_every_file_once_without_host_reads() {
    let names: Vec<_> = (0..75).map(|i| format!("src/file-{i:03}.rs")).collect();
    let dir = files(&names);
    let pin = pin_snapshot(dir.path()).unwrap();
    let view = SnapshotInvestigation::prepare(&pin).unwrap();
    fs::remove_dir_all(dir.path().join("src")).unwrap();
    let first = view.list_files(Some("src"), 32).unwrap();
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(view.list_files_page(Some("src"), 32, None).unwrap()).unwrap()
    );
    let mut seen = vec![];
    let mut cursor = None;
    let mut counts = vec![];
    loop {
        let page = view
            .list_files_page(Some("src"), 32, cursor.as_deref())
            .unwrap();
        counts.push(page.files.len());
        assert_eq!(page.snapshot_digest, pin.digest);
        if page.truncated {
            assert_eq!(
                page.next_after_path.as_ref(),
                page.files.last().map(|f| &f.path)
            );
        } else {
            assert!(page.next_after_path.is_none());
            assert!(
                serde_json::to_value(&page)
                    .unwrap()
                    .get("next_after_path")
                    .is_none()
            );
        }
        seen.extend(page.files.into_iter().map(|f| f.path));
        cursor = page.next_after_path;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(counts, vec![32, 32, 11]);
    assert_eq!(seen, names);
    assert_eq!(seen.iter().collect::<BTreeSet<_>>().len(), 75);
    let exhausted = view
        .list_files_page(Some("src"), 1, Some(names.last().unwrap()))
        .unwrap();
    assert!(exhausted.files.is_empty());
    assert!(!exhausted.truncated);
    assert!(exhausted.next_after_path.is_none());
    view.cleanup().unwrap();
}
#[test]
fn retained_bundle_pages_reject_unselected_noncanonical_and_out_of_scope_cursors() {
    let names = vec![
        "src/a".into(),
        "src/b".into(),
        "src/c".into(),
        "src2/other".into(),
        "unselected".into(),
    ];
    let dir = files(&names);
    let prepared = prepare(&ReviewRequest {
        snapshot: pin_snapshot(dir.path()).unwrap(),
        selected_files: names[..4].to_vec(),
        question: "fixture".into(),
        max_hypotheses: 1,
    })
    .unwrap();
    let view = SourceInvestigation::new(prepared.bundle());
    let first = view.list_files_page(Some("src"), 2, None).unwrap();
    assert_eq!(first.next_after_path.as_deref(), Some("src/b"));
    assert!(first.truncated);
    let last = view
        .list_files_page(Some("src"), 2, first.next_after_path.as_deref())
        .unwrap();
    assert_eq!(last.files.len(), 1);
    assert_eq!(last.files[0].path, "src/c");
    assert!(!last.truncated);
    assert!(last.next_after_path.is_none());
    for cursor in [
        "unselected",
        "src2/other",
        "src/missing",
        "./src/a",
        "src/a/",
        "src//a",
        "src/../a",
        "/src/a",
        "",
    ] {
        assert!(
            view.list_files_page(Some("src"), 2, Some(cursor)).is_err(),
            "{cursor}"
        );
    }
    assert_eq!(
        view.list_files(Some("src"), 2).unwrap().next_after_path,
        first.next_after_path
    );
}
#[test]
fn snapshot_cursor_must_belong_to_current_manifest_and_scope() {
    let dir = files(&["a/first".into(), "a/last".into(), "ab/other".into()]);
    let view = SnapshotInvestigation::prepare(&pin_snapshot(dir.path()).unwrap()).unwrap();
    for cursor in [
        "ab/other",
        "a/missing",
        "./a/first",
        "a/first/",
        "a//first",
        "a/../first",
        "/a/first",
        "",
    ] {
        assert!(
            view.list_files_page(Some("a"), 1, Some(cursor)).is_err(),
            "{cursor}"
        );
    }
    let old = view
        .list_files_page(Some("a"), 1, None)
        .unwrap()
        .next_after_path
        .unwrap();
    fs::remove_file(dir.path().join("a/first")).unwrap();
    let changed = SnapshotInvestigation::prepare(&pin_snapshot(dir.path()).unwrap()).unwrap();
    assert!(changed.list_files_page(Some("a"), 1, Some(&old)).is_err());
    // Existing views remain immutable despite a new manifest on the host.
    assert_eq!(
        view.list_files_page(Some("a"), 1, Some(&old))
            .unwrap()
            .files[0]
            .path,
        "a/last"
    );
    view.cleanup().unwrap();
    changed.cleanup().unwrap();
}
#[test]
fn serialized_output_limit_includes_cursor_and_still_makes_progress() {
    let prefix = vec!["x".repeat(200); 7].join("/");
    let names: Vec<_> = (0..70).map(|i| format!("{prefix}/file-{i:03}")).collect();
    let dir = files(&names);
    let view = SnapshotInvestigation::prepare(&pin_snapshot(dir.path()).unwrap()).unwrap();
    let mut cursor = None;
    let mut seen = vec![];
    let mut pages = 0;
    loop {
        let page = view.list_files_page(None, 200, cursor.as_deref()).unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= 64 * 1024);
        assert!(!page.files.is_empty());
        seen.extend(page.files.into_iter().map(|f| f.path));
        pages += 1;
        cursor = page.next_after_path;
        if cursor.is_none() {
            break;
        }
        assert!(pages < 70);
    }
    assert!(pages > 1);
    assert_eq!(seen, names);
    view.cleanup().unwrap();
}
