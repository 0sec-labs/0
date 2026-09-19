use crate::{Attempt, Plan, Report, Result, Variant, digest, invalid};
use rusqlite::{Connection, params};
use std::{
    fs::File,
    path::{Path, PathBuf},
};
pub(crate) struct Ledger {
    pub conn: Connection,
    pub root: PathBuf,
    pub run: String,
    pub plan: Plan,
    pub owner: String,
    _lock: File,
}
impl Ledger {
    pub fn create(root: &Path, plan: Plan) -> Result<Self> {
        plan.validate()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().mode(0o700).create(root)?;
        }
        #[cfg(not(unix))]
        {
            return Err(invalid("evaluation ownership requires Unix"));
        }
        let (conn, lock, root) = open(root, true)?;
        configure_owned_database(&conn)?;
        conn.execute_batch("PRAGMA application_id=1514493505; PRAGMA user_version=1;
            CREATE TABLE run(id TEXT PRIMARY KEY, plan TEXT NOT NULL, digest TEXT NOT NULL, owner TEXT NOT NULL, started INTEGER NOT NULL DEFAULT 0, report TEXT);
            CREATE TABLE attempts(id INTEGER PRIMARY KEY, json TEXT NOT NULL);")?;
        let run = uuid::Uuid::new_v4().to_string();
        let owner = uuid::Uuid::new_v4().to_string();
        let bytes = serde_json::to_string(&plan)?;
        conn.execute(
            "INSERT INTO run(id,plan,digest,owner) VALUES(?1,?2,?3,?4)",
            params![run, bytes, digest(bytes.as_bytes()), owner],
        )?;
        let mut value = Self {
            conn,
            root,
            run,
            plan,
            owner,
            _lock: lock,
        };
        let tx = value.conn.transaction()?;
        let mut index = 0;
        for repeat in 0..value.plan.repeats {
            for case in &value.plan.cases {
                let order = if repeat % 2 == 0 {
                    [Variant::Baseline, Variant::Candidate]
                } else {
                    [Variant::Candidate, Variant::Baseline]
                };
                for variant in order {
                    let a = Attempt {
                        index,
                        variant,
                        case_id: case.id.clone(),
                        repeat,
                        state: "pending".into(),
                        owner: None,
                        lease_id: None,
                        staging: None,
                        execution_id: None,
                        request_digest: None,
                        sandbox: None,
                        output: None,
                        error: None,
                        settled: false,
                    };
                    tx.execute(
                        "INSERT INTO attempts(id,json) VALUES(?1,?2)",
                        params![index, serde_json::to_string(&a)?],
                    )?;
                    index += 1;
                }
            }
        }
        tx.commit()?;
        Ok(value)
    }
    pub fn reopen(root: &Path) -> Result<Self> {
        let (conn, lock, root) = open(root, false)?;
        validate_identity(&conn)?;
        let (run, plan) = crate::inspect::read_plan(&conn)?;
        let owner = uuid::Uuid::new_v4().to_string();
        let mut value = Self {
            conn,
            root,
            run,
            plan,
            owner,
            _lock: lock,
        };
        let rows = value.attempts()?;
        // Ownership/schema/plan checks must precede any persistent PRAGMA.
        configure_owned_database(&value.conn)?;
        let tx = value.conn.transaction()?;
        tx.execute("UPDATE run SET owner=?1", [&value.owner])?;
        for mut a in rows {
            if a.state == "preparing" || a.state == "running" {
                a.state = "unknown".into();
                a.error = Some(
                    "prior owner interrupted; no automatic replay or cleanup assertion".into(),
                );
                tx.execute(
                    "UPDATE attempts SET json=?1 WHERE id=?2",
                    params![serde_json::to_string(&a)?, a.index],
                )?;
            }
        }
        tx.commit()?;
        Ok(value)
    }
    pub fn started(&self) -> Result<bool> {
        Ok(self
            .conn
            .query_row("SELECT started FROM run", [], |r| r.get::<_, i64>(0))?
            != 0)
    }
    pub fn begin(&self) -> Result<()> {
        if self.conn.execute(
            "UPDATE run SET started=1 WHERE started=0 AND owner=?1",
            [&self.owner],
        )? != 1
        {
            return Err(invalid("run already started; inspect without replay"));
        }
        Ok(())
    }
    pub fn attempts(&self) -> Result<Vec<Attempt>> {
        crate::inspect::read_attempts(&self.conn, &self.plan)
    }
    pub fn can_reserve_attempt(&self, index: usize) -> Result<bool> {
        let (total, current): (usize, usize) = self.conn.query_row(
            "SELECT coalesce(sum(length(CAST(json AS BLOB))),0),coalesce(max(CASE WHEN id=?1 THEN length(CAST(json AS BLOB)) ELSE 0 END),0) FROM attempts", [index], |r| Ok((r.get(0)?,r.get(1)?)))?;
        Ok(total.saturating_sub(current).saturating_add(512 * 1024)
            <= crate::inspect::MAX_EVIDENCE_BYTES)
    }
    pub fn save(&self, a: &Attempt) -> Result<()> {
        let raw = serde_json::to_string(a)?;
        if raw.len() > 512 * 1024 {
            return Err(invalid("attempt evidence bound"));
        }
        let (total, current): (usize, usize) = self.conn.query_row(
            "SELECT coalesce(sum(length(CAST(json AS BLOB))),0),coalesce(max(CASE WHEN id=?1 THEN length(CAST(json AS BLOB)) ELSE 0 END),0) FROM attempts", [a.index], |r| Ok((r.get(0)?,r.get(1)?)))?;
        if total.saturating_sub(current).saturating_add(raw.len())
            > crate::inspect::MAX_EVIDENCE_BYTES
        {
            return Err(invalid("aggregate serialized evidence bound"));
        }
        if self.conn.execute(
            "UPDATE attempts SET json=?1 WHERE id=?2",
            params![raw, a.index],
        )? != 1
        {
            return Err(invalid("missing attempt"));
        }
        Ok(())
    }
    pub fn report(&self) -> Result<Option<Report>> {
        crate::inspect::read_report(&self.conn, &self.run, &self.plan, &self.attempts()?)
    }
    pub fn finish(&self, r: &Report) -> Result<()> {
        self.conn.execute(
            "UPDATE run SET report=?1 WHERE report IS NULL",
            [serde_json::to_string(r)?],
        )?;
        Ok(())
    }
}
#[cfg(unix)]
pub(crate) fn open_named(
    root: &Path,
    create: bool,
    name: &str,
) -> Result<(Connection, File, PathBuf)> {
    use fs2::FileExt;
    use std::{
        fs::{self, OpenOptions},
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let meta = fs::symlink_metadata(root)?;
    if !meta.is_dir() || meta.mode() & 0o077 != 0 {
        return Err(invalid("private non-symlink evaluation root required"));
    }
    let root = root.canonicalize()?;
    if root.to_str().is_none() {
        return Err(invalid("evaluation recovery paths require UTF-8"));
    }
    let regular = |p: &Path, new: bool| -> Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(new)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(p)?;
        let m = file.metadata()?;
        if !m.is_file() || m.nlink() != 1 {
            return Err(invalid("single-link regular ledger/lock required"));
        }
        Ok(file)
    };
    let lock = regular(&root.join("owner.lock"), create)?;
    lock.try_lock_exclusive()
        .map_err(|_| invalid("evaluation already owned"))?;
    let lock_named = fs::symlink_metadata(root.join("owner.lock"))?;
    let lock_opened = lock.metadata()?;
    if lock_named.ino() != lock_opened.ino()
        || lock_named.dev() != lock_opened.dev()
        || !lock_named.is_file()
        || lock_named.nlink() != 1
    {
        return Err(invalid("owner lock replaced"));
    }
    let db = regular(&root.join(name), create)?;
    let before = db.metadata()?;
    let conn = Connection::open(root.join(name))?;
    let after = fs::symlink_metadata(root.join(name))?;
    if before.ino() != after.ino() || before.dev() != after.dev() || after.nlink() != 1 {
        return Err(invalid("ledger replaced"));
    }
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok((conn, lock, root))
}
#[cfg(not(unix))]
pub(crate) fn open_named(_: &Path, _: bool, _: &str) -> Result<(Connection, File, PathBuf)> {
    Err(invalid("evaluation ownership requires Unix"))
}

fn configure_owned_database(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;")?;
    Ok(())
}

pub(crate) fn validate_identity(conn: &Connection) -> Result<()> {
    let app: i64 = conn.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if app != 1514493505 || version != 1 {
        return Err(invalid("foreign evaluation database"));
    }
    let objects: Vec<(String, String)> = conn
        .prepare(
            "SELECT type,name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    if objects
        != vec![
            ("table".into(), "attempts".into()),
            ("table".into(), "run".into()),
        ]
    {
        return Err(invalid("unexpected evaluation schema objects"));
    }

    Ok(())
}

fn open(root: &Path, create: bool) -> Result<(Connection, File, PathBuf)> {
    open_named(root, create, "evaluation.sqlite")
}
