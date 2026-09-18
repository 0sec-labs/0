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
    if !(0..=7).contains(&version) {
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
    if version != 7 {
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
