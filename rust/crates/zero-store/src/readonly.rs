//! Existing current-schema access without migration or engine ownership changes.
use crate::{Error, Result, Store, schema};
use rusqlite::{Connection, OpenFlags};
use std::{path::Path, time::Duration};
impl Store {
    /// Opens only an existing native schema-10 database. No initialization,
    /// migrations, engine epoch claim or recovery is performed on this database.
    /// Ordinary read APIs remain available; SQLite rejects mutation methods.
    /// A read connection does not acquire the engine's exclusive lifetime lock.
    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let metadata = std::fs::symlink_metadata(path).map_err(|_| {
            Error::Invalid("read-only database must be an existing regular file".into())
        })?;
        if !metadata.is_file() {
            return Err(Error::Invalid(
                "read-only database must be an existing regular file".into(),
            ));
        }
        let mut conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        conn.busy_timeout(Duration::from_secs(5))?;
        let tx = conn.transaction()?;
        schema::validate_current(&tx)?;
        tx.commit()?;
        Ok(Self { conn })
    }
}
pub(super) fn definitions(conn: &Connection) -> Result<Vec<(String, String, String)>> {
    let (count,max_name,max_sql):(usize,usize,usize)=conn.query_row(
        "SELECT count(*),coalesce(max(length(CAST(name AS BLOB))),0),coalesce(max(length(CAST(sql AS BLOB))),0) FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if count != 29 || max_name > 128 || max_sql > 16 * 1024 {
        return Err(Error::ForeignDatabase);
    }
    let mut statement = conn.prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
    )?;
    let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}
