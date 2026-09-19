//! Durable local-review identity and frozen source/inference/sandbox authority.
use crate::{
    Error, Operation, OperationStatus, Result, Store, append, integer,
    workflow::{self, Reader},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use zero_protocol::{SnapshotPin, campaign::CampaignProviderContext, review::*};
mod acquisition;
mod hooks;
mod read;
pub(crate) fn snapshot_source_record(conn: &Connection, key: &str) -> Result<ReviewRecord> {
    Ok(read::bound(conn, key, &mut Reader::new())?.record)
}
pub(crate) use hooks::archive_binding;
pub(crate) use hooks::{authorize, budget_denied, guard_begin, guard_owner, guard_reservation};
pub(crate) struct ArchiveBinding {
    pub review: ReviewRecord,
    pub snapshot: SnapshotPin,
    pub owner: String,
    pub preparation_sequence: u64,
    pub acquisition_receipt: Option<zero_protocol::source_acquisition::AcquisitionReceiptInput>,
}
const MAX_INTENT_BYTES: usize = 2 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewAdmission {
    pub review_id: String,
    pub session_id: String,
    pub controller_operation_id: String,
    pub root_operation_id: String,
    pub input_path: String,
    pub canonical_path: String,
    pub profile_name: String,
    pub profile: ReviewProfile,
    pub snapshot: SnapshotPin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_selection: Option<zero_protocol::workspace::WorkspaceSelectionReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acquisition_receipt: Option<zero_protocol::source_acquisition::AcquisitionReceiptInput>,
    pub root_payload: Value,
    pub provider_context: BTreeMap<String, CampaignProviderContext>,
}
pub struct AdmittedReview {
    pub review: ReviewRecord,
    pub controller: Operation,
    pub root: Operation,
    pub duplicate: bool,
}
fn bad(s: impl std::fmt::Display) -> Error {
    Error::Conflict(format!("review: {s}"))
}
fn encode(v: &impl Serialize) -> Result<String> {
    Ok(serde_json::to_string(&serde_json::to_value(v)?)?)
}
fn hash(v: &impl Serialize) -> Result<String> {
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(encode(v)?.as_bytes())
    ))
}
fn now() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(bad)?
        .as_millis()
        .try_into()
        .map_err(bad)
}
fn id(v: &str) -> Result<()> {
    if v.is_empty() || v.len() > 256 || v.contains('\0') {
        Err(bad("identifier bounds"))
    } else {
        Ok(())
    }
}
fn epoch(conn: &Connection, owner: &str) -> Result<()> {
    let actual:Option<String>=conn.query_row("SELECT CASE WHEN length(CAST(owner AS BLOB))<=4096 THEN owner END FROM engine_epoch WHERE singleton=1",[],|r|r.get(0)).optional()?;
    if actual.as_deref() != Some(owner) {
        return Err(bad("owner epoch differs"));
    }
    Ok(())
}
fn context(r: &ReviewRecord) -> Value {
    json!({"schema_version":1,"review_id":r.id,"intent_sha256":r.intent_sha256,"deadline_at_ms":r.deadline_at_ms})
}
fn intent(a: &ReviewAdmission, command: &str, created: u64, deadline: u64) -> Value {
    json!({"schema_version":1,"kind":"native_review_intent","command_id":command,"created_at_ms":created,"deadline_at_ms":deadline,"admission":a})
}
fn validate(a: &ReviewAdmission) -> Result<()> {
    let ids = [
        &a.review_id,
        &a.session_id,
        &a.controller_operation_id,
        &a.root_operation_id,
    ];
    for key in ids {
        uuid::Uuid::parse_str(key).map_err(bad)?;
    }
    if ids.into_iter().collect::<BTreeSet<_>>().len() != 4
        || a.input_path.is_empty()
        || a.input_path.len() > 8192
        || a.input_path.contains('\0')
        || a.canonical_path.len() > 8192
        || a.canonical_path != a.snapshot.root
        || a.profile_name.is_empty()
        || a.profile_name.len() > 128
        || !a
            .profile_name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        || a.provider_context.len() > 9
        || encode(a)?.len() > MAX_INTENT_BYTES - 1024
    {
        return Err(bad("admission identity or intent bounds"));
    }
    integer(a.profile.budget_limit)?;
    if let Some(selection) = &a.workspace_selection {
        selection.validate_pin(&a.snapshot).map_err(bad)?;
    }
    if let Some(acquisition) = &a.acquisition_receipt {
        acquisition
            .validate_capture(
                &a.snapshot,
                a.workspace_selection
                    .as_ref()
                    .map_or(a.canonical_path.as_str(), |s| s.original_root.as_str()),
            )
            .map_err(bad)?;
    }
    let expected = a
        .profile
        .request_with_selection(
            a.snapshot.clone(),
            &a.root_operation_id,
            a.workspace_selection.as_ref(),
        )
        .map_err(bad)?;
    let request = zero_protocol::agent::validate_actor_payload(&a.root_payload).map_err(bad)?;
    if serde_json::to_value(&expected)? != serde_json::to_value(&request)? {
        return Err(bad("root bypasses frozen review request"));
    }
    // Capture only fields produced by prepare_actor plus its exact review template.
    let allowed = [
        "kind",
        "request",
        "endpoint",
        "rates",
        "wire_api",
        "hosted_catalog",
        "delegation_context",
        "context_template",
        "review_template",
    ];
    if a.root_payload
        .as_object()
        .is_none_or(|m| m.keys().any(|k| !allowed.contains(&k.as_str())))
    {
        return Err(bad("unexpected root authority"));
    }
    let template: zero_protocol::model::ResponsesRequest =
        serde_json::from_value(a.root_payload["review_template"].clone())?;
    if template.model != request.model
        || template.instructions != request.instructions
        || !template.input.is_empty()
    {
        return Err(bad("review template differs"));
    }
    if request.context_policy.is_some()
        && a.root_payload["context_template"] != a.root_payload["review_template"]
    {
        return Err(bad("context template differs"));
    }
    let mut tools = BTreeSet::new();
    for tool in &template.tools {
        if !tools.insert(tool.name.as_str())
            || !matches!(
                tool.name.as_str(),
                "list_source_files"
                    | "read_source_lines"
                    | "search_source_text"
                    | "execute_snapshot"
                    | "submit_source_hypotheses"
                    | "delegate_tasks"
            )
            || (tool.name == "delegate_tasks" && request.delegation_policy.is_none())
        {
            return Err(bad("review tool authority differs"));
        }
    }
    for name in [
        "list_source_files",
        "read_source_lines",
        "search_source_text",
        "execute_snapshot",
        "submit_source_hypotheses",
    ] {
        if !tools.contains(name) {
            return Err(bad("required review tool absent"));
        }
    }
    let mut names: BTreeSet<&str> = BTreeSet::from([request.provider.as_str()]);
    names.extend(
        request
            .delegation_policy
            .iter()
            .flat_map(|p| p.roles.iter().map(|r| r.provider.as_str())),
    );
    if a.provider_context
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>()
        != names
    {
        return Err(bad("provider capture membership differs"));
    }
    for p in a.provider_context.values() {
        if p.endpoint.is_empty() || p.endpoint.len() > 8192 {
            return Err(bad("provider route bounds"));
        }
    }
    let p = &a.provider_context[&request.provider];
    if a.root_payload["endpoint"] != p.endpoint
        || a.root_payload["rates"] != serde_json::to_value(p.rates)?
        || a.root_payload
            .get("wire_api")
            .cloned()
            .unwrap_or(json!("responses"))
            != serde_json::to_value(p.wire_api)?
        || a.root_payload.get("hosted_catalog")
            != p.hosted_catalog
                .as_ref()
                .map(serde_json::to_value)
                .transpose()?
                .as_ref()
    {
        return Err(bad("provider capture differs"));
    }
    // Manifest identity is checked without touching the mutable source path.
    let files: Vec<_> = a
        .snapshot
        .files
        .iter()
        .map(|f| json!({"bytes":f.bytes,"digest":f.digest,"path":f.path}))
        .collect();
    if hash(&files)? != a.snapshot.digest {
        return Err(bad("snapshot manifest digest differs"));
    }
    Ok(())
}
fn insert(
    conn: &rusqlite::Transaction<'_>,
    key: &str,
    session: &str,
    command: &str,
    payload: Value,
    owner: &str,
) -> Result<Operation> {
    let text = encode(&payload)?;
    conn.execute("INSERT INTO operations(id,session_id,command_id,payload,payload_hash,status) VALUES(?1,?2,?3,?4,?5,'admitted')",params![key,session,command,text,format!("{:x}",Sha256::digest(text.as_bytes()))])?;
    let mut op = Operation {
        id: key.into(),
        session_id: session.into(),
        command_id: command.into(),
        payload,
        status: OperationStatus::Admitted,
        owner: None,
        outcome: None,
    };
    append(
        conn,
        session,
        "command_admitted",
        &serde_json::to_value(&op)?,
    )?;
    conn.execute(
        "UPDATE operations SET status='running',owner=?2 WHERE id=?1",
        params![key, owner],
    )?;
    op.status = OperationStatus::Running;
    op.owner = Some(owner.into());
    append(
        conn,
        session,
        "operation_started",
        &serde_json::to_value(&op)?,
    )?;
    Ok(op)
}
impl Store {
    pub fn admit_review(
        &mut self,
        command: &str,
        owner: &str,
        a: &ReviewAdmission,
    ) -> Result<AdmittedReview> {
        id(command)?;
        id(owner)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(r) = read::by_command(&tx, command, &mut Reader::new())? {
            if r.input_path != a.input_path
                || r.profile_name != a.profile_name
                || r.acquisition_receipt
                    != a.acquisition_receipt
                        .as_ref()
                        .map(|r| r.reference())
                        .transpose()
                        .map_err(bad)?
            {
                return Err(bad("command reused with different path/profile"));
            }
            let b = read::bound(&tx, &r.id, &mut Reader::new())?;
            return Ok(AdmittedReview {
                review: r,
                controller: b.controller,
                root: b.root,
                duplicate: true,
            });
        }
        epoch(&tx, owner)?;
        validate(a)?;
        let created = now()?;
        let deadline = created
            .checked_add(a.profile.deadline_ms)
            .ok_or_else(|| bad("deadline overflow"))?;
        integer(deadline)?;
        let value = intent(a, command, created, deadline);
        let bytes = encode(&value)?.into_bytes();
        if bytes.len() > MAX_INTENT_BYTES {
            return Err(bad("intent exceeds bound"));
        }
        let digest = hash(&value)?;
        let session = zero_protocol::session::Session {
            id: a.session_id.clone(),
            generation: format!("native-review:{}", a.review_id),
            generation_epoch: None,
            created_at_ms: created,
            budget_limit: a.profile.budget_limit,
        };
        tx.execute(
            "INSERT INTO sessions(id,generation,created_at_ms,budget_limit) VALUES(?1,?2,?3,?4)",
            params![
                session.id,
                session.generation,
                integer(created)?,
                integer(session.budget_limit)?
            ],
        )?;
        append(
            &tx,
            &session.id,
            "session_created",
            &serde_json::to_value(&session)?,
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO artifacts(digest,bytes) VALUES(?1,?2)",
            params![digest, bytes],
        )?;
        if crate::artifacts::read(&tx, &digest)? != bytes {
            return Err(bad("artifact collision"));
        }
        let sequence: u64 =
            tx.query_row("SELECT coalesce(max(sequence),0)+1 FROM reviews", [], |r| {
                r.get(0)
            })?;
        let record = ReviewRecord {
            schema_version: 1,
            id: a.review_id.clone(),
            command_id: command.into(),
            session_id: a.session_id.clone(),
            controller_operation_id: a.controller_operation_id.clone(),
            root_operation_id: a.root_operation_id.clone(),
            input_path: a.input_path.clone(),
            canonical_path: a.canonical_path.clone(),
            snapshot_sha256: a.snapshot.digest.clone(),
            workspace_selection: a.workspace_selection.clone(),
            acquisition_receipt: a
                .acquisition_receipt
                .as_ref()
                .map(|r| r.reference())
                .transpose()
                .map_err(bad)?,
            profile_name: a.profile_name.clone(),
            intent_sha256: digest.clone(),
            profile_sha256: hash(&a.profile)?,
            created_at_ms: created,
            deadline_at_ms: deadline,
            sequence,
        };
        let controller = insert(
            &tx,
            &a.controller_operation_id,
            &a.session_id,
            &format!("review:{}", a.review_id),
            json!({"kind":"native_review","review_id":a.review_id,"intent_sha256":digest,"root_operation_id":a.root_operation_id}),
            owner,
        )?;
        let mut payload = a.root_payload.clone();
        payload["review_operation_id"] = json!(controller.id);
        payload["review_context"] = context(&record);
        let root = insert(
            &tx,
            &a.root_operation_id,
            &a.session_id,
            &format!("review:{}:root", a.review_id),
            payload,
            owner,
        )?;
        tx.execute("INSERT INTO operation_artifacts(operation_id,name,digest) VALUES(?1,'review.intent',?2)",params![controller.id,digest])?;
        append(
            &tx,
            &a.session_id,
            "operation_artifact",
            &json!({"operation_id":controller.id,"name":"review.intent","digest":digest,"bytes":bytes.len()}),
        )?;
        if let Some(acquisition) = &a.acquisition_receipt {
            let bytes = acquisition.receipt.canonical_bytes().map_err(bad)?;
            let digest = acquisition
                .reference()
                .map_err(bad)?
                .receipt_sha256()
                .to_owned();
            tx.execute(
                "INSERT OR IGNORE INTO artifacts(digest,bytes) VALUES(?1,?2)",
                params![digest, bytes],
            )?;
            if crate::artifacts::read(&tx, &digest)? != bytes {
                return Err(bad("acquisition receipt artifact collision"));
            }
            tx.execute("INSERT INTO operation_artifacts(operation_id,name,digest) VALUES(?1,'review.acquisition_receipt',?2)",params![controller.id,digest])?;
            append(
                &tx,
                &a.session_id,
                "operation_artifact",
                &json!({"operation_id":controller.id,"name":"review.acquisition_receipt","digest":digest,"bytes":bytes.len()}),
            )?;
        }
        let binding: u64 = tx.query_row(
            "SELECT coalesce(max(sequence),0)+1 FROM events WHERE session_id=?1",
            [&a.session_id],
            |r| r.get(0),
        )?;
        tx.execute("INSERT INTO reviews(sequence,id,command_id,session_id,controller_operation_id,root_operation_id,intent_sha256,record,binding_sequence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![integer(sequence)?,record.id,command,record.session_id,record.controller_operation_id,record.root_operation_id,digest,encode(&record)?,integer(binding)?])?;
        append(
            &tx,
            &a.session_id,
            "review_created",
            &serde_json::to_value(&record)?,
        )?;
        tx.commit()?;
        Ok(AdmittedReview {
            review: record,
            controller,
            root,
            duplicate: false,
        })
    }
    pub fn request_review_stop(
        &mut self,
        key: &str,
        owner: &str,
        reason: ReviewCloseReason,
    ) -> Result<bool> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let b = read::bound(&tx, key, &mut Reader::new())?;
        if b.controller.status != OperationStatus::Running || b.close.is_some() {
            return Ok(false);
        }
        epoch(&tx, owner)?;
        if b.controller.owner.as_deref() != Some(owner) {
            return Err(bad("stop owner differs"));
        }
        if reason == ReviewCloseReason::Deadline && now()? < b.record.deadline_at_ms {
            return Err(bad("deadline not reached"));
        }
        let sequence: u64 = tx.query_row(
            "SELECT coalesce(max(sequence),0)+1 FROM events WHERE session_id=?1",
            [&b.record.session_id],
            |r| r.get(0),
        )?;
        let reason_text = match reason {
            ReviewCloseReason::Cancelled => "cancelled",
            ReviewCloseReason::Deadline => "deadline",
        };
        tx.execute(
            "UPDATE reviews SET close_reason=?2,close_sequence=?3 WHERE id=?1",
            params![key, reason_text, integer(sequence)?],
        )?;
        append(
            &tx,
            &b.record.session_id,
            "review_admission_closed",
            &json!({"review_id":key,"controller_operation_id":b.controller.id,"reason":reason,"owner":owner}),
        )?;
        tx.commit()?;
        Ok(true)
    }
}
/// External input and unsupported capabilities cannot widen a captured review.
/// Missing projections fail closed. Internal effects use the exact authority gates.
pub(crate) fn forbid_input(conn: &Connection, session: &str) -> Result<()> {
    crate::native_reproduction::forbid_generic(conn, session)?;
    if read::binding(conn, session, &mut Reader::new())?.is_some() {
        return Err(bad(
            "external input or unsupported capability is forbidden for frozen review",
        ));
    }
    Ok(())
}
