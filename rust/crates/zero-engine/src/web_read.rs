//! Bounded read-only web presentation. No profile reload, engine owner or target I/O.
use crate::{EngineError, agent_http, agent_web};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::{collections::BTreeSet, path::Path};
use zero_protocol::{
    source::{SecurityConclusion, VerificationState},
    web::*,
};
use zero_store::Store;
fn error(message: &str) -> EngineError {
    EngineError::State(message.into())
}
pub(crate) fn http_evidence(
    store: &Store,
    session: &str,
    id: &str,
) -> Result<(HttpEvidenceMetadata, Vec<u8>), EngineError> {
    let operation = store.get_operation(id)?;
    if operation.session_id != session {
        return Err(error("HTTP evidence belongs to another session"));
    }
    let (manifest, result, body) = agent_http::checked_evidence(store, &operation)?;
    let artifacts = store.operation_artifacts(id)?;
    let response_manifest_sha256 = artifacts
        .get("http.response")
        .cloned()
        .ok_or_else(|| error("HTTP response manifest absent"))?;
    let retained_body_sha256 = manifest["body"]["sha256"]
        .as_str()
        .ok_or_else(|| error("HTTP retained body identity absent"))?
        .to_owned();
    let last = result.hops.last();
    let evidence = HttpEvidenceMetadata {
        session_id: session.into(),
        operation_id: id.into(),
        operation_status: operation.status,
        response_manifest_sha256,
        retained_body_sha256,
        retained_bytes: body.len() as u64,
        complete: operation.status == zero_protocol::OperationStatus::Succeeded
            && result.disposition == zero_http::HttpDisposition::CompleteResponse,
        url: result.response.as_ref().map(|r| r.url.clone()),
        status: result
            .response
            .as_ref()
            .map(|r| r.status)
            .or_else(|| last.and_then(|h| h.status)),
        headers: result
            .response
            .as_ref()
            .map(|r| r.headers.clone())
            .unwrap_or_default(),
        wire_bytes: result
            .response
            .as_ref()
            .map(|r| r.wire_bytes)
            .unwrap_or_else(|| last.map_or(0, |h| h.response_wire_bytes)),
        decoded_bytes: result
            .response
            .as_ref()
            .map(|r| r.decoded_bytes)
            .unwrap_or_else(|| last.map_or(0, |h| h.response_decoded_bytes)),
        artifacts,
    };
    if serde_json::to_vec(&evidence)?.len() > 1024 * 1024 {
        return Err(error("HTTP evidence metadata exceeds 1 MiB"));
    }
    Ok((evidence, body))
}
pub fn read_http_metadata(
    path: &Path,
    session: &str,
    id: &str,
) -> Result<HttpEvidenceMetadata, EngineError> {
    http_evidence(&Store::open_read_only(path)?, session, id).map(|(e, _)| e)
}
pub(crate) fn http_range(
    store: &Store,
    session: &str,
    id: &str,
    expected_manifest: &str,
    offset: u64,
    limit: u32,
) -> Result<HttpEvidenceRange, EngineError> {
    if !zero_protocol::is_sha256(expected_manifest) || !(1..=65536).contains(&limit) {
        return Err(error(
            "HTTP evidence range requires exact manifest digest and limit 1..65536",
        ));
    }
    let (evidence, body) = http_evidence(store, session, id)?;
    if evidence.response_manifest_sha256 != expected_manifest {
        return Err(error("HTTP evidence manifest changed"));
    }
    let start = usize::try_from(offset).map_err(|_| error("HTTP evidence offset out of range"))?;
    if start > body.len() {
        return Err(error("HTTP evidence offset out of range"));
    }
    let end = start.saturating_add(limit as usize).min(body.len());
    Ok(HttpEvidenceRange {
        session_id: session.into(),
        operation_id: id.into(),
        response_manifest_sha256: evidence.response_manifest_sha256,
        retained_body_sha256: evidence.retained_body_sha256,
        offset,
        total_bytes: body.len() as u64,
        data_base64: STANDARD.encode(&body[start..end]),
        next_offset: (end < body.len()).then_some(end as u64),
    })
}
pub fn read_http_range(
    path: &Path,
    session: &str,
    id: &str,
    expected_manifest: &str,
    offset: u64,
    limit: u32,
) -> Result<HttpEvidenceRange, EngineError> {
    http_range(
        &Store::open_read_only(path)?,
        session,
        id,
        expected_manifest,
        offset,
        limit,
    )
}
pub fn read_web_run(path: &Path, session: &str, id: &str) -> Result<WebRun, EngineError> {
    agent_web::load_run(&Store::open_read_only(path)?, session, id)
}
pub(crate) fn http_operations(
    store: &Store,
    session: &str,
    root: &str,
    after: u64,
    limit: u32,
) -> Result<WebHttpOperationsPage, EngineError> {
    if !(1..=32).contains(&limit) {
        return Err(error("HTTP operation page limit must be 1..32"));
    }
    agent_web::load_run(store, session, root)?;
    http_operations_validated(store, session, root, after, limit)
}
fn http_operations_validated(
    store: &Store,
    session: &str,
    root: &str,
    after: u64,
    limit: u32,
) -> Result<WebHttpOperationsPage, EngineError> {
    let candidates = store.http_operation_candidates(session, Some(after), limit)?;
    let mut page = WebHttpOperationsPage {
        operations: vec![],
        next_after_sequence: candidates.next_after_sequence,
    };
    for operation in candidates.operations {
        if agent_web::owns_evidence(store, root, &operation.operation_id)? {
            page.operations.push(operation);
        }
    }
    Ok(page)
}
pub fn read_web_http_operations(
    path: &Path,
    session: &str,
    root: &str,
    after: u64,
    limit: u32,
) -> Result<WebHttpOperationsPage, EngineError> {
    http_operations(&Store::open_read_only(path)?, session, root, after, limit)
}
pub(crate) fn workflow_report(
    store: &Store,
    session: &str,
    root: &str,
    verification_ids: &[String],
) -> Result<WebWorkflowReport, EngineError> {
    if verification_ids.len() > 32 {
        return Err(error(
            "Web report permits at most 32 explicit verification links",
        ));
    }
    let mut seen = BTreeSet::new();
    for id in verification_ids {
        if id.is_empty() || id.len() > 4096 || !seen.insert(id) {
            return Err(error("Web verification links must be bounded and unique"));
        }
    }
    let run = agent_web::load_run(store, session, root)?;
    let mut observations = vec![];
    let mut after = 0;
    let mut truncated = true;
    let mut read_bytes = 0u64;
    // At most 4096 scanned journal rows, 128 displayed observations and 64 MiB of
    // complete evidence body reads (plus one <=16 MiB sentinel), with explicit limits.
    for _ in 0..32 {
        let page = http_operations_validated(store, session, root, after, 32)?;
        let page_overflow = page.operations.len() > 128usize.saturating_sub(observations.len());
        for operation in page.operations {
            if observations.len() == 128 {
                break;
            }
            let (evidence, unavailable) = if read_bytes >= 64 * 1024 * 1024 {
                (None,Some("Evidence inspection reached the bounded report byte limit; inspect this operation separately.".into()))
            } else {
                match http_evidence(store, session, &operation.operation_id) {
                    Ok((e, body)) => {
                        read_bytes = read_bytes.saturating_add(body.len() as u64);
                        (Some(e), None)
                    }
                    Err(_) => {
                        read_bytes = read_bytes.saturating_add(16 * 1024 * 1024);
                        (None,Some("Validated retained response unavailable; inspect the operation status and retained journal.".into()))
                    }
                }
            };
            observations.push(WebReportObservation {
                operation,
                evidence,
                error: unavailable,
            });
        }
        if page_overflow {
            break;
        }
        match page.next_after_sequence {
            None => {
                truncated = false;
                break;
            }
            Some(next) if next > after => after = next,
            _ => return Err(error("HTTP observation catalog cursor did not advance")),
        }
        if observations.len() == 128 {
            break;
        }
    }
    let verifications = verification_ids
        .iter()
        .map(|id| crate::web_verification::report(store, session, root, id))
        .collect::<Result<Vec<_>, _>>()?;
    let report = WebWorkflowReport {
        schema_version: 1,
        report_kind: WebReportKind::WebObservations,
        verification_state: VerificationState::Unverified,
        security_conclusion: SecurityConclusion::NotEstablished,
        run,
        observations,
        observations_truncated: truncated,
        verifications,
    };
    if serde_json::to_vec(&report)?.len() > 16 * 1024 * 1024 {
        return Err(error("Web workflow report exceeds 16 MiB"));
    }
    Ok(report)
}
pub fn read_web_workflow_report(
    path: &Path,
    session: &str,
    root: &str,
    verification_ids: &[String],
) -> Result<WebWorkflowReport, EngineError> {
    workflow_report(
        &Store::open_read_only(path)?,
        session,
        root,
        verification_ids,
    )
}
