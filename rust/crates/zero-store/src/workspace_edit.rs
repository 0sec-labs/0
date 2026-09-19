//! Immutable logical source generations. Editing is atomic DB state, never host I/O.
use crate::{Error, Operation, OperationStatus, Result, Store, append, artifacts, workflow};
use rusqlite::{Connection, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use zero_protocol::{
    agent::AgentRequest,
    model::{Completion, CompletionStatus, Content, Rates},
    source_archive::{ArchiveManifest, SourceArchive},
    workspace_edit::{WorkspaceCall, WorkspaceCapture, WorkspacePolicy},
};
fn bad(s: impl std::fmt::Display) -> Error {
    Error::Conflict(format!("workspace: {s}"))
}
fn now() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(bad)?
        .as_millis()
        .try_into()
        .map_err(bad)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceInvocation {
    pub turn: u32,
    pub index: usize,
    pub call_id: String,
}
pub struct WorkspaceState {
    pub actor: Operation,
    pub policy: WorkspacePolicy,
    pub capture: WorkspaceCapture,
    pub baseline: SourceArchive,
    pub current: SourceArchive,
    pub receipts: Vec<Value>,
    pub test_commands: Vec<String>,
}
fn actor(
    c: &Connection,
    key: &str,
    reader: &mut workflow::Reader,
) -> Result<(Operation, AgentRequest, WorkspacePolicy, WorkspaceCapture)> {
    let actor = workflow::operation(c, key, reader)?;
    let request: AgentRequest = serde_json::from_value(actor.payload["request"].clone())?;
    if actor.payload["kind"] != zero_protocol::agent::actor_kind(&request) {
        return Err(bad("actor capability kind mismatch"));
    }
    let policy = request
        .workspace_policy
        .clone()
        .ok_or_else(|| bad("capability absent"))?;
    policy.validate_actor(&request).map_err(bad)?;
    let capture: WorkspaceCapture =
        serde_json::from_value(actor.payload["workspace_capture"].clone())?;
    capture.validate(&policy).map_err(bad)?;
    crate::review::forbid_input(c, &actor.session_id)?;
    crate::scan::forbid_input(c, &actor.session_id)?;
    crate::campaign::forbid_input(c, &actor.session_id)?;
    Ok((actor, request, policy, capture))
}
fn owned(c: &Connection, actor: &Operation, owner: &str, capture: &WorkspaceCapture) -> Result<()> {
    let epoch: String = c.query_row(
        "SELECT owner FROM engine_epoch WHERE singleton=1",
        [],
        |r| r.get(0),
    )?;
    if epoch != owner
        || actor.status != OperationStatus::Running
        || actor.owner.as_deref() != Some(owner)
    {
        return Err(bad("actor ownership or engine epoch changed"));
    }
    if now()? >= capture.deadline_at_ms {
        return Err(bad("original deadline elapsed"));
    }
    Ok(())
}
fn retain(tx: &Transaction<'_>, archive: &SourceArchive) -> Result<String> {
    archive.validate().map_err(bad)?;
    let manifest = archive.manifest.canonical_bytes().map_err(bad)?;
    let hash = zero_workspace::hash(&manifest);
    for (sha, bytes) in archive
        .blobs
        .iter()
        .chain(std::iter::once((&hash, &manifest)))
    {
        tx.execute(
            "INSERT OR IGNORE INTO artifacts(digest,bytes) VALUES(?1,?2)",
            params![sha, bytes],
        )?;
        if artifacts::read(tx, sha)? != *bytes {
            return Err(bad("archive artifact identity mismatch"));
        }
    }
    Ok(hash)
}
fn archive(c: &Connection, hash: &str) -> Result<SourceArchive> {
    let manifest: ArchiveManifest = serde_json::from_slice(&artifacts::read(c, hash)?)?;
    manifest.validate().map_err(bad)?;
    let mut blobs = BTreeMap::new();
    let mut total = 0usize;
    for chunk in manifest.files.iter().flat_map(|f| &f.chunks) {
        if !blobs.contains_key(&chunk.sha256) {
            let bytes = artifacts::read(c, &chunk.sha256)?;
            total = total
                .checked_add(bytes.len())
                .ok_or_else(|| bad("archive bound"))?;
            if total > 64 * 1024 * 1024 {
                return Err(bad("archive bytes exceed bound"));
            }
            blobs.insert(chunk.sha256.clone(), bytes);
        }
    }
    let archive = SourceArchive { manifest, blobs };
    archive.validate().map_err(bad)?;
    Ok(archive)
}
fn invocation(
    c: &Connection,
    actor: &Operation,
    request: &AgentRequest,
    position: &WorkspaceInvocation,
    before_effect: Option<u64>,
    reader: &mut workflow::Reader,
) -> Result<WorkspaceCall> {
    if position.turn >= request.max_turns || position.index >= 32 {
        return Err(bad("invocation position bounds"));
    }
    let origin_id: String = c.query_row(
        "SELECT id FROM operations WHERE session_id=?1 AND command_id=?2",
        params![
            actor.session_id,
            format!("{}:model:{}", actor.id, position.turn)
        ],
        |r| r.get(0),
    )?;
    let origin = workflow::operation(c, &origin_id, reader)?;
    if origin.status != OperationStatus::Succeeded
        || origin.payload["parent_operation"] != actor.id
        || origin.payload["kind"] != "agent_inference"
    {
        return Err(bad("invocation not completed actor inference"));
    }
    let completion: Completion =
        serde_json::from_value(origin.outcome.ok_or_else(|| bad("completion absent"))?)?;
    if completion.status != CompletionStatus::Completed
        || !completion.usage_is_final
        || completion.error.is_some()
    {
        return Err(bad("inference incomplete"));
    }
    let rates: Rates = serde_json::from_value(origin.payload["rates"].clone())?;
    let charge = rates
        .charge(
            completion
                .usage
                .as_ref()
                .ok_or_else(|| bad("usage absent"))?,
        )
        .ok_or_else(|| bad("usage charge unrepresentable"))?;
    let charged: Option<u64> = c.query_row(
        "SELECT charged FROM reservations WHERE session_id=?1 AND id=?2",
        params![actor.session_id, origin_id],
        |r| r.get(0),
    )?;
    let (witnessed, settled_at):(u64,Option<u64>)=c.query_row("SELECT count(*),min(sequence) FROM events WHERE session_id=?1 AND kind='budget_settled' AND json_extract(payload,'$.reservation_id')=?2 AND json_extract(payload,'$.charged')=?3",params![actor.session_id,origin_id,charge],|r|Ok((r.get(0)?,r.get(1)?)))?;
    if charged != Some(charge)
        || witnessed != 1
        || before_effect.is_some_and(|effect| settled_at.is_none_or(|settled| settled >= effect))
    {
        return Err(bad("inference original budget settlement differs"));
    }
    let calls: Vec<_> = completion
        .content
        .iter()
        .filter_map(|v| {
            if let Content::ToolCall {
                id,
                name,
                arguments,
            } = v
            {
                Some((id, name, arguments))
            } else {
                None
            }
        })
        .collect();
    if calls.len() > 32
        || calls
            .iter()
            .map(|v| v.0)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != calls.len()
    {
        return Err(bad("invocation inventory invalid"));
    }
    let (id, name, args) = calls
        .get(position.index)
        .ok_or_else(|| bad("invocation absent"))?;
    if **id != position.call_id {
        return Err(bad("invocation id differs"));
    }
    let tools: Vec<zero_protocol::model::ToolDefinition> =
        serde_json::from_value(origin.payload["request"]["tools"].clone())?;
    if tools.iter().filter(|t| &t.name == *name).count() != 1 {
        return Err(bad("workspace tool was not offered"));
    }
    WorkspaceCall::parse(name, args).map_err(bad)
}
fn prefix_budget(
    c: &Connection,
    session: &str,
    before: u64,
    reader: &mut workflow::Reader,
) -> Result<()> {
    let mut q=c.prepare("SELECT sequence FROM events WHERE session_id=?1 AND sequence<?2 AND kind IN ('budget_reserved','budget_settled','budget_reconciled') ORDER BY sequence LIMIT 2049")?;
    let rows = q
        .query_map(params![session, before], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > 2048 {
        return Err(bad("budget history bound"));
    }
    let mut ledger: BTreeMap<String, (u64, Option<u64>)> = BTreeMap::new();
    for seq in rows {
        let (kind, v) = reader.event(c, session, seq)?;
        let key = v["reservation_id"]
            .as_str()
            .ok_or_else(|| bad("budget identity absent"))?
            .to_owned();
        if kind == "budget_reserved" {
            if ledger
                .insert(
                    key,
                    (
                        v["amount"]
                            .as_u64()
                            .ok_or_else(|| bad("budget amount absent"))?,
                        None,
                    ),
                )
                .is_some()
            {
                return Err(bad("duplicate reservation"));
            }
        } else {
            let item = ledger
                .get_mut(&key)
                .ok_or_else(|| bad("unreserved charge"))?;
            if item
                .1
                .replace(
                    v["charged"]
                        .as_u64()
                        .ok_or_else(|| bad("budget charge absent"))?,
                )
                .is_some()
            {
                return Err(bad("duplicate budget settlement"));
            }
        }
    }
    let used = ledger
        .values()
        .try_fold(0u64, |n, (amount, charged)| {
            n.checked_add(charged.unwrap_or(*amount))
        })
        .ok_or_else(|| bad("budget sum overflow"))?;
    if used > crate::get_session(c, session)?.budget_limit {
        return Err(bad("effect exceeded original account"));
    }
    Ok(())
}
fn load(c: &Connection, key: &str) -> Result<WorkspaceState> {
    let mut reader = workflow::Reader {
        remaining: 256 * 1024 * 1024,
    };
    let (actor, request, policy, capture) = actor(c, key, &mut reader)?;
    let mut q=c.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind IN ('workspace_prepared','workspace_effect') AND json_extract(payload,'$.actor')=?2 ORDER BY sequence LIMIT 162")?;
    let rows = q
        .query_map(params![actor.session_id, actor.id], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.is_empty() || rows.len() > 161 {
        return Err(bad("workspace history absent or exceeds bound"));
    }
    let (kind, prepared) = reader.event(c, &actor.session_id, rows[0])?;
    if kind != "workspace_prepared" {
        return Err(bad("workspace preparation witness missing"));
    }
    let early_model:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND sequence<=?2 AND kind='command_admitted' AND json_extract(payload,'$.payload.parent_operation')=?3)",params![actor.session_id,rows[0],actor.id],|r|r.get(0))?;
    if early_model {
        return Err(bad("workspace baseline witness follows child admission"));
    }
    let baseline = archive(
        c,
        prepared["manifest"]
            .as_str()
            .ok_or_else(|| bad("baseline manifest absent"))?,
    )?;
    baseline
        .validate_pin(&request.snapshot_request().map_err(bad)?.snapshot)
        .map_err(bad)?;
    zero_workspace::validate_baseline(&baseline, &policy).map_err(bad)?;
    let mut current = baseline.clone();
    let mut receipts = vec![];
    let mut tests = vec![];
    let mut positions = std::collections::BTreeSet::new();
    let mut changed_bytes = 0u64;
    let mut edits = 0u32;
    for seq in rows.into_iter().skip(1) {
        let (kind, v) = reader.event(c, &actor.session_id, seq)?;
        if kind != "workspace_effect" {
            return Err(bad("repeated preparation"));
        }
        let position: WorkspaceInvocation = serde_json::from_value(v["invocation"].clone())?;
        if !positions.insert((position.turn, position.index)) {
            return Err(bad("repeated workspace effect"));
        }
        let at = v["at_ms"]
            .as_u64()
            .ok_or_else(|| bad("effect time absent"))?;
        if at < capture.created_at_ms || at >= capture.deadline_at_ms {
            return Err(bad("effect outside original deadline"));
        }
        prefix_budget(c, &actor.session_id, seq, &mut reader)?;
        let completed_before:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='operation_settled' AND sequence<?2 AND json_extract(payload,'$.command_id')=?3 AND json_extract(payload,'$.status')='succeeded')",params![actor.session_id,seq,format!("{}:model:{}",actor.id,position.turn)],|r|r.get(0))?;
        if !completed_before {
            return Err(bad("effect predates its completed inference"));
        }
        let call = invocation(c, &actor, &request, &position, Some(seq), &mut reader)?;
        if call.is_edit() {
            let transition = zero_workspace::propose(&current, &policy, &call).map_err(bad)?;
            let receipt: zero_workspace::EditReceipt =
                serde_json::from_value(v["receipt"].clone())?;
            if receipt != transition.receipt
                || v["manifest"] != zero_workspace::generation(&transition.archive).map_err(bad)?
            {
                return Err(bad(
                    "edit receipt differs from original invocation and generation",
                ));
            }
            let manifest = v["manifest"]
                .as_str()
                .ok_or_else(|| bad("edit manifest absent"))?;
            if artifacts::read(c, manifest)?
                != transition.archive.manifest.canonical_bytes().map_err(bad)?
            {
                return Err(bad("retained edit manifest differs"));
            }
            for change in &receipt.changes {
                if let Some(file) = transition
                    .archive
                    .manifest
                    .files
                    .iter()
                    .find(|f| f.path == change.path)
                {
                    for chunk in &file.chunks {
                        if artifacts::read(c, &chunk.sha256)?
                            != *transition
                                .archive
                                .blobs
                                .get(&chunk.sha256)
                                .ok_or_else(|| bad("edit blob absent"))?
                        {
                            return Err(bad("retained edit bytes differ"));
                        }
                    }
                }
            }
            edits += 1;
            changed_bytes = changed_bytes
                .checked_add(receipt.changed_bytes)
                .ok_or_else(|| bad("edit bytes overflow"))?;
            current = transition.archive;
        } else if let WorkspaceCall::Execute {
            expected_generation,
            ..
        } = call
        {
            if expected_generation != zero_workspace::generation(&current).map_err(bad)?
                || v["generation"] != expected_generation
            {
                return Err(bad("test generation differs"));
            }
            tests.push(format!(
                "{}:workspace:{}:{}",
                actor.id, position.turn, position.index
            ));
        } else {
            return Err(bad("unexpected effect"));
        }
        receipts.push(v);
    }
    if edits > policy.max_edits
        || changed_bytes > policy.max_changed_bytes
        || tests.len() > policy.max_test_runs as usize
    {
        return Err(bad("workspace allowance exceeded"));
    }
    Ok(WorkspaceState {
        actor,
        policy,
        capture,
        baseline,
        current,
        receipts,
        test_commands: tests,
    })
}
impl Store {
    pub fn prepare_workspace(
        &mut self,
        key: &str,
        owner: &str,
        source: &SourceArchive,
    ) -> Result<String> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut reader = workflow::Reader::new();
        let (actor, request, policy, capture) = actor(&tx, key, &mut reader)?;
        owned(&tx, &actor, owner, &capture)?;
        source
            .validate_pin(&request.snapshot_request().map_err(bad)?.snapshot)
            .map_err(bad)?;
        zero_workspace::validate_baseline(source, &policy).map_err(bad)?;
        let prior:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND ((kind='workspace_prepared' AND json_extract(payload,'$.actor')=?2) OR (kind='command_admitted' AND json_extract(payload,'$.payload.parent_operation')=?2)))",params![actor.session_id,actor.id],|r|r.get(0))?;
        if prior {
            return Err(bad(
                "workspace preparation must precede model admission exactly once",
            ));
        }
        let manifest = retain(&tx, source)?;
        owned(&tx, &actor, owner, &capture)?;
        append(
            &tx,
            &actor.session_id,
            "workspace_prepared",
            &json!({"actor":actor.id,"manifest":manifest}),
        )?;
        tx.commit()?;
        Ok(manifest)
    }
    pub fn workspace_state(&self, key: &str) -> Result<WorkspaceState> {
        let tx = self.conn.unchecked_transaction()?;
        let state = load(&tx, key)?;
        tx.commit()?;
        Ok(state)
    }
    /// For edits the new generation and receipt commit together. For execution this
    /// durable one-use marker precedes staging and launch; lost outcomes never retry.
    pub fn claim_workspace_effect(
        &mut self,
        key: &str,
        owner: &str,
        position: &WorkspaceInvocation,
        expected: &WorkspaceCall,
    ) -> Result<Option<zero_workspace::EditReceipt>> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = load(&tx, key)?;
        owned(&tx, &state.actor, owner, &state.capture)?;
        let mut reader = workflow::Reader::new();
        let request: AgentRequest = serde_json::from_value(state.actor.payload["request"].clone())?;
        let call = invocation(&tx, &state.actor, &request, position, None, &mut reader)?;
        if call.arguments() != expected.arguments() || call.name() != expected.name() {
            return Err(bad("effect differs from exact model arguments"));
        }
        let account = workflow::checked_budget(&tx, &state.actor.session_id, &mut reader)?;
        if account
            .charged
            .checked_add(account.reserved)
            .is_none_or(|n| n > account.limit)
        {
            return Err(bad("original budget exceeded"));
        }
        if state.receipts.iter().any(|v| {
            v["invocation"]["turn"] == position.turn && v["invocation"]["index"] == position.index
        }) {
            return Err(bad("one-use effect already claimed"));
        }
        let mut event = json!({"actor":key,"invocation":position,"at_ms":now()?});
        let result = if call.is_edit() {
            let transition =
                zero_workspace::propose(&state.current, &state.policy, &call).map_err(bad)?;
            let prior_bytes: u64 = state
                .receipts
                .iter()
                .filter_map(|v| v["receipt"]["changed_bytes"].as_u64())
                .sum();
            let prior_edits = state
                .receipts
                .iter()
                .filter(|v| v.get("receipt").is_some())
                .count();
            if prior_edits >= state.policy.max_edits as usize
                || prior_bytes + transition.receipt.changed_bytes > state.policy.max_changed_bytes
            {
                return Err(bad("edit allowance exhausted"));
            }
            event["manifest"] = json!(retain(&tx, &transition.archive)?);
            event["receipt"] = serde_json::to_value(&transition.receipt)?;
            Some(transition.receipt)
        } else if let WorkspaceCall::Execute {
            expected_generation,
            ..
        } = &call
        {
            if *expected_generation != zero_workspace::generation(&state.current).map_err(bad)?
                || state.test_commands.len() >= state.policy.max_test_runs as usize
            {
                return Err(bad("test allowance or generation differs"));
            }
            event["generation"] = json!(expected_generation);
            None
        } else {
            return Err(bad("not an executable or edit effect"));
        };
        owned(&tx, &state.actor, owner, &state.capture)?;
        append(&tx, &state.actor.session_id, "workspace_effect", &event)?;
        tx.commit()?;
        Ok(result)
    }
}
fn test_dispatch_witness(
    c: &Connection,
    state: &WorkspaceState,
    record: &Value,
    operation: &Operation,
    reader: &mut workflow::Reader,
) -> Result<bool> {
    let position: WorkspaceInvocation = serde_json::from_value(record["invocation"].clone())?;
    let mut query = c.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='workspace_test_started' AND (json_extract(payload,'$.child')=?2 OR (json_extract(payload,'$.actor')=?3 AND json_extract(payload,'$.invocation.turn')=?4 AND json_extract(payload,'$.invocation.index')=?5)) ORDER BY sequence LIMIT 2")?;
    let rows = query
        .query_map(
            params![
                state.actor.session_id,
                operation.id,
                state.actor.id,
                position.turn,
                position.index
            ],
            |r| r.get::<_, u64>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.is_empty() {
        if !matches!(
            operation.status,
            OperationStatus::Running | OperationStatus::Unknown
        ) {
            return Err(bad("workspace terminal test lacks dispatch witness"));
        }
        return Ok(false);
    }
    if rows.len() != 1 {
        return Err(bad("workspace duplicate dispatch witness"));
    }
    let sequence = rows[0];
    prefix_budget(c, &state.actor.session_id, sequence, reader)?;
    let (_, witness) = reader.event(c, &state.actor.session_id, sequence)?;
    let at = witness["at_ms"]
        .as_u64()
        .ok_or_else(|| bad("workspace dispatch time absent"))?;
    if witness
        != json!({"actor":state.actor.id,"child":operation.id,"invocation":position,"generation":record["generation"],"owner":operation.owner,"at_ms":at,"request":operation.payload["request"]})
        || operation.owner != state.actor.owner
        || at
            < record["at_ms"]
                .as_u64()
                .ok_or_else(|| bad("workspace claim time absent"))?
        || at < state.capture.created_at_ms
        || at >= state.capture.deadline_at_ms
    {
        return Err(bad(
            "workspace dispatch witness differs from original authority",
        ));
    }
    let claim_before:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND sequence<?2 AND kind='workspace_effect' AND json_extract(payload,'$.actor')=?3 AND json_extract(payload,'$.invocation.turn')=?4 AND json_extract(payload,'$.invocation.index')=?5)",params![state.actor.session_id,sequence,state.actor.id,position.turn,position.index],|r|r.get(0))?;
    let child_before:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND sequence<?2 AND kind='operation_started' AND json_extract(payload,'$.id')=?3)",params![state.actor.session_id,sequence,operation.id],|r|r.get(0))?;
    if !claim_before || !child_before {
        return Err(bad("workspace dispatch predates claim or child ownership"));
    }
    let parent_closed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND sequence<?2 AND kind IN ('operation_settled','operation_unknown','operation_not_started') AND coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id'))=?3)",params![state.actor.session_id,sequence,state.actor.id],|r|r.get(0))?;
    if parent_closed {
        return Err(bad("workspace dispatch follows parent termination"));
    }
    if operation.status != OperationStatus::Running {
        let settled_after:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND sequence>?2 AND kind IN ('operation_settled','operation_unknown') AND coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id'))=?3)",params![state.actor.session_id,sequence,operation.id],|r|r.get(0))?;
        if !settled_after {
            return Err(bad("workspace dispatch follows terminal result"));
        }
    }
    Ok(true)
}

