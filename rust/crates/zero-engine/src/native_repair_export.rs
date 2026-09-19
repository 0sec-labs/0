//! Offline native patch export from independently measured repair and full archive.
use super::*;
use zero_protocol::repair::RepairValidationStatus;

/// Export exact retained bytes without reopening the original checkout or applying
/// changes. This establishes neither vulnerability reportability nor deployment.
pub fn read_review_repair_patch(state: &Path, key: &str) -> Result<String, EngineError> {
    let store = Store::open_read_only(state)?;
    let view = store.native_repair_read_snapshot(key)?;
    let Reply::SourceRepair {
        operation,
        result: Some(outcome),
        ..
    } = workflow_provenance::native_repair(&view, key)?
    else {
        return Err(fail("native repair has no independently validated result"));
    };
    if operation.status != OperationStatus::Succeeded
        || outcome.status != RepairValidationStatus::ValidatedCandidateForPlan
    {
        return Err(fail(
            "patch export requires two independently validated repair matrices",
        ));
    }
    let authorization = view.native_repair_authorization(key)?;
    let original = view.native_reproduction_authorization(&authorization.reproduction_id)?;
    let captured = view
        .review_source_archive_manifest(&original.review_id)?
        .ok_or_else(|| fail("original complete source archive unavailable"))?;
    // Raw archive chunks are deliberately excluded from report read views. The
    // separately opened archive is authenticated against this exact pinned view;
    // concurrent replacement/deletion cannot substitute a different preimage.
    let archive = store
        .review_source_archive(&original.review_id)?
        .ok_or_else(|| fail("original complete source archive unavailable"))?;
    if archive.manifest != captured
        || format!(
            "sha256:{}",
            zero_plugin::sha256(&captured.canonical_bytes().map_err(fail)?)
        ) != original.archive_manifest_sha256
    {
        return Err(fail(
            "archive changed from the independently assessed source",
        ));
    }
    archive
        .validate_pin(&original.plan.snapshot)
        .map_err(fail)?;
    let request = &authorization.materialize;
    let file = archive
        .manifest
        .files
        .iter()
        .find(|file| file.path == request.target)
        .ok_or_else(|| fail("repair target absent from original complete archive"))?;
    if file.sha256 != request.expected_preimage_sha256 {
        return Err(fail("repair preimage differs from original archive"));
    }
    let capacity = usize::try_from(file.bytes).map_err(fail)?;
    let mut before = Vec::with_capacity(capacity);
    for chunk in &file.chunks {
        before.extend_from_slice(
            archive
                .blobs
                .get(&chunk.sha256)
                .ok_or_else(|| fail("original archive chunk absent"))?,
        );
    }
    if before.len() != capacity
        || format!("sha256:{}", zero_plugin::sha256(&before)) != request.expected_preimage_sha256
    {
        return Err(fail("archive preimage bytes differ from repair authority"));
    }
    let before = std::str::from_utf8(&before).map_err(fail)?;
    repair_export::patch(&request.target, before, &request.replacement)
}
fn fail(message: impl std::fmt::Display) -> EngineError {
    EngineError::State(message.to_string())
}

#[cfg(test)]
pub(crate) mod tests;
