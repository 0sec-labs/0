//! Offline native patch export from independently measured repair and full archive.
use super::*;
use zero_protocol::repair::RepairValidationStatus;

use zero_protocol::source_archive::SourceArchive;

/// Independently checked retained repair, ready for explicit offline publication.
/// Publishing or applying it does not certify general repair safety.
pub struct RepairArchiveExport {
    pub baseline: SourceArchive,
    pub current: SourceArchive,
    pub bundle: serde_json::Value,
}
struct RetainedRepair {
    baseline: SourceArchive,
    request: zero_protocol::repair::MaterializeRequest,
    session: String,
    operation: String,
    result: serde_json::Value,
}

pub fn read_review_repair_patch(state: &Path, key: &str) -> Result<String, EngineError> {
    let retained = read_retained(state, key)?;
    let before =
        zero_workspace::bytes(&retained.baseline, &retained.request.target).map_err(fail)?;
    repair_export::patch(
        &retained.request.target,
        std::str::from_utf8(&before).map_err(fail)?,
        &retained.request.replacement,
    )
}

/// Produce complete baseline/candidate archives from the exact independently
/// validated replacement, without reading or changing the user's checkout.
pub fn read_review_repair_bundle(
    state: &Path,
    key: &str,
) -> Result<RepairArchiveExport, EngineError> {
    use zero_protocol::workspace_edit::{EditablePath, WorkspaceCall, WorkspacePolicy};
    let retained = read_retained(state, key)?;
    let request = &retained.request;
    let file = retained
        .baseline
        .manifest
        .files
        .iter()
        .find(|f| f.path == request.target)
        .ok_or_else(|| fail("repair target absent"))?;
    let policy = WorkspacePolicy {
        paths: vec![EditablePath {
            path: request.target.clone(),
            baseline_sha256: Some(request.expected_preimage_sha256.clone()),
            executable: file.executable,
        }],
        max_edits: 1,
        max_changed_bytes: 8 * 1024 * 1024,
        max_test_runs: 1,
        deadline_ms: 100,
    };
    zero_workspace::validate_baseline(&retained.baseline, &policy).map_err(fail)?;
    let baseline_generation = zero_workspace::generation(&retained.baseline).map_err(fail)?;
    let transition = zero_workspace::propose(
        &retained.baseline,
        &policy,
        &WorkspaceCall::Write {
            path: request.target.clone(),
            expected_generation: baseline_generation.clone(),
            content: request.replacement.clone(),
        },
    )
    .map_err(fail)?;
    if transition.receipt.changes.len() != 1 {
        return Err(fail("repair has no single changed path"));
    }
    let current = transition.archive;
    let bundle = serde_json::json!({"schema_version":1,"assessment":"unverified","session_id":retained.session,"operation_id":retained.operation,"actor_status":OperationStatus::Succeeded,
      "baseline_generation":baseline_generation,"final_generation":zero_workspace::generation(&current).map_err(fail)?,
      "baseline":retained.baseline.manifest,"current":current.manifest,"policy":{"paths":policy.paths},"changes":transition.receipt.changes,
      "edit_and_test_receipts":[{"kind":"validated_repair_export","repair_id":key,"assessment":"unverified","transition":transition.receipt}],
      "tests":[{"kind":"native_repair","repair_id":key,"result":retained.result,"scope":"frozen host plan only"}],"host_apply":"not_performed"});
    Ok(RepairArchiveExport {
        baseline: retained.baseline,
        current,
        bundle,
    })
}
fn read_retained(state: &Path, key: &str) -> Result<RetainedRepair, EngineError> {
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
    std::str::from_utf8(&before).map_err(fail)?;
    Ok(RetainedRepair {
        baseline: archive,
        request: request.clone(),
        session: operation.session_id,
        operation: operation.id,
        result: serde_json::to_value(outcome)?,
    })
}
fn fail(message: impl std::fmt::Display) -> EngineError {
    EngineError::State(message.to_string())
}

#[cfg(test)]
pub(crate) mod tests;
