#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used)]
use std::{fs, path::Path};
use zero_repair::*;
fn fixture() -> (tempfile::TempDir, MaterializeRequest) {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("src")).unwrap();
    fs::create_dir(dir.path().join("tests")).unwrap();
    fs::write(
        dir.path().join("src/app.js"),
        b"const vulnerable = true;\r\n",
    )
    .unwrap();
    fs::write(dir.path().join("tests/oracle.js"), b"protected oracle\n").unwrap();
    fs::write(dir.path().join("config.json"), b"{}\n").unwrap();
    let baseline = zero_executor::pin_snapshot(dir.path()).unwrap();
    let expected_preimage_sha256 = baseline
        .files
        .iter()
        .find(|f| f.path == "src/app.js")
        .unwrap()
        .digest
        .clone();
    (
        dir,
        MaterializeRequest {
            baseline,
            target: "src/app.js".into(),
            allowed_paths: vec!["src/app.js".into(), "config.json".into()],
            protected_paths: vec!["tests".into(), "config.json".into()],
            expected_preimage_sha256,
            replacement: "const vulnerable = false;\r\n// candidate, not verified\n".into(),
        },
    )
}
fn unchanged(request: &MaterializeRequest) {
    zero_executor::verify_snapshot(&request.baseline, &|| Ok(())).unwrap();
}
#[test]
fn exact_single_file_copy_receipts_repeat_without_root_identity_and_drop_cleans_up() {
    let (_dir, request) = fixture();
    let first = materialize(&request).unwrap();
    let second = materialize(&request).unwrap();
    assert_ne!(first.snapshot().root, second.snapshot().root);
    assert_eq!(first.snapshot().digest, second.snapshot().digest);
    assert_eq!(first.receipt(), second.receipt());
    assert_eq!(first.replacement_bytes(), request.replacement.as_bytes());
    assert_eq!(
        fs::read(Path::new(&first.snapshot().root).join("src/app.js")).unwrap(),
        request.replacement.as_bytes()
    );
    assert_eq!(
        fs::read(Path::new(&first.snapshot().root).join("tests/oracle.js")).unwrap(),
        b"protected oracle\n"
    );
    assert_eq!(
        first.receipt().baseline_snapshot_sha256,
        request.baseline.digest
    );
    assert_eq!(
        first.receipt().preimage_sha256,
        request.expected_preimage_sha256
    );
    assert_eq!(
        first.receipt().candidate_snapshot_sha256,
        first.snapshot().digest
    );
    let receipt: CandidateReceipt =
        serde_json::from_slice(&serde_json::to_vec(first.receipt()).unwrap()).unwrap();
    assert_eq!(&receipt, first.receipt());
    let root = first.snapshot().root.clone();
    drop(first);
    assert!(!Path::new(&root).exists());
    unchanged(&request);
}
#[test]
fn policy_order_is_canonical_duplicates_and_protected_prefixes_are_rejected() {
    let (_dir, mut request) = fixture();
    let first = materialize(&request).unwrap();
    request.allowed_paths.reverse();
    request.protected_paths.reverse();
    assert_eq!(first.receipt(), materialize(&request).unwrap().receipt());
    request.allowed_paths.push(request.target.clone());
    assert!(materialize(&request).is_err());
    request.allowed_paths.pop();
    request.protected_paths.push("tests".into());
    assert!(materialize(&request).is_err());
    request.protected_paths.pop();
    for protected in ["src", "src/app.js"] {
        let mut bad = request.clone();
        bad.protected_paths.push(protected.into());
        assert!(materialize(&bad).is_err());
        unchanged(&request);
    }
    request.protected_paths.push("src/app".into());
    assert!(
        materialize(&request).is_ok(),
        "prefix without directory boundary is not an overlap"
    );
    unchanged(&request);
}
#[test]
fn traversal_missing_allowlist_wrong_preimage_and_oversize_fail_without_original_changes() {
    let (_dir, request) = fixture();
    for target in [
        "../app.js",
        "/tmp/app.js",
        "src/../app.js",
        "src//app.js",
        "src\\app.js",
        "src/app.js/",
        "src/./app.js",
        "src/new.js",
    ] {
        let mut bad = request.clone();
        bad.target = target.into();
        bad.allowed_paths = vec![target.into()];
        assert!(materialize(&bad).is_err(), "accepted {target}");
        unchanged(&request);
    }
    let mut bad = request.clone();
    bad.allowed_paths.clear();
    assert!(materialize(&bad).is_err());
    let mut bad = request.clone();
    bad.expected_preimage_sha256 = format!("sha256:{}", "0".repeat(64));
    assert!(materialize(&bad).is_err());
    let mut bad = request.clone();
    bad.replacement = "a".repeat(MAX_REPLACEMENT_BYTES + 1);
    assert!(materialize(&bad).is_err());
    let mut bad = request.clone();
    bad.replacement = "hello\0world".into();
    assert!(materialize(&bad).is_err());
    let mut bad = request.clone();
    bad.baseline.files[0].bytes = MAX_SNAPSHOT_BYTES + 1;
    assert!(materialize(&bad).is_err());
    let mut bad = request.clone();
    bad.baseline.files = vec![bad.baseline.files[0].clone(); MAX_SNAPSHOT_FILES + 1];
    assert!(materialize(&bad).is_err());
    unchanged(&request);
}
#[test]
fn unselected_drift_unindexed_file_and_symlink_are_rejected_without_writing_source() {
    let (dir, request) = fixture();
    fs::write(dir.path().join("tests/oracle.js"), b"changed oracle").unwrap();
    assert!(materialize(&request).is_err());
    assert_eq!(
        fs::read(dir.path().join("src/app.js")).unwrap(),
        b"const vulnerable = true;\r\n"
    );
    fs::write(dir.path().join("tests/oracle.js"), b"protected oracle\n").unwrap();
    fs::write(dir.path().join("newfile"), b"unindexed").unwrap();
    assert!(materialize(&request).is_err());
    fs::remove_file(dir.path().join("newfile")).unwrap();
    fs::remove_file(dir.path().join("src/app.js")).unwrap();
    std::os::unix::fs::symlink("../tests/oracle.js", dir.path().join("src/app.js")).unwrap();
    assert!(materialize(&request).is_err());
    assert!(
        fs::symlink_metadata(dir.path().join("src/app.js"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read(dir.path().join("tests/oracle.js")).unwrap(),
        b"protected oracle\n"
    );
}
#[test]
fn binary_preimage_is_rejected_and_empty_utf8_replacement_is_exact() {
    let (dir, mut request) = fixture();
    request.replacement.clear();
    let candidate = materialize(&request).unwrap();
    assert_eq!(candidate.receipt().replacement_bytes, 0);
    assert!(
        fs::read(Path::new(&candidate.snapshot().root).join("src/app.js"))
            .unwrap()
            .is_empty()
    );
    for bytes in [vec![255], vec![0]] {
        fs::write(dir.path().join("src/app.js"), &bytes).unwrap();
        request.baseline = zero_executor::pin_snapshot(dir.path()).unwrap();
        request.expected_preimage_sha256 = request
            .baseline
            .files
            .iter()
            .find(|f| f.path == request.target)
            .unwrap()
            .digest
            .clone();
        assert!(materialize(&request).is_err());
        assert_eq!(fs::read(dir.path().join("src/app.js")).unwrap(), bytes);
    }
}
#[test]
fn receipt_does_not_confer_authority_and_changed_policy_has_distinct_identity() {
    let (_dir, mut request) = fixture();
    let first = materialize(&request).unwrap();
    request.allowed_paths = vec![request.target.clone()];
    let second = materialize(&request).unwrap();
    assert_eq!(first.snapshot().digest, second.snapshot().digest);
    assert_ne!(
        first.receipt().policy_sha256,
        second.receipt().policy_sha256
    );
    let json = serde_json::to_value(first.receipt()).unwrap();
    assert!(json.get("validated").is_none());
    assert!(json.get("fixed").is_none());
    assert!(json.get("root").is_none());
    unchanged(&request);
}

#[test]
fn consuming_cleanup_removes_private_tree_and_preserves_original() {
    let (_dir, request) = fixture();
    let candidate = materialize(&request).unwrap();
    let root = candidate.snapshot().root.clone();
    candidate.cleanup().unwrap();
    assert!(!Path::new(&root).exists());
    unchanged(&request);
}

#[test]
fn expected_receipt_is_pure_and_matches_materialized_copy() {
    let (dir, request) = fixture();
    let expected = expected_receipt(&request).unwrap();
    let candidate = materialize(&request).unwrap();
    assert_eq!(candidate.receipt(), &expected);
    candidate.cleanup().unwrap();
    fs::remove_dir_all(dir.path()).unwrap();
    assert_eq!(expected_receipt(&request).unwrap(), expected);
    let mut bad = request.clone();
    bad.baseline.digest = format!("sha256:{}", "0".repeat(64));
    assert!(expected_receipt(&bad).is_err());
    let mut bad = request;
    bad.protected_paths.push(bad.target.clone());
    assert!(expected_receipt(&bad).is_err());
}

#[test]
fn reanchoring_preserves_every_authority_field_and_allows_deleted_original_source() {
    let (dir, request) = fixture();
    let stage = zero_executor::stage_snapshot(&request.baseline, &|| Ok(())).unwrap();
    let mut restored = request.baseline.clone();
    restored.root = stage.source().to_string_lossy().into_owned();
    let derived = reanchor_materialization(&request, &restored).unwrap();
    let mut expected = serde_json::to_value(&request).unwrap();
    expected["baseline"]["root"] = serde_json::json!(restored.root);
    assert_eq!(serde_json::to_value(&derived).unwrap(), expected);
    assert_eq!(
        expected_receipt(&request).unwrap(),
        expected_receipt(&derived).unwrap()
    );
    for change in 0..7 {
        let mut bad = restored.clone();
        match change {
            0 => bad.root = "relative".into(),
            1 => bad.id.push_str("changed"),
            2 => bad.digest = format!("sha256:{}", "0".repeat(64)),
            3 => bad.files[0].bytes += 1,
            4 => bad.files[0].digest = format!("sha256:{}", "0".repeat(64)),
            5 => bad.files[0].path.push_str("changed"),
            _ => {
                bad.files.pop();
            }
        }
        assert!(
            reanchor_materialization(&request, &bad).is_err(),
            "accepted mutation {change}"
        );
    }
    dir.close().unwrap();
    let candidate = materialize_checked(&derived, &|| Ok(())).unwrap();
    assert_eq!(candidate.receipt(), &expected_receipt(&request).unwrap());
    assert_eq!(
        fs::read(Path::new(&candidate.snapshot().root).join(&request.target)).unwrap(),
        request.replacement.as_bytes()
    );
    candidate.cleanup().unwrap();
    stage.remove().unwrap();
}

#[test]
fn cancellation_is_checked_through_staging_replacement_and_final_pinning() {
    use std::cell::Cell;
    let (_dir, request) = fixture();
    let calls = Cell::new(0);
    let candidate = materialize_checked(&request, &|| {
        calls.set(calls.get() + 1);
        Ok(())
    })
    .unwrap();
    candidate.cleanup().unwrap();
    assert!(calls.get() > 5);
    for stop in 0..calls.get() {
        let seen = Cell::new(0);
        assert!(
            materialize_checked(&request, &|| {
                let current = seen.get();
                seen.set(current + 1);
                if current >= stop {
                    Err("cancelled".into())
                } else {
                    Ok(())
                }
            })
            .is_err(),
            "ignored cancellation at {stop}"
        );
        unchanged(&request);
    }
}
