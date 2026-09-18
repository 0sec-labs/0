//! Terminal unverified web claims anchored to retained, independently checked HTTP bytes.
use super::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use zero_protocol::{
    Operation,
    agent::{AgentResult, AgentStatus},
    model::{Completion, CompletionStatus, Content, ResponsesRequest, ToolDefinition},
    source::VerificationState,
    web::*,
};
const MAX_ARTIFACT: usize = 4 * 1024 * 1024;
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", zero_plugin::sha256(bytes))
}
fn bytes(value: &impl serde::Serialize) -> Result<Vec<u8>, EngineError> {
    let b = serde_json::to_vec(value)?;
    if b.len() > MAX_ARTIFACT {
        return Err(error("web artifact exceeds 4 MiB"));
    }
    Ok(b)
}

pub(super) fn definition(max: u32) -> ToolDefinition {
    ToolDefinition { name:"submit_web_hypotheses".into(), description:"Finish the investigation with unverified hypotheses citing exact complete retained HTTP observation handles. Zero hypotheses does not establish safety. Citations address redacted retained bytes, not display text. This tool neither verifies a vulnerability nor authorizes any request.".into(), parameters:json!({"type":"object","properties":{"hypotheses":{"type":"array","maxItems":max,"items":{"type":"object","properties":{"title":{"type":"string","minLength":1,"maxLength":512},"category":{"type":"string","minLength":1,"maxLength":128},"explanation":{"type":"string","minLength":1,"maxLength":8192},"claimed_impact":{"type":"string","minLength":1,"maxLength":4096},"claimed_severity":{"type":"string","enum":["info","low","medium","high","critical"]},"citations":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","properties":{"operation_id":{"type":"string"},"response_manifest_sha256":{"type":"string"},"part":{"oneOf":[{"type":"object","properties":{"type":{"const":"status"}},"required":["type"],"additionalProperties":false},{"type":"object","properties":{"type":{"const":"header"},"index":{"type":"integer","minimum":0},"expected_name":{"type":"string"}},"required":["type","index","expected_name"],"additionalProperties":false},{"type":"object","properties":{"type":{"const":"body"},"offset":{"type":"integer","minimum":0},"length":{"type":"integer","minimum":1,"maximum":65536}},"required":["type","offset","length"],"additionalProperties":false}]}},"required":["operation_id","response_manifest_sha256","part"],"additionalProperties":false}}},"required":["title","category","explanation","claimed_impact","claimed_severity","citations"],"additionalProperties":false}}},"required":["hypotheses"],"additionalProperties":false}) }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Submission {
    hypotheses: Vec<WebClaim>,
}
pub(super) struct Prepared {
    request: ResponsesRequest,
    completion: Completion,
    review: WebReviewResult,
}
pub(super) struct ValidatedWebReview {
    pub operation: Operation,
    pub review: WebReviewResult,
    pub http_context: Value,
    pub artifacts: BTreeMap<String, String>,
}

/// Structural ownership is deliberately separate from complete HTTP evidence validation.
/// Joined children must appear in the exact atomically admitted group command list.
pub(super) fn owns_evidence(
    store: &Store,
    root_id: &str,
    effect_id: &str,
) -> Result<bool, EngineError> {
    let effect = store.get_operation(effect_id)?;
    if effect.payload["kind"] != "agent_http" {
        return Ok(false);
    }
    let actor_id = if effect.payload["origin"]["kind"] == "frozen_agent_experiment" {
        let (experiment, _) = web_experiment::effect_origin(store, &effect)?;
        agent_web_experiment::origin(store, &experiment)?.1.id
    } else if effect.payload.get("origin").is_some() {
        return Ok(false);
    } else {
        effect.payload["parent_operation"]
            .as_str()
            .ok_or_else(|| error("HTTP actor absent"))?
            .to_owned()
    };
    let actor = store.get_operation(&actor_id)?;
    if actor.session_id != effect.session_id
        || actor.payload["http_context"] != effect.payload["http_context"]
    {
        return Err(error("HTTP effect authority differs from actor"));
    }
    owns_actor(store, root_id, &actor_id)
}
/// Bounded actor membership without recursively re-reading its tool receipts.
pub(crate) fn owns_actor(
    store: &Store,
    root_id: &str,
    actor_id: &str,
) -> Result<bool, EngineError> {
    let actor = store.get_operation(actor_id)?;
    let mut root = store.get_operation(root_id)?;
    let session = root.session_id.clone();
    let mut seen = BTreeSet::new();
    let root_context = root.payload["http_context"].clone();
    if actor.id != root.id && actor.payload["http_context"] != root_context {
        return Ok(false);
    }
    let mut read_bytes = 0usize;
    for _ in 0..32 {
        if !seen.insert(root.id.clone())
            || root.session_id != session
            || actor.session_id != session
        {
            return Err(error("invalid web evidence ancestry"));
        }
        read_bytes = read_bytes.saturating_add(serde_json::to_vec(&root)?.len());
        if read_bytes > 64 * 1024 * 1024
            || root.payload["http_context"] != root_context
            || actor.payload["http_context"] != root_context
        {
            return Err(error("web lineage authority differs or exceeds read bound"));
        }
        let request = zero_protocol::agent::validate_actor_payload(&root.payload).map_err(error)?;
        if root.payload.get("parent_operation").is_some()
            || (request.web_submission_max_hypotheses.is_none()
                && request.web_experiment_policy.is_none())
        {
            return Err(error("not a web investigation root"));
        }
        if actor.id == root.id {
            return Ok(true);
        }
        if actor.payload["parent_operation"] == root.id {
            zero_protocol::agent::validate_actor_payload(&actor.payload).map_err(error)?;
            let group_command = actor.payload["delegation_group_command"]
                .as_str()
                .ok_or_else(|| error("joined actor group absent"))?;
            let group = store.get_operation_by_command(&session, group_command)?;
            if group.payload["kind"] != "agent_delegation"
                || group.payload["parent_operation"] != root.id
            {
                return Err(error("joined evidence group mismatch"));
            }
            // The group derives every child from the frozen role and original model task.
            if group.status == OperationStatus::Succeeded {
                agent_delegation::validate_receipt(store, &group)?;
                return Ok(true);
            }
            agent_delegation::validate_member(store, &root, &group, &actor)?;

            // Partial runs remain inspectable, but never positively citable.
            let commands = group.payload["child_commands"].as_array();
            if commands.is_some_and(|v| v.iter().any(|c| c.as_str() == Some(&actor.command_id))) {
                return Ok(true);
            }
            return Ok(false);
        }
        let Some(previous) = request.continuation_of else {
            return Ok(false);
        };
        // First request is the durable witness of the continuation and its complete history.
        let first = store.get_operation_by_command(&session, &format!("{}:model:0", root.id))?;
        let model: ResponsesRequest = serde_json::from_value(first.payload["request"].clone())?;
        agent_context::load(store, &root, &first, &model)?;
        root = store.get_operation(&previous)?;
    }
    Err(error("web ancestry exceeds 32 roots"))
}

pub(super) fn prepare(
    store: &Store,
    parent: &Operation,
    max: u32,
    request: ResponsesRequest,
    completion: Completion,
) -> Result<Prepared, EngineError> {
    validate_authority(parent)?;
    bytes(&request)?;
    bytes(&completion)?;
    if completion.status != CompletionStatus::Completed
        || completion.error.is_some()
        || completion
            .content
            .iter()
            .any(|c| matches!(c, Content::Refusal { .. }))
    {
        return Err(error(
            "web submission requires completed non-refusal evidence",
        ));
    }
    let offered: Vec<_> = request
        .tools
        .iter()
        .filter(|t| t.name == "submit_web_hypotheses")
        .collect();
    if offered.len() != 1
        || serde_json::to_value(offered[0])? != serde_json::to_value(definition(max))?
    {
        return Err(error("web submission authority changed"));
    }
    let calls: Vec<_> = completion
        .content
        .iter()
        .filter_map(|c| match c {
            Content::ToolCall {
                id,
                name,
                arguments,
            } => Some((id, name, arguments)),
            _ => None,
        })
        .collect();
    if calls.len() != 1 || calls[0].1 != "submit_web_hypotheses" {
        return Err(error("web submission must be the only final tool call"));
    }
    let submission: Submission = serde_json::from_value(calls[0].2.clone())?;
    if !(1..=32).contains(&max) || submission.hypotheses.len() > max as usize {
        return Err(error("web hypothesis count exceeds host bound"));
    }
    let mut cache =
        BTreeMap::<String, (WebEvidenceReference, zero_http::HttpResponse, Vec<u8>)>::new();
    let mut total = 0usize;
    let mut hypotheses = vec![];
    let mut unique = BTreeSet::new();
    for claim in submission.hypotheses {
        for (value, limit) in [
            (&claim.title, 512),
            (&claim.category, 128),
            (&claim.explanation, 8192),
            (&claim.claimed_impact, 4096),
        ] {
            if value.trim().is_empty() || value.len() > limit || value.contains('\0') {
                return Err(error("web claim text exceeds bounds"));
            }
        }
        if claim.citations.is_empty() || claim.citations.len() > 32 {
            return Err(error("web claim requires 1..32 citations"));
        }
        for citation in &claim.citations {
            if citation.operation_id.is_empty()
                || citation.operation_id.len() > 4096
                || !zero_protocol::is_sha256(&citation.response_manifest_sha256)
            {
                return Err(error("invalid web citation identity"));
            }
            if !cache.contains_key(&citation.operation_id) {
                if cache.len() >= 32 {
                    return Err(error("web review exceeds 32 distinct HTTP observations"));
                }
                if !owns_evidence(store, &parent.id, &citation.operation_id)? {
                    return Err(error("HTTP citation is outside this investigation"));
                }
                let effect = store.get_operation(&citation.operation_id)?;
                if effect.status != OperationStatus::Succeeded
                    || effect.payload["http_output_version"] != 2
                {
                    return Err(error("HTTP citation is not a complete v2 observation"));
                }
                let (manifest, outcome, body) = agent_http::checked_evidence(store, &effect)?;
                if outcome.disposition != zero_http::HttpDisposition::CompleteResponse {
                    return Err(error("incomplete HTTP response cannot support a claim"));
                }
                total = total
                    .checked_add(body.len())
                    .ok_or_else(|| error("web evidence size overflow"))?;
                if total > 64 * 1024 * 1024 {
                    return Err(error("web review evidence exceeds 64 MiB"));
                }
                let response = outcome
                    .response
                    .ok_or_else(|| error("HTTP response absent"))?;
                let artifact = store
                    .operation_artifacts(&effect.id)?
                    .get("http.response")
                    .cloned()
                    .ok_or_else(|| error("HTTP manifest absent"))?;
                let reference = WebEvidenceReference {
                    operation_id: effect.id,
                    response_manifest_sha256: artifact,
                    retained_body_sha256: manifest["body"]["sha256"]
                        .as_str()
                        .ok_or_else(|| error("body hash absent"))?
                        .into(),
                    retained_bytes: body.len() as u64,
                    status: response.status,
                };
                cache.insert(citation.operation_id.clone(), (reference, response, body));
            }
            let (reference, response, body) = &cache[&citation.operation_id];
            if reference.response_manifest_sha256 != citation.response_manifest_sha256 {
                return Err(error("HTTP citation manifest mismatch"));
            }
            match &citation.part {
                WebCitationPart::Status => {}
                WebCitationPart::Header {
                    index,
                    expected_name,
                } => {
                    if expected_name.is_empty()
                        || expected_name.len() > 256
                        || response.headers.get(*index as usize).map(|h| h.0.as_str())
                            != Some(expected_name)
                    {
                        return Err(error("HTTP header citation mismatch"));
                    }
                }
                WebCitationPart::Body { offset, length } => {
                    if !(1..=65536).contains(length)
                        || offset
                            .checked_add(u64::from(*length))
                            .is_none_or(|end| end > body.len() as u64)
                    {
                        return Err(error("HTTP body citation outside retained bytes"));
                    }
                }
            }
        }
        let id = digest(&bytes(
            &json!({"schema_version":1,"investigation":parent.id,"claim":claim}),
        )?);
        if !unique.insert(id.clone()) {
            return Err(error("duplicate web hypothesis"));
        }
        hypotheses.push(WebHypothesis {
            id,
            state: VerificationState::Unverified,
            claim,
        });
    }
    let review = WebReviewResult {
        schema_version: 1,
        request_sha256: digest(&bytes(&request)?),
        completion_sha256: digest(&bytes(&completion)?),
        submission_call_id: calls[0].0.clone(),
        model: request.model.clone(),
        provider_response_id: completion.response_id.clone(),
        hypotheses,
        evidence: cache.into_values().map(|v| v.0).collect(),
    };
    bytes(&review)?;
    Ok(Prepared {
        request,
        completion,
        review,
    })
}
pub(super) fn retain(
    shared: &Shared,
    parent: &str,
    inference: &str,
    prepared: Prepared,
) -> Result<WebReviewOutcome, EngineError> {
    let mut store = lock(&shared.store)?;
    let mut artifacts = BTreeMap::new();
    for (name, data) in [
        ("web.request", bytes(&prepared.request)?),
        ("web.completion", bytes(&prepared.completion)?),
        ("web.review", bytes(&prepared.review)?),
    ] {
        artifacts.insert(
            name.into(),
            store.retain_operation_artifact(parent, &shared.owner, name, &data)?,
        );
    }
    Ok(WebReviewOutcome {
        review: prepared.review,
        artifacts,
        inference_operation: inference.into(),
    })
}
pub(super) fn load(
    store: &Store,
    session: &str,
    id: &str,
) -> Result<ValidatedWebReview, EngineError> {
    let operation = store.get_operation(id)?;
    let original =
        zero_protocol::agent::validate_actor_payload(&operation.payload).map_err(error)?;
    let max = original
        .web_submission_max_hypotheses
        .ok_or_else(|| error("not a web submission actor"))?;
    if operation.session_id != session
        || operation.status != OperationStatus::Succeeded
        || operation.payload.get("parent_operation").is_some()
    {
        return Err(error(
            "web review requires a succeeded root in this session",
        ));
    }
    let result: AgentResult = serde_json::from_value(
        operation
            .outcome
            .clone()
            .ok_or_else(|| error("web outcome absent"))?,
    )?;
    if result.status != AgentStatus::Completed
        || result.error.is_some()
        || result.source_recovery_path.is_some()
    {
        return Err(error("web review did not complete"));
    }
    let outcome = result
        .web_review
        .ok_or_else(|| error("web review absent"))?;
    let artifacts = store.operation_artifacts(id)?;
    for name in ["web.request", "web.completion", "web.review"] {
        if !artifacts.contains_key(name) || artifacts.get(name) != outcome.artifacts.get(name) {
            return Err(error("web artifact identity mismatch"));
        }
    }
    let request: ResponsesRequest =
        serde_json::from_slice(&store.artifact(&artifacts["web.request"])?)?;
    let completion: Completion =
        serde_json::from_slice(&store.artifact(&artifacts["web.completion"])?)?;
    let retained: WebReviewResult =
        serde_json::from_slice(&store.artifact(&artifacts["web.review"])?)?;
    let inference = store.get_operation(&outcome.inference_operation)?;
    if inference.session_id != session
        || inference.status != OperationStatus::Succeeded
        || inference.payload["kind"] != "agent_inference"
        || inference.payload["parent_operation"] != id
        || inference.payload["request"] != serde_json::to_value(&request)?
        || inference.outcome != Some(serde_json::to_value(&completion)?)
        || request.model != original.model
    {
        return Err(error("web submission inference identity mismatch"));
    }
    inference::validate_hosted_pair(&operation.payload, &inference.payload, &request)?;
    agent_context::load(store, &operation, &inference, &request)?;
    let prepared = prepare(store, &operation, max, request, completion)?;
    if bytes(&prepared.review)? != bytes(&retained)?
        || bytes(&retained)? != bytes(&outcome.review)?
        || artifacts["web.request"] != retained.request_sha256
        || artifacts["web.completion"] != retained.completion_sha256
    {
        return Err(error("retained web submission changed"));
    }
    let http_context = operation.payload["http_context"].clone();
    Ok(ValidatedWebReview {
        operation,
        review: retained,
        http_context,
        artifacts: outcome.artifacts,
    })
}
fn validate_authority(operation: &Operation) -> Result<(), EngineError> {
    let request =
        zero_protocol::agent::validate_actor_payload(&operation.payload).map_err(error)?;
    let ctx = &operation.payload["http_context"];
    let profile: zero_protocol::http::HttpProfilePolicy =
        serde_json::from_value(ctx["profile"].clone())?;
    let profile_hash = zero_http::profile_sha256(&profile).map_err(error)?;
    let original = ctx["original_root_command"]
        .as_str()
        .ok_or_else(|| error("web account origin absent"))?;
    let account = digest(&serde_json::to_vec(
        &json!({"session_id":operation.session_id,"original_root_command":original,"profile_sha256":profile_hash}),
    )?);
    if ctx["schema_version"] != 1
        || ctx["profile_sha256"] != profile_hash
        || ctx["account_id"] != account
        || request.http_profile.as_deref() != ctx["profile_name"].as_str()
        || operation.payload["http_output_version"] != 2
        || (request.continuation_of.is_none() && original != operation.command_id)
    {
        return Err(error("web authority or account changed"));
    }
    Ok(())
}
pub(super) fn load_run(store: &Store, session: &str, id: &str) -> Result<WebRun, EngineError> {
    let operation = store.get_operation(id)?;
    validate_authority(&operation)?;
    let request =
        zero_protocol::agent::validate_actor_payload(&operation.payload).map_err(error)?;
    if operation.session_id != session
        || (request.web_submission_max_hypotheses.is_none()
            && request.web_experiment_policy.is_none())
        || operation.payload.get("parent_operation").is_some()
    {
        return Err(error("not a web investigation root in this session"));
    }
    let ctx = &operation.payload["http_context"];
    let profile: zero_protocol::http::HttpProfilePolicy =
        serde_json::from_value(ctx["profile"].clone())?;
    if zero_http::profile_sha256(&profile).map_err(error)? != ctx["profile_sha256"]
        || request.http_profile.as_deref() != ctx["profile_name"].as_str()
        || operation.payload["http_output_version"] != 2
    {
        return Err(error("web authority changed"));
    }
    let authority: WebHttpAuthority = serde_json::from_value(
        json!({"profile_name":ctx["profile_name"],"profile_sha256":ctx["profile_sha256"],"account_id":ctx["account_id"],"profile":profile}),
    )?;
    let result = match operation
        .outcome
        .clone()
        .map(serde_json::from_value::<AgentResult>)
        .transpose()
    {
        Ok(result) => result,
        Err(_) if operation.status == OperationStatus::Unknown => None,
        Err(error) => return Err(error.into()),
    };
    let review = if result.as_ref().is_some_and(|r| r.web_review.is_some()) {
        Some(load(store, session, id)?.review)
    } else {
        None
    };
    Ok(WebRun {
        session_id: session.into(),
        operation_id: id.into(),
        command_id: operation.command_id,
        operation_status: operation.status,
        agent_status: result.as_ref().map(|r| r.status.clone()),
        error: result.and_then(|r| r.error),
        authority,
        review,
        artifacts: store.operation_artifacts(id)?,
    })
}
