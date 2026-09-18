#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};
use zero_executor::pin_snapshot;
use zero_source::{
    SnapshotInvestigation,
    snapshot_investigation::{SkipReason, SnapshotError},
};

fn source(files: &[(&str, &[u8])]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (path, bytes) in files {
        let file = dir.path().join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, bytes).unwrap();
    }
    dir
}
fn writable(path: &std::path::Path) {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
#[test]
fn entire_manifest_is_deterministic_and_original_mutation_cannot_change_reads() {
    let dir = source(&[
        ("src/a.rs", b"first\r\nsecond\nthird"),
        ("src2/b.rs", b"second\n"),
    ]);
    for index in 0..50 {
        fs::write(dir.path().join(format!("file-{index:02}")), "contents").unwrap();
    }
    let pin = pin_snapshot(dir.path()).unwrap();
    let view = SnapshotInvestigation::prepare(&pin).unwrap();
    let other = SnapshotInvestigation::prepare(&pin).unwrap();
    assert_ne!(view.root(), other.root());
    assert_eq!(
        view.catalog_bytes().unwrap(),
        other.catalog_bytes().unwrap()
    );
    assert_eq!(
        format!("sha256:{:x}", Sha256::digest(view.catalog_bytes().unwrap())),
        pin.digest
    );
    assert_eq!(view.list_files(None, 200).unwrap().files.len(), 52);
    assert!(view.list_files(None, 32).unwrap().truncated);
    assert!(!view.list_files(None, 52).unwrap().truncated);
    fs::remove_dir_all(dir.path().join("src")).unwrap();
    let read = view.read_file("./src/a.rs", 1, 2).unwrap();
    assert_eq!(read.text, "first\r\nsecond\n");
    assert_eq!(read.total_lines, 3);
    assert_eq!(read.snapshot_digest, pin.digest);
    assert_eq!(
        read.citation.sha256,
        pin.files
            .iter()
            .find(|f| f.path == "src/a.rs")
            .unwrap()
            .digest
    );
    assert_eq!(read.citation.start_line, 1);
    assert_eq!(read.citation.end_line, 2);
    let search = view.search_files("second", Some("./src/"), 200).unwrap();
    assert_eq!(search.matches.len(), 1);
    assert_eq!(search.matches[0].text, "second\n");
    assert_eq!(search.matches[0].citation.start_line, 2);
    assert_eq!(search.matches[0].citation.sha256, read.citation.sha256);
    assert_eq!(search.scanned_files, 1);
    assert!(search.skipped.is_empty());
    assert!(!search.truncated);
    let recovery = view.root().to_owned();
    view.cleanup().unwrap();
    assert!(!recovery.exists());
    let recovery = other.root().to_owned();
    drop(other);
    assert!(!recovery.exists());
    assert_eq!(fs::read(dir.path().join("src2/b.rs")).unwrap(), b"second\n");
}
#[test]
fn private_copy_tamper_is_rejected_for_reads_and_searches() {
    let dir = source(&[("nested/file", b"original\n")]);
    let pin = pin_snapshot(dir.path()).unwrap();
    let view = SnapshotInvestigation::prepare(&pin).unwrap();
    let file = view.root().join("source/nested/file");
    writable(&file);
    fs::write(&file, b"tampered\n").unwrap();
    assert!(matches!(
        view.read_file("nested/file", 1, 1),
        Err(SnapshotError::Integrity)
    ));
    assert!(matches!(
        view.search_files("original", None, 200),
        Err(SnapshotError::Integrity)
    ));
    assert_eq!(
        fs::read(dir.path().join("nested/file")).unwrap(),
        b"original\n"
    );
    view.cleanup().unwrap();
}
#[test]
fn symlink_and_path_bypasses_are_rejected_even_inside_private_copy() {
    let dir = source(&[("nested/file", b"original\n")]);
    let pin = pin_snapshot(dir.path()).unwrap();
    let view = SnapshotInvestigation::prepare(&pin).unwrap();
    for bad in [
        "../nested/file",
        "/nested/file",
        "nested/../file",
        "nested//file",
        "nested\\file",
        "nested/file/",
        "C:file",
        "nested/./file",
        "\0",
    ] {
        assert!(view.read_file(bad, 1, 1).is_err(), "{bad:?}");
    }
    for bad in ["../nested", "/nested", "nested//", "nested/../"] {
        assert!(view.list_files(Some(bad), 200).is_err());
        assert!(view.search_files("original", Some(bad), 200).is_err());
    }
    assert!(view.read_file("unindexed", 1, 1).is_err());
    let private = view.root().join("source/nested");
    fs::remove_file(private.join("file")).unwrap();
    symlink(dir.path().join("nested/file"), private.join("file")).unwrap();
    assert!(view.read_file("nested/file", 1, 1).is_err());
    fs::remove_dir_all(&private).unwrap();
    symlink(dir.path().join("nested"), &private).unwrap();
    assert!(view.read_file("nested/file", 1, 1).is_err());
    assert!(view.search_files("original", None, 200).is_err());
    view.cleanup().unwrap();
    assert_eq!(
        fs::read(dir.path().join("nested/file")).unwrap(),
        b"original\n"
    );
    symlink("file", dir.path().join("nested/link")).unwrap();
    assert!(SnapshotInvestigation::prepare(&pin).is_err());
}
#[test]
fn search_reports_every_excluded_encoding_and_size_instead_of_claiming_empty_complete_text() {
    let dir = source(&[
        ("binary", &[255, 254]),
        ("nul", b"hello\0world"),
        ("text", b"alpha\nalpha\n"),
    ]);
    fs::write(dir.path().join("large"), vec![b'x'; 128 * 1024 + 1]).unwrap();
    let pin = pin_snapshot(dir.path()).unwrap();
    let view = SnapshotInvestigation::prepare(&pin).unwrap();
    let search = view.search_files("absent", None, 200).unwrap();
    assert!(search.matches.is_empty());
    assert!(!search.truncated);
    assert_eq!(search.scanned_files, 4);
    assert_eq!(
        search
            .skipped
            .iter()
            .map(|s| (s.path.as_str(), s.reason))
            .collect::<Vec<_>>(),
        vec![
            ("binary", SkipReason::NonUtf8),
            ("large", SkipReason::Oversized),
            ("nul", SkipReason::Nul)
        ]
    );
    for file in ["large", "binary", "nul"] {
        assert!(view.read_file(file, 1, 1).is_err());
    }
    let limited = view.search_files("alpha", Some("text"), 1).unwrap();
    assert_eq!(limited.matches.len(), 1);
    assert!(limited.truncated);
    assert!(
        !view
            .search_files("alpha", Some("text"), 2)
            .unwrap()
            .truncated
    );
    view.cleanup().unwrap();
}
#[test]
fn serialized_output_and_exclusions_are_bounded_and_line_query_limits_are_enforced() {
    let dir = source(&[
        ("giant-line", &vec![b'\t'; 128 * 1024]),
        ("lines", &"x\n".repeat(201).into_bytes()),
        ("empty", b""),
    ]);
    for index in 0..205 {
        fs::write(dir.path().join(format!("binary-{index:03}")), [255]).unwrap();
    }
    let view = SnapshotInvestigation::prepare(&pin_snapshot(dir.path()).unwrap()).unwrap();
    assert!(view.read_file("giant-line", 1, 1).is_err());
    let giant = view.search_files("\t", Some("giant-line"), 200).unwrap();
    assert!(giant.truncated);
    assert!(giant.matches.is_empty());
    let skipped = view.search_files("absent", None, 200).unwrap();
    assert_eq!(skipped.skipped.len(), 200);
    assert!(skipped.truncated);
    assert!(serde_json::to_vec(&skipped).unwrap().len() <= 64 * 1024);
    for range in [(0, 1), (2, 1), (1, 201), (202, 202)] {
        assert!(view.read_file("lines", range.0, range.1).is_err());
    }
    assert!(view.read_file("lines", 1, 200).is_ok());
    assert!(view.read_file("empty", 1, 1).is_err());
    for query in ["", "a\nb", "a\rb", "\0", &"x".repeat(257)] {
        assert!(view.search_files(query, None, 200).is_err());
    }
    for limit in [0, 201] {
        assert!(view.list_files(None, limit).is_err());
        assert!(view.search_files("x", None, limit).is_err());
    }
    view.cleanup().unwrap();
}
#[test]
fn manifest_limits_integrity_and_cancellation_are_checked_before_granting_authority() {
    let dir = source(&[("file", b"original")]);
    let pin = pin_snapshot(dir.path()).unwrap();
    assert!(SnapshotInvestigation::prepare_checked(&pin, &|| Err("cancel".into())).is_err());
    let checks = std::cell::Cell::new(0);
    assert!(
        SnapshotInvestigation::prepare_checked(&pin, &|| {
            checks.set(checks.get() + 1);
            if checks.get() >= 3 {
                Err("cancel during staging".into())
            } else {
                Ok(())
            }
        })
        .is_err()
    );
    assert_eq!(checks.get(), 3);
    for mutation in 0..5 {
        let mut bad = pin.clone();
        match mutation {
            0 => bad.files[0].bytes = 64 * 1024 * 1024 + 1,
            1 => bad.files = vec![bad.files[0].clone(); 4097],
            2 => bad.files[0].path = "../file".into(),
            3 => bad.files.push(bad.files[0].clone()),
            _ => bad.digest = "sha256:wrong".into(),
        }
        assert!(SnapshotInvestigation::prepare(&bad).is_err());
    }
    assert_eq!(fs::read(dir.path().join("file")).unwrap(), b"original");
    fs::write(dir.path().join("file"), b"changed").unwrap();
    assert!(SnapshotInvestigation::prepare(&pin).is_err());
    assert_eq!(fs::read(dir.path().join("file")).unwrap(), b"changed");
}

#[test]
fn aggregate_long_path_metadata_obeys_serialized_limits() {
    let dir = tempfile::tempdir().unwrap();
    let prefix = std::iter::repeat_n("d".repeat(120), 8)
        .collect::<Vec<_>>()
        .join("/");
    let nested = dir.path().join(&prefix);
    fs::create_dir_all(&nested).unwrap();
    for index in 0..100 {
        fs::write(nested.join(format!("binary-{index:03}")), [255]).unwrap();
    }
    let view = SnapshotInvestigation::prepare(&pin_snapshot(dir.path()).unwrap()).unwrap();
    let listing = view.list_files(None, 200).unwrap();
    assert!(listing.truncated);
    assert!(listing.files.len() < 100);
    assert!(serde_json::to_vec(&listing).unwrap().len() <= 64 * 1024);
    let search = view.search_files("absent", None, 200).unwrap();
    assert!(search.truncated);
    assert!(!search.skipped.is_empty());
    assert!(search.skipped.len() < 100);
    assert!(serde_json::to_vec(&search).unwrap().len() <= 64 * 1024);
    view.cleanup().unwrap();
}
