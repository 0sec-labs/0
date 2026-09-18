//! Scalar lifecycle projection; never materialize a root outcome for a status page.
use super::*;
const KINDS: &str = "'command_admitted','operation_started','operation_settled','operation_unknown','operation_not_started'";
pub(super) fn budget(conn: &Connection, campaign: &str) -> Result<()> {
    let records:u64=conn.query_row("SELECT COALESCE(SUM(2*length(CAST(record AS BLOB))),0) FROM campaign_runs WHERE campaign_id=?1",[campaign],|r|r.get(0))?;
    let operations:u64=conn.query_row("SELECT COALESCE(SUM(length(CAST(o.payload AS BLOB))+COALESCE(length(CAST(o.outcome AS BLOB)),0)),0) FROM campaign_runs r JOIN operations o ON o.session_id=r.session_id AND o.command_id='campaign-run:'||r.id WHERE r.campaign_id=?1",[campaign],|r|r.get(0))?;
    let events:u64=conn.query_row(&format!("SELECT COALESCE(SUM(length(CAST(e.payload AS BLOB))),0) FROM campaign_runs r JOIN operations o ON o.session_id=r.session_id AND o.command_id='campaign-run:'||r.id JOIN events e ON e.session_id=o.session_id AND e.kind IN ({KINDS}) AND CASE WHEN json_valid(e.payload) THEN coalesce(json_extract(e.payload,'$.id'),json_extract(e.payload,'$.operation_id')) END=o.id WHERE r.campaign_id=?1"),[campaign],|r|r.get(0))?;
    if records
        .checked_add(operations)
        .and_then(|n| n.checked_add(events))
        .is_none_or(|n| n > 64 * 1024 * 1024)
    {
        return Err(bad("campaign lifecycle read budget exceeds 64 MiB"));
    }
    Ok(())
}
pub(super) fn root(
    conn: &Connection,
    r: &CampaignRun,
) -> Result<Option<(String, CampaignRunStatus)>> {
    budget(conn, &r.campaign_id)?;
    metadata(conn, &r.id, &r.session_id, &r.owner)
}
pub(super) fn metadata(
    conn: &Connection,
    run_id: &str,
    session: &str,
    run_owner: &str,
) -> Result<Option<(String, CampaignRunStatus)>> {
    let command = format!("campaign-run:{run_id}");
    let row:Option<(String,String,Option<String>)>=conn.query_row("SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END,CASE WHEN length(CAST(status AS BLOB))<=16 THEN status END,CASE WHEN owner IS NULL OR length(CAST(owner AS BLOB))<=256 THEN owner END FROM operations WHERE session_id=?1 AND command_id=?2",params![session,command],|q|Ok((q.get(0)?,q.get(1)?,q.get(2)?))).optional()?;
    let Some((id, status, owner)) = row else {
        return Ok(None);
    };
    let request_ok:bool=conn.query_row("SELECT json_extract(o.payload,'$.request')=json_extract(r.record,'$.spec.request') AND json_type(o.payload,'$.parent_operation') IS NULL FROM operations o JOIN campaign_runs r ON r.id=?2 WHERE o.id=?1",params![id,run_id],|q|q.get(0))?;
    if !request_ok {
        return Err(bad("root request changed"));
    }
    let mut q=conn.prepare(&format!("SELECT kind,sequence FROM events WHERE session_id=?1 AND kind IN ({KINDS}) AND CASE WHEN json_valid(payload) THEN coalesce(json_extract(payload,'$.id'),json_extract(payload,'$.operation_id')) END=?2 ORDER BY sequence LIMIT 9"))?;
    let events = q
        .query_map(params![session, id], |q| {
            Ok((q.get::<_, String>(0)?, q.get::<_, u64>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if events.len() > 8 {
        return Err(bad("duplicate lifecycle witnesses"));
    }
    let one = |kind: &str| -> Result<Option<u64>> {
        let ids: Vec<_> = events
            .iter()
            .filter(|(k, _)| k == kind)
            .map(|(_, s)| *s)
            .collect();
        if ids.len() > 1 {
            return Err(bad("duplicate lifecycle witness"));
        }
        Ok(ids.first().copied())
    };
    let admission = one("command_admitted")?.ok_or_else(|| bad("root admission witness absent"))?;
    let full = |seq: u64, event_status: &str, terminal: bool| -> Result<bool> {
        Ok(conn.query_row("SELECT json_extract(e.payload,'$.id')=o.id AND json_extract(e.payload,'$.session_id')=o.session_id AND json_extract(e.payload,'$.command_id')=o.command_id AND json_extract(e.payload,'$.payload')=json(o.payload) AND json_extract(e.payload,'$.status')=?4 AND (CASE WHEN ?5 THEN json_extract(e.payload,'$.owner') IS o.owner AND json_extract(e.payload,'$.outcome') IS json(o.outcome) ELSE json_type(e.payload,'$.owner')='null' AND json_type(e.payload,'$.outcome')='null' END) FROM events e JOIN operations o ON o.id=?1 WHERE e.session_id=?2 AND e.sequence=?3",params![id,session,integer(seq)?,event_status,terminal],|q|q.get(0))?)
    };
    if !full(admission, "admitted", false)? {
        return Err(bad("root admission projection differs"));
    }
    let started = one("operation_started")?;
    if let Some(sequence) = started {
        let valid:bool=conn.query_row("SELECT json_extract(e.payload,'$.id')=o.id AND json_extract(e.payload,'$.session_id')=o.session_id AND json_extract(e.payload,'$.command_id')=o.command_id AND json_extract(e.payload,'$.payload')=json(o.payload) AND json_extract(e.payload,'$.status')='running' AND json_extract(e.payload,'$.owner') IS o.owner AND json_type(e.payload,'$.outcome')='null' FROM events e JOIN operations o ON o.id=?1 WHERE e.session_id=?2 AND e.sequence=?3",params![id,session,integer(sequence)?],|q|q.get(0))?;
        if sequence <= admission || owner.as_deref() != Some(run_owner) || !valid {
            return Err(bad("root ownership witness differs"));
        }
    }
    let settled = one("operation_settled")?;
    let unknown = one("operation_unknown")?;
    let not_started = one("operation_not_started")?;
    let result = match status.as_str() {
        "admitted"
            if owner.is_none()
                && started.is_none()
                && settled.is_none()
                && unknown.is_none()
                && not_started.is_none() =>
        {
            CampaignRunStatus::Pending
        }
        "running"
            if started.is_some()
                && settled.is_none()
                && unknown.is_none()
                && not_started.is_none() =>
        {
            CampaignRunStatus::Running
        }
        "succeeded" | "failed" | "cancelled"
            if settled.is_some()
                && started.is_some()
                && unknown.is_none()
                && not_started.is_none() =>
        {
            let seq = settled.ok_or_else(|| bad("terminal witness absent"))?;
            if seq <= started.unwrap_or(0) || !full(seq, &status, true)? {
                return Err(bad("root terminal witness differs"));
            }
            match status.as_str() {
                "succeeded" => CampaignRunStatus::Succeeded,
                "failed" => CampaignRunStatus::Failed,
                _ => CampaignRunStatus::Cancelled,
            }
        }
        "failed"
            if not_started.is_some()
                && started.is_none()
                && settled.is_none()
                && unknown.is_none()
                && owner.is_none() =>
        {
            let valid:bool=conn.query_row("SELECT json_extract(e.payload,'$.operation_id')=o.id AND json_extract(e.payload,'$.status')='failed' AND json_extract(e.payload,'$.outcome')=json(o.outcome) AND json_extract(o.outcome,'$.external_effects_started')=0 FROM events e JOIN operations o ON o.id=?1 WHERE e.session_id=?2 AND e.sequence=?3",params![id,session,integer(not_started.unwrap_or(0))?],|q|q.get(0))?;
            if !valid {
                return Err(bad("root not-started witness differs"));
            }
            CampaignRunStatus::Failed
        }
        "unknown"
            if unknown.is_some()
                && started.is_some()
                && settled.is_none()
                && not_started.is_none() =>
        {
            let sequence = unknown.unwrap_or(0);
            if sequence <= started.unwrap_or(0) {
                return Err(bad("root recovery ordering differs"));
            }
            let valid = full(sequence, "unknown", true).unwrap_or(false);
            let compact:bool=conn.query_row("SELECT json_extract(e.payload,'$.operation_id')=o.id AND json_extract(e.payload,'$.owner') IS o.owner AND o.outcome IS NULL AND ((SELECT count(*) FROM json_each(e.payload))=2 OR ((SELECT count(*) FROM json_each(e.payload))=3 AND json_extract(e.payload,'$.reason')='previous engine epoch ended')) FROM events e JOIN operations o ON o.id=?1 WHERE e.session_id=?2 AND e.sequence=?3",params![id,session,integer(sequence)?],|q|q.get(0)).unwrap_or(false);
            if !valid && !compact {
                return Err(bad("root recovery witness differs"));
            }
            CampaignRunStatus::Unknown
        }
        _ => return Err(bad("root status lacks exact lifecycle witness")),
    };
    Ok(Some((id, result)))
}

pub(super) fn closure(
    conn: &Connection,
    journal: &str,
    run: &str,
    expected: Option<u64>,
) -> Result<()> {
    let mut q=conn.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='campaign_run_closed' AND CASE WHEN length(CAST(payload AS BLOB))<=32768 AND json_valid(payload) THEN json_extract(payload,'$.run_id')=?2 ELSE 1 END LIMIT 2")?;
    let found = q
        .query_map(params![journal, run], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if found.as_slice() != expected.as_slice() {
        return Err(bad("run closure projection differs from immutable witness"));
    }
    Ok(())
}