impl Store {
    /// Read-only independent test provenance. Outcomes are observations, never a
    /// candidate promotion claim. Missing projection with an admission witness is corruption.
    pub fn workspace_tests(&self, key: &str) -> Result<Vec<Value>> {
        let tx = self.conn.unchecked_transaction()?;
        let state = load(&tx, key)?;
        let mut reader = workflow::Reader {
            remaining: 128 * 1024 * 1024,
        };
        let mut tests = vec![];
        let request: AgentRequest = serde_json::from_value(state.actor.payload["request"].clone())?;
        for record in state
            .receipts
            .iter()
            .filter(|v| v.get("generation").is_some())
        {
            let position: WorkspaceInvocation =
                serde_json::from_value(record["invocation"].clone())?;
            let command = format!("{key}:workspace:{}:{}", position.turn, position.index);
            let id = tx.query_row(
                "SELECT id FROM operations WHERE session_id=?1 AND command_id=?2",
                params![state.actor.session_id, command],
                |r| r.get::<_, String>(0),
            );
            match id {
                Err(rusqlite::Error::QueryReturnedNoRows) => {
                    let admitted:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='command_admitted' AND json_extract(payload,'$.command_id')=?2)",params![state.actor.session_id,command],|r|r.get(0))?;
                    if admitted {
                        return Err(bad("workspace test admission projection missing"));
                    }
                    tests.push(
                        json!({"command_id":command,"status":"unknown","assessment":"unverified"}),
                    );
                }
                Err(e) => return Err(e.into()),
                Ok(id) => {
                    let op = workflow::operation(&tx, &id, &mut reader)?;
                    let WorkspaceCall::Execute {
                        expected_generation,
                        argv,
                    } = invocation(&tx, &state.actor, &request, &position, None, &mut reader)?
                    else {
                        return Err(bad("test lacks executable invocation"));
                    };
                    let source = archive(&tx, &expected_generation)?;
                    let execution: zero_protocol::sandbox::SandboxRequest =
                        serde_json::from_value(op.payload["request"].clone())?;
                    execution.validate().map_err(bad)?;
                    source.validate_pin(&execution.snapshot).map_err(bad)?;
                    let profile = request.snapshot_request().map_err(bad)?;
                    if op.payload["kind"] != "agent_workspace_test"
                        || op.payload["parent_operation"] != key
                        || op.payload["workspace_generation"] != expected_generation
                        || op.payload["invocation"] != serde_json::to_value(&position)?
                        || execution.argv != argv
                        || execution.memory_mb != profile.memory_mb
                        || execution.cpus != profile.cpus
                        || execution.max_output_bytes != profile.max_output_bytes
                        || execution.timeout_ms > profile.timeout_ms
                        || execution.build_argv.is_some()
                        || execution.stdin.is_some()
                        || serde_json::to_value(&execution.backend)?
                            != serde_json::to_value(&profile.backend)?
                    {
                        return Err(bad(
                            "workspace test exceeds captured generation or execution authority",
                        ));
                    }
                    let dispatched = test_dispatch_witness(&tx, &state, record, &op, &mut reader)?;
                    if let Some(outcome) = &op.outcome {
                        match serde_json::from_value::<zero_protocol::sandbox::SandboxResult>(
                            outcome.clone(),
                        ) {
                            Ok(result) => {
                                if !dispatched {
                                    return Err(bad(
                                        "workspace physical result lacks dispatch witness",
                                    ));
                                }
                                if result.execution_id != execution.execution_id {
                                    return Err(bad("workspace result execution identity differs"));
                                }
                                if op.status == OperationStatus::Succeeded
                                    && !(result.status == zero_protocol::ExecutionStatus::Exited
                                        && result.exit_code == Some(0)
                                        && matches!(
                                            result.cleanup,
                                            zero_protocol::sandbox::SandboxCleanup::Confirmed
                                        ))
                                {
                                    return Err(bad(
                                        "workspace successful result disposition differs",
                                    ));
                                }
                            }
                            Err(_) if op.status == OperationStatus::Unknown => {}
                            Err(error) => return Err(error.into()),
                        }
                    }
                    tests.push(json!({"operation_id":op.id,"generation":expected_generation,"status":op.status,"outcome":op.outcome,"assessment":"unverified"}));
                }
            }
        }
        tx.commit()?;
        Ok(tests)
    }
}

