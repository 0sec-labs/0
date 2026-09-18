use crate::{Error, Result, hash};
use rusqlite::{Connection, TransactionBehavior, params};
const APPLICATION: i64 = 0x3045564f;
pub(crate) fn initialize(conn: &mut Connection, schema: &str, state: &str) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let app: i64 = tx.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if ![0, APPLICATION].contains(&app) || !(0..=1).contains(&version) {
        return Err(Error::Invalid(
            "foreign or unsupported registry database".into(),
        ));
    }
    if app == 0 {
        let count: i64 = tx.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )?;
        if count != 0 || version != 0 {
            return Err(Error::Invalid("refusing existing foreign database".into()));
        }
    }
    if version == 0 {
        tx.execute_batch("CREATE TABLE artifacts(digest TEXT PRIMARY KEY,bytes BLOB NOT NULL);
CREATE TABLE generations(digest TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE receipts(digest TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE eligibilities(digest TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE runtime(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL,generation TEXT REFERENCES generations(digest),state_schema TEXT NOT NULL,state_digest TEXT NOT NULL,state TEXT NOT NULL);
CREATE TABLE preparations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,generation TEXT NOT NULL REFERENCES generations(digest),eligibility TEXT NOT NULL REFERENCES eligibilities(digest),expected_epoch INTEGER NOT NULL,expected_generation TEXT,expected_digest TEXT NOT NULL,state_schema TEXT NOT NULL,state_digest TEXT NOT NULL,state TEXT NOT NULL,rollback INTEGER NOT NULL,committed_epoch INTEGER);
CREATE TABLE activations(epoch INTEGER PRIMARY KEY,generation TEXT NOT NULL REFERENCES generations(digest),previous_generation TEXT,preparation TEXT NOT NULL UNIQUE REFERENCES preparations(id),state_digest TEXT NOT NULL,rollback INTEGER NOT NULL);
CREATE TABLE leases(id TEXT PRIMARY KEY,generation TEXT NOT NULL REFERENCES generations(digest),owner TEXT NOT NULL,epoch INTEGER NOT NULL,released INTEGER NOT NULL DEFAULT 0);")?;
        tx.execute(
            "INSERT INTO runtime VALUES (1,0,NULL,?1,?2,?3)",
            params![schema, hash(state.as_bytes()), state],
        )?;
        tx.pragma_update(None, "application_id", APPLICATION)?;
        tx.pragma_update(None, "user_version", 1)?;
    }
    tx.commit()?;
    Ok(())
}

/// Inspection must reject foreign/partial databases without initializing them.
pub(crate) fn validate_existing(conn: &Connection) -> Result<()> {
    let app: i64 = conn.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if app != APPLICATION || version != 1 {
        return Err(Error::Invalid(
            "foreign or unsupported registry database".into(),
        ));
    }
    for (table, columns) in [
        ("artifacts", "digest,bytes"),
        ("generations", "digest,json"),
        ("receipts", "digest,json"),
        ("eligibilities", "digest,json"),
        (
            "runtime",
            "singleton,epoch,generation,state_schema,state_digest,state",
        ),
        (
            "preparations",
            "id,owner,generation,eligibility,expected_epoch,expected_generation,expected_digest,state_schema,state_digest,state,rollback,committed_epoch",
        ),
        (
            "activations",
            "epoch,generation,previous_generation,preparation,state_digest,rollback",
        ),
        ("leases", "id,generation,owner,epoch,released"),
    ] {
        let kind: String = conn.query_row(
            "SELECT type FROM sqlite_master WHERE name=?1",
            [table],
            |r| r.get(0),
        )?;
        if kind != "table" {
            return Err(Error::Invalid("registry record is not a table".into()));
        }
        conn.prepare(&format!("SELECT {columns} FROM {table} LIMIT 0"))?;
    }
    Ok(())
}
