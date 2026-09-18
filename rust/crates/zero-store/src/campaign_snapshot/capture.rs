use super::*;
use rusqlite::{
    Connection, OptionalExtension,
    types::{Value, ValueRef},
};
pub(super) fn columns(conn: &Connection, table: &str) -> Result<Vec<String>> {
    if !TABLES.contains(&table) {
        return Err(invalid("unsupported table"));
    }
    let mut q = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = q
        .query_map([], |r| r.get(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}
fn read_rows(
    conn: &Connection,
    table: &str,
    filter: &str,
    parameters: &[Value],
    remaining: &mut usize,
    count: &mut usize,
) -> Result<Vec<Vec<Cell>>> {
    let columns = columns(conn, table)?;
    let lengths = columns
        .iter()
        .map(|c| format!("COALESCE(length(CAST({c} AS BLOB)),0)+32"))
        .collect::<Vec<_>>()
        .join("+");
    let (rows,size,max):(usize,usize,usize)=conn.query_row(&format!("SELECT count(*),COALESCE(sum({lengths}),0),COALESCE(max({lengths}),0) FROM {table} WHERE {filter}"),rusqlite::params_from_iter(parameters),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if rows > MAX_RECORDS.saturating_sub(*count) || size > *remaining || max > 32 * 1024 * 1024 {
        return Err(invalid("source record or byte bound exceeded"));
    }
    *remaining -= size;
    *count += rows;
    let mut q = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut keys = q
        .query_map([], |r| Ok((r.get::<_, u32>(5)?, r.get::<_, String>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    keys.retain(|(n, _)| *n > 0);
    keys.sort();
    if keys.is_empty() {
        return Err(invalid("table primary key absent"));
    }
    let order = keys
        .into_iter()
        .map(|(_, name)| name)
        .collect::<Vec<_>>()
        .join(",");
    let mut q = conn.prepare(&format!(
        "SELECT {} FROM {table} WHERE {filter} ORDER BY {order}",
        columns.join(",")
    ))?;
    let mut records = q.query(rusqlite::params_from_iter(parameters))?;
    let mut output = Vec::with_capacity(rows);
    while let Some(row) = records.next()? {
        let mut cells = vec![];
        for index in 0..columns.len() {
            cells.push(match row.get_ref(index)? {
                ValueRef::Null => Cell::Null,
                ValueRef::Integer(n) => Cell::Integer(n),
                ValueRef::Text(s) => Cell::Text(
                    std::str::from_utf8(s)
                        .map_err(|_| invalid("non UTF-8 text"))?
                        .into(),
                ),
                _ => return Err(invalid("unsupported SQL scalar type")),
            });
        }
        output.push(cells);
    }
    Ok(output)
}
fn strings(
    conn: &Connection,
    sql: &str,
    parameters: &[Value],
    limit: usize,
) -> Result<BTreeSet<String>> {
    let mut q = conn.prepare(sql)?;
    let mut rows = q.query(rusqlite::params_from_iter(parameters))?;
    let mut result = BTreeSet::new();
    let mut count = 0;
    while let Some(row) = rows.next()? {
        count += 1;
        if count > limit {
            return Err(invalid("identity count exceeds bound"));
        }
        let value: String = row.get(0)?;
        if value.is_empty() || value.len() > 256 || !result.insert(value) {
            return Err(invalid("duplicate or oversized identity"));
        }
    }
    Ok(result)
}
fn raw_identity(column: &str) -> String {
    format!("CASE WHEN length(CAST({column} AS BLOB))<=256 THEN {column} END")
}
impl Store {
    pub fn freeze_campaign(&self, campaign: &str) -> Result<CampaignSnapshotData> {
        self.freeze_campaign_inner(campaign, || {})
    }
    fn freeze_campaign_inner(
        &self,
        campaign: &str,
        after_pin: impl FnOnce(),
    ) -> Result<CampaignSnapshotData> {
        if campaign.is_empty() || campaign.len() > 256 {
            return Err(invalid("campaign identity bound"));
        }
        let tx = self.conn.unchecked_transaction()?;
        crate::schema::validate_current(&tx)?;
        // The original portable layout covers fixed-pair evaluation only.
        // Search adds proposal spending and multiple pairs; omitting either
        // would allow a partial history to masquerade as measured eligibility.
        let search: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM strategy_searches WHERE campaign_id=?1) OR EXISTS(SELECT 1 FROM strategy_search_proposals WHERE campaign_id=?1) OR EXISTS(SELECT 1 FROM strategy_search_evaluations WHERE campaign_id=?1)",
            [campaign], |r| r.get(0))?;
        if search {
            return Err(invalid(
                "search evidence requires its own complete portable layout",
            ));
        }
        let campaign_parameter = vec![Value::Text(campaign.into())];
        let (journal,record):(String,String)=tx.query_row("SELECT CASE WHEN length(CAST(journal_session_id AS BLOB))<=256 THEN journal_session_id END,CASE WHEN length(CAST(record AS BLOB))<=65536 THEN record END FROM campaigns WHERE id=?1",[campaign],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or_else(||Error::NotFound(campaign.into()))?;
        // The source snapshot is already pinned before a concurrent writer may commit.
        after_pin();
        let c: zero_protocol::campaign::Campaign = serde_json::from_str(&record)?;
        if c.id != campaign || c.journal_session_id != journal {
            return Err(invalid("campaign identity differs"));
        }
        let search_witness: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind IN ('strategy_search_created','strategy_search_proposal_admitted','strategy_search_evaluation_registered'))",
            [&journal], |r| r.get(0))?;
        let config = crate::artifacts::read(&tx, &c.plan.controller_plan_sha256)?;
        if search_witness
            || serde_json::from_slice::<serde_json::Value>(&config)
                .ok()
                .as_ref()
                .and_then(|v| v.get("kind"))
                .is_some_and(|v| v == "strategy_search")
        {
            return Err(invalid(
                "search evidence requires its own complete portable layout",
            ));
        }
        let oversized:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE kind IN ('campaign_session_bound','campaign_exposed') AND length(CAST(payload AS BLOB))>1048576)",[],|r|r.get(0))?;
        if oversized {
            return Err(invalid("global campaign witness exceeds bound"));
        }
        let (journal_bytes,journal_max):(usize,usize)=tx.query_row("SELECT COALESCE(sum(length(CAST(payload AS BLOB))),0),COALESCE(max(length(CAST(payload AS BLOB))),0) FROM events WHERE session_id=?1",[&journal],|r|Ok((r.get(0)?,r.get(1)?)))?;
        if journal_bytes > MAX_BYTES || journal_max > 32 * 1024 * 1024 {
            return Err(invalid("journal exceeds source bound"));
        }
        let projection = strings(
            &tx,
            &format!(
                "SELECT {} FROM campaign_runs WHERE campaign_id=?1 LIMIT 129",
                raw_identity("session_id")
            ),
            &campaign_parameter,
            128,
        )?;
        let journal_parameter = vec![Value::Text(journal.clone())];
        let witnesses = strings(
            &tx,
            "SELECT CASE WHEN json_valid(payload) AND length(CAST(json_extract(payload,'$.session_id') AS BLOB))<=256 THEN json_extract(payload,'$.session_id') END FROM events WHERE session_id=?1 AND kind='campaign_run_admitted' LIMIT 129",
            &journal_parameter,
            128,
        )?;
        let bindings = strings(
            &tx,
            &format!(
                "SELECT {} FROM events WHERE kind='campaign_session_bound' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.campaign_id') END=?1 LIMIT 129",
                raw_identity("session_id")
            ),
            &campaign_parameter,
            128,
        )?;
        if projection != witnesses || projection != bindings || projection.contains(&journal) {
            return Err(invalid("run membership projections and witnesses differ"));
        }
        let mut sessions = projection;
        sessions.insert(journal);
        let parameters: Vec<Value> = sessions.iter().cloned().map(Value::Text).collect();
        let placeholders = vec!["?"; sessions.len()].join(",");
        let session_filter = format!("session_id IN ({placeholders})");
        let operation_filter =
            format!("operation_id IN (SELECT id FROM operations WHERE {session_filter})");
        let account_filter =
            format!("account_id IN (SELECT id FROM http_accounts WHERE {session_filter})");
        for table in [
            "agent_inputs",
            "agent_steering",
            "operator_questions",
            "operator_question_decisions",
            "tool_approvals",
            "tool_approval_decisions",
            "source_triage_decisions",
            "strategy_sessions",
        ] {
            let exists: bool = tx.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {session_filter})"),
                rusqlite::params_from_iter(&parameters),
                |r| r.get(0),
            )?;
            if exists {
                return Err(invalid(
                    "unsupported input, approval, source or strategy-session state",
                ));
            }
        }
        let forbidden:bool=tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM tool_approval_consumptions WHERE effect_operation_id IN (SELECT id FROM operations WHERE {session_filter}))"),rusqlite::params_from_iter(&parameters),|r|r.get(0))?;
        if forbidden {
            return Err(invalid("unsupported approval consumption"));
        }
        let (operation_bytes,operation_max):(usize,usize)=tx.query_row(&format!("SELECT COALESCE(sum(length(CAST(payload AS BLOB))+COALESCE(length(CAST(outcome AS BLOB)),0)),0),COALESCE(max(length(CAST(payload AS BLOB))+COALESCE(length(CAST(outcome AS BLOB)),0)),0) FROM operations WHERE {session_filter}"),rusqlite::params_from_iter(&parameters),|r|Ok((r.get(0)?,r.get(1)?)))?;
        if operation_bytes > MAX_BYTES || operation_max > 32 * 1024 * 1024 {
            return Err(invalid("operation exceeds source bound"));
        }
        let kinds:bool=tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM operations WHERE {session_filter} AND CASE WHEN json_valid(payload) THEN coalesce(json_extract(payload,'$.kind'),'') ELSE '' END NOT IN ('strategy_evaluation','scoped_web_agent','agent_inference','agent_http','agent_delegation','agent_web_experiment'))"),rusqlite::params_from_iter(&parameters),|r|r.get(0))?;
        if kinds {
            return Err(invalid("unsupported operation kind"));
        }
        let foreign:bool=tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM operations o WHERE o.{session_filter} AND json_type(o.payload,'$.parent_operation') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operations p WHERE p.id=json_extract(o.payload,'$.parent_operation') AND p.session_id=o.session_id))"),rusqlite::params_from_iter(&parameters),|r|r.get(0))?;
        if foreign {
            return Err(invalid("foreign or missing operation parent"));
        }
        let mut remaining = MAX_BYTES;
        let mut count = 0;
        let mut values = vec![];
        for &table in TABLES {
            let (filter, args) = match table {
                "engine_epoch" => ("0=1".to_string(), &[][..]),
                "campaigns" => ("id=?1".to_string(), campaign_parameter.as_slice()),
                "campaign_runs" | "campaign_exposures" | "campaign_debits" => {
                    ("campaign_id=?1".to_string(), campaign_parameter.as_slice())
                }
                "sessions" => (format!("id IN ({placeholders})"), parameters.as_slice()),
                "http_dispatches" | "http_rates" => (account_filter.clone(), parameters.as_slice()),
                "operation_artifacts" | "agent_steering_windows" => {
                    (operation_filter.clone(), parameters.as_slice())
                }
                _ => (session_filter.clone(), parameters.as_slice()),
            };
            values.push((
                table.into(),
                read_rows(&tx, table, &filter, args, &mut remaining, &mut count)?,
            ));
        }
        // Both directions matter: the scorer walks admissions, so an unwitnessed
        // Unknown projection must not disappear from the measured matrix. These
        // JSON checks run only after read_rows has bounded every selected event.
        let operation_count: u64 = tx.query_row(
            &format!("SELECT count(*) FROM operations WHERE {session_filter}"),
            rusqlite::params_from_iter(&parameters),
            |r| r.get(0),
        )?;
        let admission_count: u64 = tx.query_row(
            &format!(
                "SELECT count(*) FROM events WHERE {session_filter} AND kind='command_admitted'"
            ),
            rusqlite::params_from_iter(&parameters),
            |r| r.get(0),
        )?;
        let mismatch: bool = tx.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM operations o WHERE o.{session_filter} AND (SELECT count(*) FROM events e INDEXED BY campaign_root_lifecycle WHERE e.session_id=o.session_id AND e.kind IN ('command_admitted','operation_started','operation_settled','operation_unknown','operation_not_started') AND e.kind='command_admitted' AND CASE WHEN json_valid(e.payload) THEN coalesce(json_extract(e.payload,'$.id'),json_extract(e.payload,'$.operation_id')) END=+o.id AND CASE WHEN json_valid(e.payload) THEN json(e.payload)=json(json_object('command_id',o.command_id,'id',o.id,'outcome',NULL,'owner',NULL,'payload',json(o.payload),'session_id',o.session_id,'status','admitted')) ELSE 0 END)!=1)"),
            rusqlite::params_from_iter(&parameters), |r| r.get(0))?;
        if operation_count != admission_count || mismatch {
            return Err(invalid(
                "operation projection and exact admission witnesses differ",
            ));
        }
        // Capture global exposure uniqueness from the same source snapshot, including orphan witnesses.
        let suites = strings(
            &tx,
            "SELECT CASE WHEN length(suite_sha256)=71 THEN suite_sha256 END FROM campaign_exposures WHERE campaign_id=?1 LIMIT 129",
            &campaign_parameter,
            128,
        )?;
        for suite in suites {
            let projected: u64 = tx.query_row(
                "SELECT count(*) FROM campaign_exposures WHERE suite_sha256=?1",
                [&suite],
                |r| r.get(0),
            )?;
            let witnessed:u64=tx.query_row("SELECT count(*) FROM events WHERE kind='campaign_exposed' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.suite_sha256') END=?1",[&suite],|r|r.get(0))?;
            if projected != 1 || witnessed != 1 {
                return Err(invalid("protected exposure is not unique"));
            }
        }
        let mut q=tx.prepare(&format!("SELECT DISTINCT CASE WHEN length(digest)=71 THEN digest END FROM operation_artifacts WHERE {operation_filter} ORDER BY digest LIMIT {}",MAX_RECORDS+1))?;
        let mut digests = q
            .query_map(rusqlite::params_from_iter(&parameters), |r| {
                r.get::<_, String>(0)
            })?
            .collect::<std::result::Result<BTreeSet<_>, _>>()?;
        drop(q);
        digests.insert(c.plan.controller_plan_sha256);
        if digests.len() > MAX_RECORDS {
            return Err(invalid("too many artifacts"));
        }
        let mut artifacts = BTreeMap::new();
        for digest in digests {
            let size: usize = tx.query_row(
                "SELECT length(bytes) FROM artifacts WHERE digest=?1",
                [&digest],
                |r| r.get(0),
            )?;
            if size > crate::MAX_ARTIFACT_BYTES || size > remaining {
                return Err(invalid("artifact bytes exceed bound"));
            }
            remaining -= size;
            artifacts.insert(digest.clone(), crate::artifacts::read(&tx, &digest)?);
        }
        let manifest = Manifest {
            schema_version: 1,
            store_schema: SNAPSHOT_STORE_LAYOUT,
            campaign_id: campaign.into(),
            sessions: sessions.into_iter().collect(),
            tables: vec![],
            artifacts: BTreeMap::new(),
            record_count: count as u32,
            total_unique_bytes: 0,
        };
        tx.commit()?;
        CampaignSnapshotData::assemble(manifest, values, artifacts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_reads_one_snapshot_when_writer_commits_between_phases() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("snapshot.db");
        let mut source = Store::open(&path).unwrap();
        source
            .conn
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        let config = serde_json::json!({"controller":"snapshot race"});
        let plan:zero_protocol::campaign::CampaignPlan=serde_json::from_value(serde_json::json!({"schema_version":1,"controller_plan_sha256":hash(&serde_json::to_vec(&config).unwrap()),"baseline_sha256":format!("sha256:{}","a".repeat(64)),"expires_at_ms":9000000000000u64,"limits":{"model_micro_usd":100,"model_calls":8,"http_requests":8,"http_request_body_bytes":1024,"http_response_decoded_bytes":8192,"experiments":2,"runs":8,"max_parallel_runs":1}})).unwrap();
        let id = source
            .create_campaign_with_artifact("race", &plan, &serde_json::to_vec(&config).unwrap())
            .unwrap()
            .0
            .id;
        let before = source.freeze_campaign(&id).unwrap();
        let writer = Connection::open(path).unwrap();
        let pinned = source
            .freeze_campaign_inner(&id, || {
                writer
                    .execute("UPDATE campaigns SET last_ms=last_ms+1 WHERE id=?1", [&id])
                    .unwrap();
            })
            .unwrap();
        assert_eq!(pinned.digest(), before.digest());
        assert_ne!(
            source.freeze_campaign(&id).unwrap().digest(),
            before.digest()
        );
        Store::hydrate_campaign_snapshot(&pinned).unwrap();
    }
}
