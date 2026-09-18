use crate::{Attempt, Inspection, Plan, Report, Result, digest, invalid};
use rusqlite::{Connection, OpenFlags};
use std::{collections::BTreeMap, path::Path, time::Duration};
pub(crate) const MAX_EVIDENCE_BYTES: usize = 32 * 1024 * 1024;
#[cfg(unix)]
pub(crate) fn inspect(root: &Path) -> Result<Inspection> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::symlink_metadata(root)?;
    if !metadata.is_dir() || metadata.mode() & 0o077 != 0 {
        return Err(invalid("private non-symlink evaluation root required"));
    }
    let path = root.canonicalize()?.join("evaluation.sqlite");
    let before = std::fs::symlink_metadata(&path)?;
    if !before.is_file() || before.nlink() != 1 {
        return Err(invalid("single-link regular ledger required"));
    }
    let mut conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    conn.busy_timeout(Duration::from_secs(2))?;
    let after = std::fs::symlink_metadata(&path)?;
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || !after.is_file()
        || after.nlink() != 1
    {
        return Err(invalid("ledger replaced"));
    }
    // The transaction pins all lengths, plan, rows and receipt to one snapshot.
    let tx = conn.transaction()?;
    crate::ledger::validate_identity(&tx)?;
    let (run, plan) = read_plan(&tx)?;
    let rows = read_attempts(&tx, &plan)?;
    let report = read_report(&tx, &run, &plan, &rows)?;
    let started = tx.query_row("SELECT started FROM run", [], |r| r.get::<_, i64>(0))? != 0;
    let mut states = BTreeMap::new();
    for a in &rows {
        if !matches!(
            a.state.as_str(),
            "pending" | "preparing" | "running" | "finished" | "unknown"
        ) {
            return Err(invalid("invalid attempt state"));
        }
        *states.entry(a.state.clone()).or_insert(0) += 1;
    }
    let summary = Inspection {
        schema_version: 1,
        run_id: run,
        plan_digest: digest(&serde_json::to_vec(&plan)?),
        started,
        attempt_budget: plan.attempt_budget,
        states,
        settled: rows.iter().filter(|a| a.settled).count(),
        reserved_slots: rows
            .iter()
            .filter(|a| a.state != "pending" && !a.settled)
            .count(),
        report,
    };
    tx.commit()?;
    Ok(summary)
}
#[cfg(not(unix))]
pub(crate) fn inspect(_: &Path) -> Result<Inspection> {
    Err(invalid(
        "evaluation inspection requires Unix file identity checks",
    ))
}
pub(crate) fn read_plan(conn: &Connection) -> Result<(String, Plan)> {
    let (count,max_plan,max_run,max_digest):(i64,Option<i64>,Option<i64>,Option<i64>)=conn.query_row("SELECT count(*),max(length(CAST(plan AS BLOB))),max(length(CAST(id AS BLOB))),max(length(CAST(digest AS BLOB))) FROM run",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    if count != 1
        || max_plan.is_none_or(|n| n > 1024 * 1024)
        || max_run.is_none_or(|n| n > 128)
        || max_digest != Some(71)
    {
        return Err(invalid("run/plan byte bounds"));
    }
    let (run, raw, expected): (String, String, String) =
        conn.query_row("SELECT id,plan,digest FROM run", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
    if digest(raw.as_bytes()) != expected {
        return Err(invalid("plan integrity"));
    }
    let plan: Plan = serde_json::from_str(&raw)?;
    plan.validate()?;
    Ok((run, plan))
}
pub(crate) fn read_attempts(conn: &Connection, plan: &Plan) -> Result<Vec<Attempt>> {
    let (count,total,maximum):(usize,usize,usize)=conn.query_row("SELECT count(*),coalesce(sum(length(CAST(json AS BLOB))),0),coalesce(max(length(CAST(json AS BLOB))),0) FROM attempts",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if count != plan.cases.len() * plan.repeats * 2
        || count > 1536
        || total > MAX_EVIDENCE_BYTES
        || maximum > 512 * 1024
    {
        return Err(invalid("attempt evidence bounds"));
    }
    let mut q = conn.prepare("SELECT id,json FROM attempts ORDER BY id")?;
    let rows = q.query_map([], |r| Ok((r.get::<_, usize>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = Vec::with_capacity(count);
    for row in rows {
        let (id, raw) = row?;
        let a: Attempt = serde_json::from_str(&raw)?;
        if id != out.len() || a.index != id {
            return Err(invalid("attempt index mismatch"));
        }
        out.push(a);
    }
    Ok(out)
}
pub(crate) fn read_report(
    conn: &Connection,
    run: &str,
    plan: &Plan,
    attempts: &[Attempt],
) -> Result<Option<Report>> {
    let len: Option<usize> =
        conn.query_row("SELECT length(CAST(report AS BLOB)) FROM run", [], |r| {
            r.get(0)
        })?;
    if len.is_some_and(|n| n > 64 * 1024) {
        return Err(invalid("report byte bound"));
    }
    let raw: Option<String> = conn.query_row("SELECT report FROM run", [], |r| r.get(0))?;
    let report: Option<Report> = raw.map(|s| serde_json::from_str(&s)).transpose()?;
    if let Some(ref stored) = report {
        let measured = crate::score::score(run, plan, attempts)?;
        if serde_json::to_vec(stored)? != serde_json::to_vec(&measured)? {
            return Err(invalid("stored report/evidence integrity mismatch"));
        }
    }
    Ok(report)
}
