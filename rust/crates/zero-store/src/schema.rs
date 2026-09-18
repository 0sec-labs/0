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
    if !(0..=2).contains(&version) {
        return Err(Error::Schema(version));
    }
    if application == 0 {
        let tables: i64 = tx.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
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
    tx.commit()?;
    Ok(())
}
