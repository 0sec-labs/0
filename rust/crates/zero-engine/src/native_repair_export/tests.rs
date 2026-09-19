use super::*;

/// Called by the real native repair fixture after both fresh matrices complete.
/// Each corrupt copy is private; the running Engine's database is never mutated.
pub(crate) fn assert_retained_provenance(state: &Path, key: &str) {
    let original = Store::open_read_only(state).unwrap();
    let record = original.native_repair(key).unwrap().record;
    let authorization = original.native_repair_authorization(key).unwrap();
    let reproduction = original
        .native_reproduction_authorization(&authorization.reproduction_id)
        .unwrap();
    let archive = original
        .review_source_archive(&reproduction.review_id)
        .unwrap()
        .unwrap();
    let patch = read_review_repair_patch(state, key).unwrap();
    assert!(patch.starts_with(&format!(
        "--- a/{}\t\n+++ b/{}\t\n",
        authorization.materialize.target, authorization.materialize.target
    )));
    let file = archive
        .manifest
        .files
        .iter()
        .find(|f| f.path == authorization.materialize.target)
        .unwrap();
    let before: Vec<u8> = file
        .chunks
        .iter()
        .flat_map(|c| archive.blobs[&c.sha256].clone())
        .collect();
    let tree = tempfile::tempdir().unwrap();
    let target = tree.path().join(&file.path);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, before).unwrap();
    let patch_path = tree.path().join("change.patch");
    std::fs::write(&patch_path, &patch).unwrap();
    let applied = std::process::Command::new("patch")
        .current_dir(tree.path())
        .args(["--batch", "-p1", "-i"])
        .arg(&patch_path)
        .output()
        .unwrap();
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    assert_eq!(
        std::fs::read(&target).unwrap(),
        authorization.materialize.replacement.as_bytes()
    );

    for missing in [
        "candidate.assessment",
        "reconstructed.evidence_index",
        "repair.validation_summary",
        "native_repair.source_binding",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = copy(state, dir.path());
        let connection = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .execute(
                    "DELETE FROM operation_artifacts WHERE operation_id=?1 AND name=?2",
                    rusqlite::params![record.operation_id, missing]
                )
                .unwrap(),
            1
        );
        drop(connection);
        assert!(
            crate::native_repair::read_review_repair(&path, key).is_err(),
            "missing {missing}"
        );
        assert!(read_review_repair_patch(&path, key).is_err());
    }
    let dir = tempfile::tempdir().unwrap();
    let path = copy(state, dir.path());
    let connection = rusqlite::Connection::open(&path).unwrap();
    assert!(connection.execute("DELETE FROM operation_artifacts WHERE name='native_repair.effect_start' AND operation_id IN (SELECT id FROM operations WHERE session_id=?1)", [&record.session_id]).unwrap() > 0);
    drop(connection);
    assert!(crate::native_repair::read_review_repair(&path, key).is_err());

    // Reports deliberately exclude raw source archives; only patch export needs
    // complete retained preimages. Corrupt a real original chunk, leaving all
    // journal, manifests and observation evidence unchanged.
    if let Some(chunk) = file.chunks.first() {
        let dir = tempfile::tempdir().unwrap();
        let path = copy(state, dir.path());
        let connection = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .execute(
                    "UPDATE artifacts SET bytes=x'00' WHERE digest=?1",
                    [&chunk.sha256]
                )
                .unwrap(),
            1
        );
        drop(connection);
        assert!(crate::native_repair::read_review_repair(&path, key).is_ok());
        assert!(read_review_repair_patch(&path, key).is_err());
    }
}
fn copy(state: &Path, directory: &Path) -> std::path::PathBuf {
    let path = directory.join("state.db");
    rusqlite::Connection::open(state)
        .unwrap()
        .execute("VACUUM INTO ?1", [path.to_str().unwrap()])
        .unwrap();
    path
}
