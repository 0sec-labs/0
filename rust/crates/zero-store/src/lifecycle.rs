use crate::{Result, Store, append, nonempty};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::json;

impl Store {
    /// Caller MUST hold the exclusive lifetime engine lock for this database.
    /// Publish the new owner and recover the previous epoch in ONE transaction:
    /// a crash cannot publish a new identity while old running rows are missed.
    /// Opening a Store alone never calls this or steals a live engine's work.
    pub fn claim_engine_epoch(&mut self, owner: &str) -> Result<usize> {
        nonempty(owner)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT owner FROM engine_epoch WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if previous.as_deref() == Some(owner) {
            return Err(crate::Error::Conflict(
                "engine epoch already claimed".into(),
            ));
        }
        let rows = {
            // A missing epoch is bootstrap/migration from v1. Its old in-place
            // owner file could have torn, so recover all pre-epoch running rows
            // under the proven exclusive engine lock, not that unreliable text.
            let mut stmt = tx.prepare("SELECT id,session_id,owner FROM operations WHERE status='running' AND (?1 IS NULL OR owner=?1) ORDER BY id")?;
            stmt.query_map([previous.as_deref()], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
        };
        for (id, session, prior_owner) in &rows {
            tx.execute("UPDATE operations SET status='unknown' WHERE id=?1", [id])?;
            append(
                &tx,
                session,
                "operation_unknown",
                &json!({"operation_id":id,"owner":prior_owner,"reason":"previous engine epoch ended"}),
            )?;
        }
        // Admission commits before worker ownership. A crash in that gap has
        // begun no external effect, but retrying the same command must never
        // launch it implicitly. Publish a durable terminal non-started result.
        let admitted = {
            let mut stmt = tx.prepare("SELECT id,session_id FROM operations WHERE status='admitted' AND owner IS NULL ORDER BY id")?;
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let outcome = json!({"reason":"not_started","detail":"engine epoch ended before operation ownership","external_effects_started":false});
        let encoded = serde_json::to_string(&outcome)?;
        for (id, session) in &admitted {
            tx.execute(
                "UPDATE operations SET status='failed',outcome=?2 WHERE id=?1",
                params![id, encoded],
            )?;
            append(
                &tx,
                session,
                "operation_not_started",
                &json!({"operation_id":id,"status":"failed","outcome":outcome}),
            )?;
        }
        crate::campaign::recover(&tx, previous.as_deref())?;
        tx.execute("INSERT INTO engine_epoch(singleton,owner) VALUES (1,?1) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner",params![owner])?;
        tx.commit()?;
        Ok(rows.len() + admitted.len())
    }
}