impl Store {
    /// Last authorization frontier after staging and immediately before dispatch.
    /// A retained effect claim alone never authorizes an old engine to launch.
    pub fn begin_workspace_test_dispatch(
        &mut self,
        child: &str,
        owner: &str,
        supplied: &zero_protocol::sandbox::SandboxRequest,
    ) -> Result<()> {
        if self.get_operation(child)?.payload["kind"] != "agent_workspace_test" {
            return Ok(());
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut reader = workflow::Reader::new();
        let operation = workflow::operation(&tx, child, &mut reader)?;
        let key = operation.payload["parent_operation"]
            .as_str()
            .ok_or_else(|| bad("test parent absent"))?;
        let state = load(&tx, key)?;
        owned(&tx, &state.actor, owner, &state.capture)?;
        if operation.status != OperationStatus::Running
            || operation.owner.as_deref() != Some(owner)
            || operation.session_id != state.actor.session_id
            || operation.payload["request"] != serde_json::to_value(supplied)?
        {
            return Err(bad("test dispatch ownership or request differs"));
        }
        let position: WorkspaceInvocation =
            serde_json::from_value(operation.payload["invocation"].clone())?;
        let receipt = state
            .receipts
            .iter()
            .find(|v| {
                v["invocation"] == operation.payload["invocation"] && v.get("generation").is_some()
            })
            .ok_or_else(|| bad("test dispatch lacks original claim"))?;
        let request: AgentRequest = serde_json::from_value(state.actor.payload["request"].clone())?;
        let WorkspaceCall::Execute {
            expected_generation,
            argv,
        } = invocation(&tx, &state.actor, &request, &position, None, &mut reader)?
        else {
            return Err(bad("test dispatch invocation is not executable"));
        };
        if receipt["generation"] != expected_generation
            || operation.payload["workspace_generation"] != expected_generation
            || operation.command_id
                != format!("{key}:workspace:{}:{}", position.turn, position.index)
        {
            return Err(bad("test dispatch claim identity differs"));
        }
        let archive = archive(&tx, &expected_generation)?;
        archive.validate_pin(&supplied.snapshot).map_err(bad)?;
        supplied.validate().map_err(bad)?;
        let profile = request.snapshot_request().map_err(bad)?;
        if supplied.argv != argv
            || supplied.memory_mb != profile.memory_mb
            || supplied.cpus != profile.cpus
            || supplied.max_output_bytes != profile.max_output_bytes
            || supplied.timeout_ms > profile.timeout_ms
            || supplied.build_argv.is_some()
            || supplied.stdin.is_some()
            || serde_json::to_value(&supplied.backend)? != serde_json::to_value(&profile.backend)?
        {
            return Err(bad("test dispatch exceeds original execution authority"));
        }
        let account = workflow::checked_budget(&tx, &state.actor.session_id, &mut reader)?;
        if account
            .charged
            .checked_add(account.reserved)
            .is_none_or(|n| n > account.limit)
        {
            return Err(bad("test dispatch original budget exceeded"));
        }
        let prior:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='workspace_test_started' AND json_extract(payload,'$.actor')=?2 AND json_extract(payload,'$.invocation.turn')=?3 AND json_extract(payload,'$.invocation.index')=?4)",params![state.actor.session_id,key,position.turn,position.index],|r|r.get(0))?;
        if prior {
            return Err(bad("one-use test dispatch already started"));
        }
        owned(&tx, &state.actor, owner, &state.capture)?;
        append(
            &tx,
            &state.actor.session_id,
            "workspace_test_started",
            &json!({"actor":key,"child":child,"invocation":position,"generation":expected_generation,"owner":owner,"at_ms":now()?,"request":supplied}),
        )?;
        tx.commit()?;
        Ok(())
    }
}
