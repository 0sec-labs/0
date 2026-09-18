use crate::{Error, Result, hash};
use rusqlite::{Connection, TransactionBehavior, params};
const APPLICATION: i64 = 0x3045564f;
const LEGACY_SCHEMA: &str = "CREATE TABLE artifacts(digest TEXT PRIMARY KEY,bytes BLOB NOT NULL);
CREATE TABLE generations(digest TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE receipts(digest TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE eligibilities(digest TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE runtime(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL,generation TEXT REFERENCES generations(digest),state_schema TEXT NOT NULL,state_digest TEXT NOT NULL,state TEXT NOT NULL);
CREATE TABLE preparations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,generation TEXT NOT NULL REFERENCES generations(digest),eligibility TEXT NOT NULL REFERENCES eligibilities(digest),expected_epoch INTEGER NOT NULL,expected_generation TEXT,expected_digest TEXT NOT NULL,state_schema TEXT NOT NULL,state_digest TEXT NOT NULL,state TEXT NOT NULL,rollback INTEGER NOT NULL,committed_epoch INTEGER);
CREATE TABLE activations(epoch INTEGER PRIMARY KEY,generation TEXT NOT NULL REFERENCES generations(digest),previous_generation TEXT,preparation TEXT NOT NULL UNIQUE REFERENCES preparations(id),state_digest TEXT NOT NULL,rollback INTEGER NOT NULL);
CREATE TABLE leases(id TEXT PRIMARY KEY,generation TEXT NOT NULL REFERENCES generations(digest),owner TEXT NOT NULL,epoch INTEGER NOT NULL,released INTEGER NOT NULL DEFAULT 0);";
const STRATEGY_SCHEMA: &str = "CREATE TABLE registry_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),registry_id TEXT NOT NULL UNIQUE,genesis_artifact TEXT NOT NULL REFERENCES artifacts(digest));
CREATE TABLE strategy_imports(command_id TEXT PRIMARY KEY,request_sha256 TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,receipt_sha256 TEXT NOT NULL REFERENCES receipts(digest),eligibility_sha256 TEXT NOT NULL REFERENCES eligibilities(digest),record_sha256 TEXT NOT NULL,record_json TEXT NOT NULL,suite_sha256 TEXT NOT NULL UNIQUE,pair_sha256 TEXT NOT NULL,campaign_id TEXT NOT NULL);
CREATE TABLE strategy_bootstraps(command_id TEXT PRIMARY KEY,request_sha256 TEXT NOT NULL,generation TEXT NOT NULL REFERENCES generations(digest),eligibility_sha256 TEXT NOT NULL REFERENCES eligibilities(digest),activation_epoch INTEGER NOT NULL UNIQUE REFERENCES activations(epoch),record_sha256 TEXT NOT NULL,record_json TEXT NOT NULL);
CREATE INDEX strategy_scope_suite ON eligibilities(CASE WHEN length(CAST(json AS BLOB))<=1048576 AND json_valid(json) THEN json_extract(json,'$.strategy_scope.protected_suite_sha256') END);";
pub(crate) fn initialize(conn: &mut Connection, schema: &str, state: &str) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let app: i64 = tx.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if ![0, APPLICATION].contains(&app) || !(0..=2).contains(&version) {
        return Err(Error::Invalid(
            "foreign or unsupported registry database".into(),
        ));
    }
    if app == 0 {
        let count: i64 = tx.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'",
            [],
            |r| r.get(0),
        )?;
        if count != 0 || version != 0 {
            return Err(Error::Invalid("refusing existing foreign database".into()));
        }
    }
    if version > 0 {
        validate_existing(&tx)?;
    }
    if version == 0 {
        tx.execute_batch(LEGACY_SCHEMA)?;
        tx.execute(
            "INSERT INTO runtime VALUES (1,0,NULL,?1,?2,?3)",
            params![schema, hash(state.as_bytes()), state],
        )?;
        tx.pragma_update(None, "application_id", APPLICATION)?;
        tx.pragma_update(None, "user_version", 1)?;
    }
    if version < 2 {
        tx.execute_batch(STRATEGY_SCHEMA)?;
        let current = crate::lifecycle::current(&tx)?;
        let id = uuid::Uuid::new_v4().to_string();
        let genesis = serde_json::to_vec(
            &serde_json::json!({"schema_version":1,"registry_id":id,"adopted_generation":current.generation,"adopted_epoch":current.epoch,"adopted_state_sha256":current.state_digest}),
        )?;
        let digest = hash(&genesis);
        tx.execute(
            "INSERT INTO artifacts(digest,bytes) VALUES(?1,?2)",
            params![digest, genesis],
        )?;
        tx.execute(
            "INSERT INTO registry_identity VALUES(1,?1,?2)",
            params![id, digest],
        )?;
        tx.pragma_update(None, "user_version", 2)?;
    }
    tx.commit()?;
    Ok(())
}

/// Inspection must reject foreign/partial databases without initializing them.
pub(crate) fn validate_existing(conn: &Connection) -> Result<()> {
    let app: i64 = conn.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if app != APPLICATION || !matches!(version, 1 | 2) {
        return Err(Error::Invalid(
            "foreign or unsupported registry database".into(),
        ));
    }
    let reference = Connection::open_in_memory()?;
    reference.execute_batch(LEGACY_SCHEMA)?;
    if version == 2 {
        reference.execute_batch(STRATEGY_SCHEMA)?;
    }
    if definitions(conn)? != definitions(&reference)? {
        return Err(Error::Invalid("registry schema definitions differ".into()));
    }
    // '_' is literal in GLOB: LIKE 'sqlite_%' would also hide legal user
    // objects such as sqliteXshadow. Exactly the eight registry tables exist.
    let objects: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
        [],
        |r| r.get(0),
    )?;
    if objects != if version == 1 { 8 } else { 12 } {
        return Err(Error::Invalid("unexpected registry schema objects".into()));
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
    if version == 2 {
        for (table, columns) in [
            (
                "registry_identity",
                "singleton,registry_id,genesis_artifact",
            ),
            (
                "strategy_imports",
                "command_id,request_sha256,evidence_sha256,receipt_sha256,eligibility_sha256,record_sha256,record_json,suite_sha256,pair_sha256,campaign_id",
            ),
            (
                "strategy_bootstraps",
                "command_id,request_sha256,generation,eligibility_sha256,activation_epoch,record_sha256,record_json",
            ),
        ] {
            let kind: String = conn.query_row(
                "SELECT type FROM sqlite_schema WHERE name=?1",
                [table],
                |r| r.get(0),
            )?;
            if kind != "table" {
                return Err(Error::Invalid(
                    "strategy registry record is not a table".into(),
                ));
            }
            conn.prepare(&format!("SELECT {columns} FROM {table} LIMIT 0"))?;
        }
        crate::strategy::identity(conn)?;
    }
    Ok(())
}

fn definitions(conn: &Connection) -> Result<Vec<(String, String, String, String)>> {
    let (count,name,sql):(usize,usize,usize)=conn.query_row("SELECT count(*),COALESCE(max(length(CAST(name AS BLOB))),0),COALESCE(max(length(CAST(sql AS BLOB))),0) FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if count > 12 || name > 128 || sql > 16384 {
        return Err(Error::Invalid("registry schema bounds".into()));
    }
    let mut q=conn.prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name")?;
    Ok(
        q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<std::result::Result<_, _>>()?,
    )
}
