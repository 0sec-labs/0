use crate::{Error, Result};
use rusqlite::{Connection, TransactionBehavior};
const APPLICATION_ID: i64 = 0x30534543;
pub fn initialize(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let application: i64 = tx.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if application != 0 && application != APPLICATION_ID {
        return Err(Error::ForeignDatabase);
    }
    if !(0..=16).contains(&version) {
        return Err(Error::Schema(version));
    }
    if application == 0 {
        let tables: i64 = tx.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'",
            [],
            |r| r.get(0),
        )?;
        if tables != 0 || version != 0 {
            return Err(Error::ForeignDatabase);
        }
    }
    if version == 0 {
        tx.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,generation TEXT NOT NULL,created_at_ms INTEGER NOT NULL,budget_limit INTEGER NOT NULL CHECK(budget_limit>=0));
CREATE TABLE operations(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),command_id TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,owner TEXT,outcome TEXT,UNIQUE(session_id,command_id));
CREATE TABLE events(session_id TEXT NOT NULL REFERENCES sessions(id),sequence INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(session_id,sequence));
CREATE TABLE reservations(session_id TEXT NOT NULL REFERENCES sessions(id),id TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>=0),charged INTEGER CHECK(charged>=0),PRIMARY KEY(session_id,id));")?;
        tx.pragma_update(None, "application_id", APPLICATION_ID)?;
        tx.pragma_update(None, "user_version", 1)?;
    }
    if version < 2 {
        tx.execute_batch("CREATE TABLE engine_epoch(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL);")?;
        tx.pragma_update(None, "user_version", 2)?;
    }
    if version < 3 {
        tx.execute_batch("ALTER TABLE sessions ADD COLUMN generation_epoch INTEGER CHECK(generation_epoch IS NULL OR generation_epoch>=1);")?;
        tx.pragma_update(None, "user_version", 3)?;
    }
    if version < 4 {
        tx.execute_batch("CREATE TABLE artifacts(digest TEXT PRIMARY KEY,bytes BLOB NOT NULL CHECK(length(bytes)<=8388608));
CREATE TABLE operation_artifacts(operation_id TEXT NOT NULL REFERENCES operations(id),name TEXT NOT NULL,digest TEXT NOT NULL REFERENCES artifacts(digest),PRIMARY KEY(operation_id,name));")?;
        tx.pragma_update(None, "user_version", 4)?;
    }
    if version < 5 {
        tx.execute_batch("CREATE TABLE agent_inputs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),sequence INTEGER NOT NULL CHECK(sequence>0),command_id TEXT NOT NULL,request TEXT NOT NULL,after_input TEXT REFERENCES agent_inputs(id),run_command_id TEXT NOT NULL,resolved_request TEXT,cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)),UNIQUE(session_id,command_id),UNIQUE(session_id,sequence),UNIQUE(session_id,run_command_id));")?;
        tx.pragma_update(None, "user_version", 5)?;
    }
    if version < 6 {
        tx.execute_batch("CREATE TABLE source_triage_decisions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),source_operation_id TEXT NOT NULL REFERENCES operations(id),hypothesis_id TEXT NOT NULL,source_review_sha256 TEXT NOT NULL REFERENCES artifacts(digest),revision INTEGER NOT NULL CHECK(revision>0),command_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('new','accepted','suppressed')),note TEXT NOT NULL CHECK(length(CAST(note AS BLOB))<=4096),created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),UNIQUE(session_id,command_id),UNIQUE(source_operation_id,hypothesis_id,revision));")?;
        tx.pragma_update(None, "user_version", 6)?;
    }
    if version < 7 {
        tx.execute_batch("CREATE TABLE agent_steering_windows(operation_id TEXT PRIMARY KEY REFERENCES operations(id),sealed INTEGER NOT NULL CHECK(sealed IN (0,1)));
CREATE TABLE agent_steering(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),operation_id TEXT NOT NULL REFERENCES operations(id),sequence INTEGER NOT NULL CHECK(sequence>0),command_id TEXT NOT NULL,prompt TEXT NOT NULL CHECK(length(CAST(prompt AS BLOB))<=16384),inference_operation_id TEXT REFERENCES operations(id),capture_sequence INTEGER,UNIQUE(session_id,command_id),UNIQUE(session_id,sequence),CHECK((inference_operation_id IS NULL)=(capture_sequence IS NULL)));
CREATE INDEX agent_steering_target ON agent_steering(operation_id,sequence);
CREATE INDEX agent_steering_inference ON agent_steering(inference_operation_id);")?;
        tx.pragma_update(None, "user_version", 7)?;
    }
    if version < 8 {
        tx.execute_batch("CREATE TABLE operator_questions(operation_id TEXT PRIMARY KEY REFERENCES operations(id),session_id TEXT NOT NULL REFERENCES sessions(id),actor_operation_id TEXT NOT NULL REFERENCES operations(id),root_operation_id TEXT NOT NULL REFERENCES operations(id),sequence INTEGER NOT NULL CHECK(sequence>0),UNIQUE(session_id,sequence));
CREATE INDEX operator_questions_root ON operator_questions(session_id,root_operation_id,sequence);
CREATE INDEX operator_questions_actor ON operator_questions(actor_operation_id);
CREATE TABLE operator_question_decisions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),command_id TEXT NOT NULL,question_operation_id TEXT NOT NULL UNIQUE REFERENCES operator_questions(operation_id),request_sha256 TEXT NOT NULL,decision TEXT NOT NULL CHECK(length(CAST(decision AS BLOB))<=65536),sequence INTEGER NOT NULL CHECK(sequence>0),UNIQUE(session_id,command_id),UNIQUE(session_id,sequence));")?;
        tx.pragma_update(None, "user_version", 8)?;
    }
    if version < 9 {
        tx.execute_batch("CREATE TABLE tool_approvals(operation_id TEXT PRIMARY KEY REFERENCES operations(id),session_id TEXT NOT NULL REFERENCES sessions(id),actor_operation_id TEXT NOT NULL REFERENCES operations(id),root_operation_id TEXT NOT NULL REFERENCES operations(id),sequence INTEGER NOT NULL CHECK(sequence>0),intent_sha256 TEXT NOT NULL REFERENCES artifacts(digest),UNIQUE(session_id,sequence));
CREATE INDEX tool_approvals_root ON tool_approvals(session_id,root_operation_id,sequence);
CREATE INDEX tool_approvals_actor ON tool_approvals(actor_operation_id);
CREATE TABLE tool_approval_decisions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),command_id TEXT NOT NULL,approval_operation_id TEXT NOT NULL UNIQUE REFERENCES tool_approvals(operation_id),intent_sha256 TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('approve','deny')),sequence INTEGER NOT NULL CHECK(sequence>0),UNIQUE(session_id,command_id),UNIQUE(session_id,sequence));
CREATE TABLE tool_approval_consumptions(approval_operation_id TEXT PRIMARY KEY REFERENCES tool_approvals(operation_id),effect_operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),effect_command_id TEXT NOT NULL,effect_payload_sha256 TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>0));")?;
        tx.pragma_update(None, "user_version", 9)?;
    }
    if version < 10 {
        tx.execute_batch("CREATE TABLE http_accounts(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),root_operation_id TEXT NOT NULL REFERENCES operations(id),context TEXT NOT NULL CHECK(length(CAST(context AS BLOB))<=1048576));
CREATE TABLE http_dispatches(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES http_accounts(id),effect_operation_id TEXT NOT NULL REFERENCES operations(id),hop_index INTEGER NOT NULL CHECK(hop_index BETWEEN 0 AND 5),host TEXT NOT NULL,intent TEXT NOT NULL CHECK(length(CAST(intent AS BLOB))<=65536),request_bytes INTEGER NOT NULL CHECK(request_bytes>=0),reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),charged_bytes INTEGER CHECK(charged_bytes>=0 AND charged_bytes<=reserved_bytes),observation TEXT,headers TEXT,UNIQUE(effect_operation_id,hop_index));
CREATE INDEX http_dispatches_account ON http_dispatches(account_id);
CREATE INDEX http_receipt_events ON events(session_id,kind,json_extract(payload,'$.receipt')) WHERE kind IN ('http_dispatch_admitted','http_headers_observed','http_hop_settled');
CREATE INDEX http_rate_events ON events(session_id,json_extract(payload,'$.account_id'),json_extract(payload,'$.host'),sequence) WHERE kind='http_rate_updated';
CREATE TABLE http_rates(account_id TEXT NOT NULL REFERENCES http_accounts(id),host TEXT NOT NULL,tokens INTEGER NOT NULL CHECK(tokens>=0),last_ms INTEGER NOT NULL CHECK(last_ms>=0),cooldown_ms INTEGER NOT NULL CHECK(cooldown_ms>=0),PRIMARY KEY(account_id,host));")?;
        tx.pragma_update(None, "user_version", 10)?;
    }
    if version < 11 {
        tx.execute_batch("CREATE TABLE web_triage_decisions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),web_operation_id TEXT NOT NULL REFERENCES operations(id),hypothesis_id TEXT NOT NULL,web_review_sha256 TEXT NOT NULL REFERENCES artifacts(digest),revision INTEGER NOT NULL CHECK(revision>0),command_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('new','accepted','suppressed')),note TEXT NOT NULL CHECK(length(CAST(note AS BLOB))<=4096),created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),UNIQUE(session_id,command_id),UNIQUE(web_operation_id,hypothesis_id,revision));")?;
        tx.pragma_update(None, "user_version", 11)?;
    }
    if version < 12 {
        tx.execute_batch("CREATE TABLE web_experiment_admissions(operation_id TEXT PRIMARY KEY REFERENCES operations(id),session_id TEXT NOT NULL REFERENCES sessions(id),account_id TEXT NOT NULL,policy_sha256 TEXT NOT NULL,intent_sha256 TEXT NOT NULL,hypothesis_sha256 TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>0),UNIQUE(session_id,sequence));
CREATE INDEX web_experiment_account ON web_experiment_admissions(account_id,sequence);
CREATE INDEX web_experiment_quota_events ON events(session_id,json_extract(payload,'$.account_id'),sequence) WHERE kind='web_experiment_admitted';")?;
        tx.pragma_update(None, "user_version", 12)?;
    }
    if version < 13 {
        tx.execute_batch("CREATE TABLE campaigns(id TEXT PRIMARY KEY,command_id TEXT NOT NULL UNIQUE,journal_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=65536),sequence INTEGER NOT NULL,cancel_sequence INTEGER,last_ms INTEGER NOT NULL);
CREATE TABLE campaign_runs(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES campaigns(id),command_id TEXT NOT NULL,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),schedule_index INTEGER NOT NULL,record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=614400),sequence INTEGER NOT NULL,owner TEXT NOT NULL,closed TEXT,close_sequence INTEGER,close_reason TEXT CHECK(length(CAST(close_reason AS BLOB))<=4096),UNIQUE(campaign_id,command_id),UNIQUE(campaign_id,schedule_index));
CREATE INDEX campaign_run_page ON campaign_runs(campaign_id,sequence);
CREATE TABLE campaign_exposures(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES campaigns(id),command_id TEXT NOT NULL,suite_sha256 TEXT NOT NULL UNIQUE,evaluation_pair_sha256 TEXT NOT NULL,record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=4096),sequence INTEGER NOT NULL,UNIQUE(campaign_id,command_id));
CREATE TABLE campaign_debits(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES campaigns(id),session_id TEXT NOT NULL REFERENCES sessions(id),operation_id TEXT NOT NULL REFERENCES operations(id),kind TEXT NOT NULL,reserved TEXT NOT NULL CHECK(length(CAST(reserved AS BLOB))<=4096),settled TEXT CHECK(length(CAST(settled AS BLOB))<=4096),sequence INTEGER NOT NULL,settlement_sequence INTEGER);
CREATE INDEX campaign_debit_page ON campaign_debits(campaign_id,sequence);
CREATE INDEX campaign_exposure_witness ON events(json_extract(payload,'$.suite_sha256')) WHERE kind='campaign_exposed';
CREATE INDEX campaign_root_lifecycle ON events(session_id,kind,CASE WHEN json_valid(payload) THEN coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id')) END) WHERE kind IN ('command_admitted','operation_started','operation_settled','operation_unknown','operation_not_started');")?;
        tx.pragma_update(None, "user_version", 13)?;
    }
    if version < 14 {
        tx.execute_batch("CREATE TABLE strategy_sessions(session_id TEXT PRIMARY KEY REFERENCES sessions(id),capture TEXT NOT NULL CHECK(length(CAST(capture AS BLOB))<=524288),sequence INTEGER NOT NULL CHECK(sequence>0));")?;
        tx.pragma_update(None, "user_version", 14)?;
    }
    if version < 15 {
        tx.execute_batch("CREATE TABLE strategy_searches(campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),config_sha256 TEXT NOT NULL REFERENCES artifacts(digest),sequence INTEGER NOT NULL CHECK(sequence>0));
CREATE TABLE strategy_search_proposals(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES campaigns(id),command_id TEXT NOT NULL,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),attempt_index INTEGER NOT NULL CHECK(attempt_index BETWEEN 0 AND 15),record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=1048576),sequence INTEGER NOT NULL CHECK(sequence>0),UNIQUE(campaign_id,command_id),UNIQUE(campaign_id,attempt_index));
CREATE TABLE strategy_search_evaluations(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES campaigns(id),command_id TEXT NOT NULL,proposal_id TEXT NOT NULL UNIQUE REFERENCES strategy_search_proposals(id),candidate_generation TEXT NOT NULL,schedule_start INTEGER NOT NULL CHECK(schedule_start BETWEEN 0 AND 127),run_count INTEGER NOT NULL CHECK(run_count BETWEEN 1 AND 128),record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=1048576),sequence INTEGER NOT NULL CHECK(sequence>0),CHECK(schedule_start+run_count<=128),UNIQUE(campaign_id,command_id),UNIQUE(campaign_id,candidate_generation));")?;
        tx.pragma_update(None, "user_version", 15)?;
    }
    if version < 16 {
        tx.execute_batch("CREATE TABLE strategy_search_selections(campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),id TEXT NOT NULL UNIQUE,proposal_id TEXT NOT NULL UNIQUE REFERENCES strategy_search_proposals(id),evaluation_id TEXT NOT NULL REFERENCES strategy_search_evaluations(id),exposure_id TEXT NOT NULL UNIQUE REFERENCES campaign_exposures(id),record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=65536),sequence INTEGER NOT NULL CHECK(sequence>0));")?;
        tx.pragma_update(None, "user_version", 16)?;
    }
    tx.commit()?;
    Ok(())
}

/// Validate before any table reads, without mutating the inspected database.
/// Use the same DDL as writable initialization to include columns, constraints,
/// views/triggers and explicit indexes in the current exact-schema check.
pub(super) fn validate_current(conn: &Connection) -> Result<()> {
    let application: i64 = conn.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if application != APPLICATION_ID {
        return Err(Error::ForeignDatabase);
    }
    if version != 16 {
        return Err(Error::Schema(version));
    }
    let observed = crate::readonly::definitions(conn)?;
    // Only this independent in-memory reference is initialized. The inspected
    // connection is SQLite READ_ONLY and its transaction contains only reads.
    let mut reference = Connection::open_in_memory()?;
    initialize(&mut reference)?;
    if observed != crate::readonly::definitions(&reference)? {
        return Err(Error::ForeignDatabase);
    }
    Ok(())
}
