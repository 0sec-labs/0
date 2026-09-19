//! Archive-backed reproduction preparation and read-only source binding checks.
//!
//! Preparation is not an execution permit. The native workflow must separately
//! admit host authority, retain the binding, and gate each sandbox dispatch. No
//! provider or sandbox is invoked here. Run preparation on a joined blocking
//! worker; the owner supplies cancellation/deadline checks and explicitly removes
//! the private stage only after any guest using it has drained.
use crate::{EngineError, source_provenance};
use zero_executor::StagedSnapshot;
use zero_protocol::{
    OperationStatus,
    review::ReviewRecord,
    review_reproduction::{ReviewReproductionBinding, ReviewReproductionPlan},
};
use zero_store::Store;
use zero_verification::FrozenPlan;

fn error(value: impl std::fmt::Display) -> EngineError {
    EngineError::State(value.to_string())
}
fn manifest_digest(
    manifest: &zero_protocol::source_archive::ArchiveManifest,
) -> Result<String, EngineError> {
    Ok(format!(
        "sha256:{}",
        zero_plugin::sha256(&manifest.canonical_bytes().map_err(error)?)
    ))
}
fn source(
    store: &Store,
    authorization: &ReviewReproductionPlan,
) -> Result<(ReviewRecord, FrozenPlan), EngineError> {
    authorization.validate_envelope().map_err(error)?;
    let logical = FrozenPlan::new(authorization.plan.clone()).map_err(error)?;
    let status = store.review_snapshot(&authorization.review_id)?;
    let record = status.review;
    if record.root_operation_id != authorization.source_operation_id
        || matches!(
            status.controller_status,
            OperationStatus::Admitted | OperationStatus::Running
        )
        || status.root_status != OperationStatus::Succeeded
    {
        return Err(error(
            "reproduction requires the exact drained review and succeeded source root",
        ));
    }
    let source = source_provenance::load(store, &record.session_id, &record.root_operation_id)?;
    if serde_json::to_value(&source.snapshot)? != serde_json::to_value(&logical.plan().snapshot)?
        || source.bundle.digest() != logical.plan().source_bundle_digest
        || !source
            .review
            .hypotheses
            .iter()
            .any(|h| h.id == logical.plan().hypothesis_id)
    {
        return Err(error(
            "reproduction logical plan differs from retained source provenance",
        ));
    }
    Ok((record, logical))
}
fn binding(
    record: &ReviewRecord,
    authorization: &ReviewReproductionPlan,
    logical: &FrozenPlan,
    execution: &FrozenPlan,
) -> Result<ReviewReproductionBinding, EngineError> {
    Ok(ReviewReproductionBinding {
        schema_version: 1,
        authorization_sha256: format!(
            "sha256:{}",
            zero_plugin::sha256(&serde_json::to_vec(&serde_json::to_value(authorization)?)?)
        ),
        review_id: record.id.clone(),
        source_session_id: record.session_id.clone(),
        source_operation_id: record.root_operation_id.clone(),
        archive_manifest_sha256: authorization.archive_manifest_sha256.clone(),
        logical_plan_sha256: logical.digest().into(),
        execution_plan_sha256: execution.digest().into(),
    })
}

/// A verified private source tree and two distinct frozen plan identities.
/// Dropping this value deliberately retains the stage, as with StagedSnapshot.
/// This type does not grant permission to execute its plan.
pub struct PreparedReviewReproduction {
    stage: StagedSnapshot,
    logical: FrozenPlan,
    execution: FrozenPlan,
    binding: ReviewReproductionBinding,
}
impl PreparedReviewReproduction {
    pub fn logical_plan(&self) -> &FrozenPlan {
        &self.logical
    }
    pub fn execution_plan(&self) -> &FrozenPlan {
        &self.execution
    }
    pub fn binding(&self) -> &ReviewReproductionBinding {
        &self.binding
    }
    /// Call only after all consumers and any guest using this tree have drained.
    pub fn remove(self) -> Result<(), EngineError> {
        self.stage.remove().map_err(error)
    }
}

/// Resolve the original review and reconstruct its complete retained source.
/// Never reads the original source directory. The callback is checked around
/// Store reads and through archive validation, reconstruction and hashing; an
/// individual synchronous SQLite read is not interruptible and must be drained.
pub fn prepare(
    store: &Store,
    authorization: &ReviewReproductionPlan,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<PreparedReviewReproduction, EngineError> {
    check().map_err(error)?;
    let (record, logical) = source(store, authorization)?;
    check().map_err(error)?;
    let archive = store
        .review_source_archive(&record.id)?
        .ok_or_else(|| error("review has no retained complete source archive"))?;
    check().map_err(error)?;
    if manifest_digest(&archive.manifest)? != authorization.archive_manifest_sha256 {
        return Err(error(
            "reproduction archive identity differs from host authorization",
        ));
    }
    archive
        .validate_pin_checked(&logical.plan().snapshot, check)
        .map_err(error)?;
    let mut binding = binding(&record, authorization, &logical, &logical)?;
    let (stage, pin) = zero_executor::stage_source_archive(&archive, check).map_err(error)?;
    let execution = match check().map_err(error).and_then(|_| {
        let execution = logical.reanchor_snapshot(&pin).map_err(error)?;
        check().map_err(error)?;
        Ok(execution)
    }) {
        Ok(execution) => execution,
        Err(cause) => {
            return match stage.remove() {
                Ok(()) => Err(cause),
                Err(cleanup) => Err(error(format!(
                    "{cause}; private source cleanup failed: {cleanup}"
                ))),
            };
        }
    };
    binding.execution_plan_sha256 = execution.digest().into();
    Ok(PreparedReviewReproduction {
        stage,
        logical,
        execution,
        binding,
    })
}

/// Revalidate the recorded logical→execution relation without filesystem access
/// or raw source blobs. This checks source identity, not observation success or
/// durable dispatch authority; the workflow must also re-assess its journal.
pub fn validate_binding(
    store: &Store,
    authorization: &ReviewReproductionPlan,
    execution: &FrozenPlan,
    retained: &ReviewReproductionBinding,
) -> Result<(), EngineError> {
    let (record, logical) = source(store, authorization)?;
    let manifest = store
        .review_source_archive_manifest(&record.id)?
        .ok_or_else(|| error("review has no retained complete source archive"))?;
    if manifest_digest(&manifest)? != authorization.archive_manifest_sha256 {
        return Err(error(
            "reproduction archive identity differs from host authorization",
        ));
    }
    logical.validate_reanchored(execution).map_err(error)?;
    if *retained != binding(&record, authorization, &logical, execution)? {
        return Err(error("reproduction retained source binding differs"));
    }
    Ok(())
}
