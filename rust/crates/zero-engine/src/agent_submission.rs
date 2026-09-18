//! Structured terminal submission binds exact private bytes and actual provider evidence.
use super::*;
use serde::Deserialize;
use zero_protocol::{
    model::{Completion, Content, ResponsesRequest},
    source::{Claim, SourceReviewOutcome},
};
use zero_source::{PreparedSubmission, SourceBundle};
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    selected_files: Vec<String>,
    hypotheses: Vec<Claim>,
}
pub(super) struct Prepared {
    submission: PreparedSubmission,
    completion: Completion,
    review: zero_protocol::source::ReviewResult,
}
pub(super) fn prepare(
    context: &agent_source::Context,
    question: &str,
    max: u32,
    request: ResponsesRequest,
    completion: Completion,
) -> Result<Prepared, EngineError> {
    let agent_source::Context::Snapshot(snapshot) = context else {
        return Err(error("submission requires private snapshot authority"));
    };
    let calls: Vec<_> = completion
        .content
        .iter()
        .filter_map(|c| match c {
            Content::ToolCall {
                name, arguments, ..
            } => Some((name, arguments)),
            _ => None,
        })
        .collect();
    if calls.len() != 1 || calls[0].0 != "submit_source_hypotheses" {
        return Err(error("submission must be the only final tool call"));
    }
    let selection: Selection = serde_json::from_value(calls[0].1.clone())?;
    if selection.hypotheses.len() > max as usize {
        return Err(error("hypothesis count exceeds host bound"));
    }
    let bundle: SourceBundle = snapshot
        .selected_bundle(&selection.selected_files, question, max)
        .map_err(error)?;
    let submission = PreparedSubmission::for_request(bundle, request).map_err(error)?;
    let review = submission.accept_adaptive(&completion).map_err(error)?;
    Ok(Prepared {
        submission,
        completion,
        review,
    })
}
pub(super) fn retain(
    shared: &Shared,
    parent: &str,
    inference: &str,
    prepared: Prepared,
) -> Result<SourceReviewOutcome, EngineError> {
    let items = [
        (
            "source.bundle",
            prepared.submission.bundle().to_bytes().map_err(error)?,
        ),
        (
            "source.request",
            prepared.submission.request_bytes().map_err(error)?,
        ),
        (
            "source.completion",
            serde_json::to_vec(&prepared.completion)?,
        ),
        (
            "source.review",
            zero_source::review_result_bytes(&prepared.review).map_err(error)?,
        ),
    ];
    let mut artifacts = std::collections::BTreeMap::new();
    let mut store = lock(&shared.store)?;
    for (name, bytes) in items {
        let digest = store.retain_operation_artifact(parent, &shared.owner, name, &bytes)?;
        artifacts.insert(name.into(), digest);
    }
    Ok(SourceReviewOutcome {
        review: Some(prepared.review),
        artifacts,
        inference_operation: Some(inference.into()),
        external_effects_started: true,
        error: None,
    })
}
