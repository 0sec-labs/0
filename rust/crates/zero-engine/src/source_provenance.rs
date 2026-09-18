//! Shared retained review validation for one-shot and adaptive discovery.
use super::*;
use zero_protocol::{
    agent::{AgentRequest, AgentResult, AgentStatus},
    source::{ReviewResult, SourceReviewOutcome, SourceReviewRequest},
};
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
pub(super) struct Validated {
    pub snapshot: zero_protocol::SnapshotPin,
    pub bundle: zero_source::SourceBundle,
    pub review: ReviewResult,
}
pub(super) fn load(store: &Store, session: &str, id: &str) -> Result<Validated, EngineError> {
    let op = store.get_operation(id)?;
    if op.session_id != session || op.status != OperationStatus::Succeeded {
        return Err(error("source requires a succeeded review in this session"));
    }
    let value = op
        .outcome
        .clone()
        .ok_or_else(|| error("source outcome missing"))?;
    let (snapshot, outcome, adaptive) = match op.payload["kind"].as_str() {
        Some("source_hypothesis_review") => {
            let request: SourceReviewRequest =
                serde_json::from_value(op.payload["request"].clone())?;
            (
                request.source.snapshot,
                serde_json::from_value::<SourceReviewOutcome>(value)?,
                false,
            )
        }
        Some("offline_snapshot_agent") => {
            let request: AgentRequest = serde_json::from_value(op.payload["request"].clone())?;
            let result: AgentResult = serde_json::from_value(value)?;
            if !request.source_snapshot_tools
                || request.source_submission_max_hypotheses.is_none()
                || result.status != AgentStatus::Completed
                || result.error.is_some()
                || result.source_recovery_path.is_some()
            {
                return Err(error("agent did not finish a structured source review"));
            }
            (
                request.execution.sandbox_request().snapshot,
                result
                    .source_review
                    .ok_or_else(|| error("agent source review absent"))?,
                true,
            )
        }
        _ => return Err(error("operation is not a source review")),
    };
    if outcome.error.is_some() {
        return Err(error("successful source review contradicts retained error"));
    }
    let attachments = store.operation_artifacts(id)?;
    for name in ["source.bundle", "source.review"] {
        if !attachments.contains_key(name) || attachments.get(name) != outcome.artifacts.get(name) {
            return Err(error("source artifact identity mismatch"));
        }
    }
    let bundle =
        zero_source::SourceBundle::from_bytes(&store.artifact(&attachments["source.bundle"])?)
            .map_err(error)?;
    let review: ReviewResult =
        serde_json::from_slice(&store.artifact(&attachments["source.review"])?)?;
    if bundle.digest() != attachments["source.bundle"]
        || bundle.snapshot_digest() != snapshot.digest
        || review.bundle_sha256 != *bundle.digest()
        || review.snapshot_sha256 != bundle.snapshot_digest()
        || attachments.get("source.request") != Some(&review.request_sha256)
        || attachments.get("source.completion") != Some(&review.completion_sha256)
        || serde_json::to_value(&review)?
            != serde_json::to_value(
                outcome
                    .review
                    .ok_or_else(|| error("review summary absent"))?,
            )?
    {
        return Err(error("retained source provenance mismatch"));
    }
    if adaptive {
        for name in ["source.request", "source.completion"] {
            if !attachments.contains_key(name)
                || attachments.get(name) != outcome.artifacts.get(name)
            {
                return Err(error("adaptive source artifact missing or mismatched"));
            }
        }
        let request: zero_protocol::model::ResponsesRequest =
            serde_json::from_slice(&store.artifact(&attachments["source.request"])?)?;
        let completion: zero_protocol::model::Completion =
            serde_json::from_slice(&store.artifact(&attachments["source.completion"])?)?;
        let child = store.get_operation(
            &outcome
                .inference_operation
                .ok_or_else(|| error("submission inference absent"))?,
        )?;
        if child.session_id != session
            || child.status != OperationStatus::Succeeded
            || child.payload["parent_operation"] != id
            || child.payload["kind"] != "agent_inference"
            || child.payload["request"] != serde_json::to_value(&request)?
            || child.outcome != Some(serde_json::to_value(&completion)?)
        {
            return Err(error("adaptive source inference correlation mismatch"));
        }
        let original: AgentRequest = serde_json::from_value(op.payload["request"].clone())?;
        if bundle.question() != original.prompt
            || Some(bundle.max_hypotheses()) != original.source_submission_max_hypotheses
            || request.model != original.model
        {
            return Err(error("adaptive source authority changed"));
        }
        let submission =
            zero_source::PreparedSubmission::for_request(bundle.clone(), request).map_err(error)?;
        if serde_json::to_value(submission.accept_adaptive(&completion).map_err(error)?)?
            != serde_json::to_value(&review)?
        {
            return Err(error("adaptive source submission revalidation failed"));
        }
    } else {
        for name in ["source.request", "source.completion"] {
            if !attachments.contains_key(name)
                || attachments.get(name) != outcome.artifacts.get(name)
            {
                return Err(error("dedicated source artifact missing or mismatched"));
            }
        }
        let request: zero_protocol::model::ResponsesRequest =
            serde_json::from_slice(&store.artifact(&attachments["source.request"])?)?;
        let completion: zero_protocol::model::Completion =
            serde_json::from_slice(&store.artifact(&attachments["source.completion"])?)?;
        let child = store.get_operation(
            &outcome
                .inference_operation
                .ok_or_else(|| error("submission inference absent"))?,
        )?;
        let expected_outcome = serde_json::json!({
            "completion_artifact": attachments["source.completion"],
            "usage": completion.usage,
            "usage_is_final": completion.usage_is_final,
        });
        if child.session_id != session
            || child.status != OperationStatus::Succeeded
            || child.command_id != format!("{id}:model:0")
            || child.payload["parent_operation"] != id
            || child.payload["kind"] != "source_review_inference"
            || child.payload["request_artifact"] != attachments["source.request"]
            || child.outcome != Some(expected_outcome)
            || ["endpoint", "wire_api", "rates"]
                .iter()
                .any(|key| child.payload[*key] != op.payload[*key])
        {
            return Err(error("dedicated source inference correlation mismatch"));
        }
        let original: SourceReviewRequest = serde_json::from_value(op.payload["request"].clone())?;
        let selected: std::collections::BTreeSet<_> = original
            .source
            .selected_files
            .iter()
            .map(String::as_str)
            .collect();
        let retained: std::collections::BTreeSet<_> =
            bundle.files().iter().map(|file| file.path()).collect();
        if bundle.question() != original.source.question
            || bundle.max_hypotheses() != original.source.max_hypotheses
            || selected.len() != original.source.selected_files.len()
            || selected != retained
        {
            return Err(error("dedicated source authority changed"));
        }
        let submission = zero_source::PreparedReview::from_bundle(bundle.clone())
            .request(&original.model)
            .map_err(error)?;
        if serde_json::to_value(submission.request())? != serde_json::to_value(request)? {
            return Err(error(
                "dedicated source request differs from retained source",
            ));
        }
        if serde_json::to_value(submission.accept(&completion).map_err(error)?)?
            != serde_json::to_value(&review)?
        {
            return Err(error("dedicated source submission revalidation failed"));
        }
    }
    Ok(Validated {
        snapshot,
        bundle,
        review,
    })
}

#[cfg(test)]
#[path = "source_provenance_tests.rs"]
mod tests;
