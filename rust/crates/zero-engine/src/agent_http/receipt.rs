//! Exact retained redacted bytes, independent of current profiles and target availability.
use super::*;
use zero_http::{DispatchState, HttpDisposition, HttpOutcome};
use zero_protocol::{
    Operation,
    model::{Completion, CompletionStatus, Content},
};
const CHUNK: usize = 4 * 1024 * 1024;
const BODY: usize = 16 * 1024 * 1024;
pub(super) fn status(outcome: &HttpOutcome, dispatches: &[Value]) -> OperationStatus {
    if outcome.disposition == HttpDisposition::CompleteResponse
        && outcome.dispatch == DispatchState::PossiblyDispatched
        && outcome.hops.last().is_some_and(|hop| hop.complete)
        && outcome.response.is_some()
        && !dispatches.is_empty()
        && dispatches
            .iter()
            .all(|d| d["observation"]["complete"] == true)
    {
        OperationStatus::Succeeded
    } else if outcome.dispatch == DispatchState::PossiblyDispatched || !dispatches.is_empty() {
        OperationStatus::Unknown
    } else if outcome.disposition == HttpDisposition::Cancelled {
        OperationStatus::Cancelled
    } else {
        OperationStatus::Failed
    }
}
pub(super) fn origin(
    store: &Store,
    effect: &Operation,
) -> Result<(Operation, Operation), EngineError> {
    let pair = if effect.payload.get("origin").is_some() {
        crate::web_verification::effect_origin(store, effect)?
    } else {
        model_origin(store, effect)?
    };
    let actor_version = match pair.0.payload.get("http_output_version") {
        None => 1,
        Some(v) if v == 2 => 2,
        _ => return Err(error("unsupported HTTP actor output version")),
    };
    let effect_version = match effect.payload.get("http_output_version") {
        None => 1,
        Some(v) if v == 2 => 2,
        _ => return Err(error("unsupported HTTP effect output version")),
    };
    if actor_version != effect_version {
        return Err(error("HTTP effect output version differs from owner"));
    }
    Ok(pair)
}
fn model_origin(store: &Store, effect: &Operation) -> Result<(Operation, Operation), EngineError> {
    let actor_id = effect.payload["parent_operation"]
        .as_str()
        .ok_or_else(|| error("HTTP actor absent"))?;
    let actor = store.get_operation(actor_id)?;
    let suffix = effect
        .command_id
        .strip_prefix(&format!("{actor_id}:tool:"))
        .ok_or_else(|| error("HTTP effect command differs"))?;
    let suffix = if effect.payload.get("approval_operation").is_some() {
        suffix
            .strip_suffix(":effect")
            .ok_or_else(|| error("HTTP approved command differs"))?
    } else {
        suffix
    };
    let (turn, index) = suffix
        .split_once(':')
        .ok_or_else(|| error("HTTP call position absent"))?;
    let turn = turn.parse::<u32>().map_err(error)?;
    let index = index.parse::<usize>().map_err(error)?;
    if turn >= 32 || index >= 32 || suffix != format!("{turn}:{index}") {
        return Err(error("HTTP call position invalid"));
    }
    if actor.session_id != effect.session_id
        || actor.payload.get("http_context") != effect.payload.get("http_context")
    {
        return Err(error("HTTP actor authority differs"));
    }
    let request = zero_protocol::agent::validate_actor_payload(&actor.payload).map_err(error)?;
    if request.http_profile.as_deref() != effect.payload["http_context"]["profile_name"].as_str()
        || request.http_profile.is_none()
    {
        return Err(error("HTTP was not host enabled"));
    }
    let inference =
        store.get_operation_by_command(&effect.session_id, &format!("{actor_id}:model:{turn}"))?;
    if inference.status != OperationStatus::Succeeded
        || inference.payload["kind"] != "agent_inference"
        || inference.payload["parent_operation"] != actor_id
    {
        return Err(error("HTTP origin is not a completed owned inference"));
    }
    let completion: Completion = serde_json::from_value(
        inference
            .outcome
            .clone()
            .ok_or_else(|| error("HTTP origin completion absent"))?,
    )?;
    if completion.status != CompletionStatus::Completed || completion.error.is_some() {
        return Err(error("HTTP origin was incomplete"));
    }
    let calls = completion
        .content
        .iter()
        .filter_map(|c| {
            if let Content::ToolCall {
                id,
                name,
                arguments,
            } = c
            {
                Some((id, name, arguments))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    if calls.len() > 32
        || calls
            .iter()
            .map(|c| c.0)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != calls.len()
    {
        return Err(error("HTTP origin call identities invalid"));
    }
    let (call, name, args) = calls
        .get(index)
        .ok_or_else(|| error("HTTP original call absent"))?;
    if *name != "http_request" || effect.payload["call_id"] != **call {
        return Err(error("HTTP original call identity differs"));
    }
    let tools: Vec<ToolDefinition> =
        serde_json::from_value(inference.payload["request"]["tools"].clone())?;
    let offered = tools
        .iter()
        .filter(|t| t.name == "http_request")
        .collect::<Vec<_>>();
    if offered.len() != 1
        || serde_json::to_value(offered[0])? != serde_json::to_value(definition())?
    {
        return Err(error("HTTP tool was not uniquely offered"));
    }
    let policy: zero_protocol::http::HttpProfilePolicy =
        serde_json::from_value(effect.payload["http_context"]["profile"].clone())?;
    let context = &effect.payload["http_context"];
    let normalized = zero_http::normalize_policy(policy.clone()).map_err(error)?;
    let digest = hash(&serde_json::to_value(&normalized)?)?;
    let command = context["original_root_command"]
        .as_str()
        .ok_or_else(|| error("HTTP account origin missing"))?;
    let expected = json!({"schema_version":1,"profile_name":request.http_profile,"profile":normalized,"profile_sha256":digest,"account_id":hash(&json!({"session_id":effect.session_id,"original_root_command":command,"profile_sha256":digest}))?,"original_root_command":command});
    if *context != expected {
        return Err(error("HTTP captured profile/account identity differs"));
    }
    let root = store.get_operation_by_command(&effect.session_id, command)?;
    if root.payload.get("http_context") != Some(context)
        || root.payload.get("parent_operation").is_some()
        || root.payload["request"].get("continuation_of").is_some()
    {
        return Err(error("HTTP account does not belong to initial root"));
    }
    let intent = zero_http::normalize_intent(&policy, serde_json::from_value((*args).clone())?)
        .map_err(error)?;
    if effect.payload["request"] != serde_json::to_value(intent)? {
        return Err(error("HTTP request differs from normalized original call"));
    }
    Ok((actor, inference))
}
pub(super) fn retain(
    store: &mut Store,
    effect: &Operation,
    owner: &str,
    mut outcome: HttpOutcome,
    dispatches: &[Value],
) -> Result<Value, EngineError> {
    let (actor, inference) = origin(store, effect)?;
    let body = outcome
        .response
        .as_mut()
        .map(|r| std::mem::take(&mut r.body))
        .unwrap_or_default();
    if body.len() > BODY {
        return Err(error("redacted HTTP evidence exceeds retained body bound"));
    }
    let mut chunks = vec![];
    for (i, bytes) in body.chunks(CHUNK).enumerate() {
        let name = format!("http.response.body.{i}");
        let digest = store.retain_operation_artifact(&effect.id, owner, &name, bytes)?;
        chunks.push(json!({"name":name,"digest":digest,"bytes":bytes.len()}));
    }
    let attachments = store.operation_artifacts(&effect.id)?;
    let request = attachments
        .get("http.request")
        .ok_or_else(|| error("retained HTTP request missing"))?;
    let manifest = json!({"schema_version":1,"effect_operation_id":effect.id,"effect_payload_sha256":hash(&effect.payload)?,"actor_payload_sha256":hash(&actor.payload)?,"origin_payload_sha256":hash(&inference.payload)?,"origin_outcome_sha256":hash(&inference.outcome)?,"request_sha256":request,"dispatches_sha256":hash(&dispatches)?,"outcome":outcome,"body":{"bytes":body.len(),"sha256":format!("sha256:{}",zero_plugin::sha256(&body)),"chunks":chunks}});
    let digest = store.retain_operation_artifact(
        &effect.id,
        owner,
        "http.response",
        &serde_json::to_vec(&manifest)?,
    )?;
    Ok(
        json!({"schema_version":1,"http_response_artifact":digest,"http_request_artifact":request,"account_id":effect.payload["http_context"]["account_id"],"profile_sha256":effect.payload["http_context"]["profile_sha256"],"dispatch":outcome.dispatch,"disposition":outcome.disposition,"error":outcome.error}),
    )
}
pub(crate) fn load(
    store: &Store,
    effect: &Operation,
) -> Result<(Value, HttpOutcome, Vec<u8>), EngineError> {
    if effect.payload["kind"] != "agent_http" {
        return Err(error("not a native HTTP effect"));
    }
    let (actor, inference) = origin(store, effect)?;
    let attachments = store.operation_artifacts(&effect.id)?;
    let outcome = effect
        .outcome
        .as_ref()
        .ok_or_else(|| error("HTTP evidence is not retained; operation may be uncertain"))?;
    let manifest_hash = outcome["http_response_artifact"]
        .as_str()
        .ok_or_else(|| error("HTTP response manifest missing"))?;
    if attachments.get("http.response").map(String::as_str) != Some(manifest_hash) {
        return Err(error("HTTP response attachment changed"));
    }
    let bytes = store.artifact(manifest_hash)?;
    if bytes.len() > 1024 * 1024 {
        return Err(error("HTTP metadata exceeds bound"));
    }
    let manifest: Value = serde_json::from_slice(&bytes)?;
    let request = manifest["request_sha256"]
        .as_str()
        .ok_or_else(|| error("HTTP request hash absent"))?;
    if attachments.get("http.request").map(String::as_str) != Some(request)
        || outcome["http_request_artifact"] != request
        || serde_json::from_slice::<Value>(&store.artifact(request)?)? != effect.payload["request"]
    {
        return Err(error("HTTP request evidence differs"));
    }
    let dispatches = store.read_http_dispatches(&effect.session_id, &effect.id)?;
    if manifest["effect_operation_id"] != effect.id
        || manifest["effect_payload_sha256"] != hash(&effect.payload)?
        || manifest["actor_payload_sha256"] != hash(&actor.payload)?
        || manifest["origin_payload_sha256"] != hash(&inference.payload)?
        || manifest["origin_outcome_sha256"] != hash(&inference.outcome)?
        || manifest["dispatches_sha256"] != hash(&dispatches)?
    {
        return Err(error("HTTP evidence provenance differs"));
    }
    let result: HttpOutcome = serde_json::from_value(manifest["outcome"].clone())?;
    if outcome["account_id"] != effect.payload["http_context"]["account_id"]
        || outcome["profile_sha256"] != effect.payload["http_context"]["profile_sha256"]
        || outcome["error"] != serde_json::to_value(result.error)?
    {
        return Err(error("HTTP compact outcome differs from evidence"));
    }
    if let Some(response) = &result.response {
        let last = dispatches
            .last()
            .ok_or_else(|| error("HTTP response without dispatch"))?;
        if last["intent"]["url"] != response.url
            || last["observation"]["status"] != response.status
            || last["observation"]["response_wire_bytes"] != response.wire_bytes
            || last["observation"]["response_decoded_bytes"] != response.decoded_bytes
        {
            return Err(error("HTTP response metadata differs from final hop"));
        }
    }

    if result.hops.len() > 6 || result.hops.len() > dispatches.len() {
        return Err(error("HTTP hop receipt count differs"));
    }
    for (index, hop) in result.hops.iter().enumerate() {
        let witness = &dispatches[index];
        if witness["id"] != hop.permit.id
            || witness["hop_index"] != index
            || (witness["observation"] != serde_json::to_value(hop)?
                && !(effect.status == OperationStatus::Unknown
                    && !hop.complete
                    && witness["observation"].is_null()
                    && witness["charged_response_decoded_bytes"].is_null()))
        {
            return Err(error(
                "HTTP hop observation differs from durable accounting",
            ));
        }
    }
    if result.disposition == HttpDisposition::CompleteResponse
        && (result.hops.len() != dispatches.len()
            || result.hops.last().and_then(|h| h.status)
                != result.response.as_ref().map(|r| r.status))
    {
        return Err(error(
            "HTTP response has no complete final dispatch witness",
        ));
    }

    if result.response.as_ref().is_some_and(|r| !r.body.is_empty())
        || status(&result, &dispatches) != effect.status
        || outcome["dispatch"] != serde_json::to_value(&result.dispatch)?
        || outcome["disposition"] != serde_json::to_value(&result.disposition)?
    {
        return Err(error("HTTP terminal state contradicts evidence"));
    }
    let chunks = manifest["body"]["chunks"]
        .as_array()
        .filter(|c| c.len() <= 4)
        .ok_or_else(|| error("HTTP chunks exceed bound"))?;
    let mut body = vec![];
    for (index, chunk) in chunks.iter().enumerate() {
        let name = format!("http.response.body.{index}");
        let digest = chunk["digest"]
            .as_str()
            .ok_or_else(|| error("HTTP chunk hash absent"))?;
        if chunk["name"] != name || attachments.get(&name).map(String::as_str) != Some(digest) {
            return Err(error("HTTP chunk attachment differs"));
        }
        let bytes = store.artifact(digest)?;
        if bytes.len() > CHUNK || chunk["bytes"] != bytes.len() || body.len() + bytes.len() > BODY {
            return Err(error("HTTP chunk length differs"));
        }
        body.extend(bytes);
    }
    if manifest["body"]["bytes"] != body.len()
        || manifest["body"]["sha256"] != format!("sha256:{}", zero_plugin::sha256(&body))
    {
        return Err(error("HTTP retained body identity differs"));
    }
    if result
        .response
        .as_ref()
        .is_some_and(|r| r.redacted_bytes != body.len() as u64)
        || result.response.is_none() && !body.is_empty()
    {
        return Err(error("HTTP body metadata differs"));
    }
    Ok((manifest, result, body))
}
pub(crate) fn validate_receipt(store: &Store, effect: &Operation) -> Result<String, EngineError> {
    let (manifest, outcome, body) = load(store, effect)?;
    if !matches!(
        effect.status,
        OperationStatus::Succeeded | OperationStatus::Failed
    ) {
        return Err(error(
            "uncertain or cancelled HTTP effect cannot become tool output",
        ));
    }
    let mut text = String::from_utf8_lossy(&body)
        .chars()
        .take(10000)
        .collect::<String>();
    let truncated = String::from_utf8_lossy(&body).chars().count() > 10000;
    if outcome.response.is_none() {
        text.clear();
    }
    let mut output = json!({"untrusted_http_data":true,"disposition":outcome.disposition,"response":outcome.response.as_ref().map(|r|json!({"url":r.url,"status":r.status,"headers":r.headers,"body_text":text,"body_display_truncated":truncated,"retained_redacted_body_sha256":manifest["body"]["sha256"],"decoded_bytes":r.decoded_bytes})),"error":outcome.error});
    if effect.payload["http_output_version"] == 2 {
        output["observation"] = json!({"operation_id":effect.id,"response_manifest_sha256":effect.outcome.as_ref().and_then(|v|v.get("http_response_artifact")),"retained_body_sha256":manifest["body"]["sha256"],"retained_bytes":manifest["body"]["bytes"],"completeness":if effect.status==OperationStatus::Succeeded&&outcome.disposition==HttpDisposition::CompleteResponse{"complete"}else{"incomplete"}});
    }
    Ok(serde_json::to_string(&output)?)
}
