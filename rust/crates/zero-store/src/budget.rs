use crate::{BudgetSnapshot, Error, Result, Store, append, get_session, integer, nonempty};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::json;
pub(crate) fn snapshot(conn: &Connection, session: &str) -> Result<BudgetSnapshot> {
    let limit = get_session(conn, session)?.budget_limit;
    let (reserved,charged)=conn.query_row("SELECT COALESCE(SUM(CASE WHEN charged IS NULL THEN amount ELSE 0 END),0),COALESCE(SUM(charged),0) FROM reservations WHERE session_id=?1",[session],|r|Ok((r.get(0)?,r.get(1)?)))?;
    Ok(BudgetSnapshot {
        limit,
        reserved,
        charged,
    })
}
impl Store {
    pub fn budget(&self, session: &str) -> Result<BudgetSnapshot> {
        snapshot(&self.conn, session)
    }
    pub fn reserve_budget(
        &mut self,
        session: &str,
        reservation_id: &str,
        amount: u64,
    ) -> Result<BudgetSnapshot> {
        nonempty(reservation_id)?;
        let amount_sql = integer(amount)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = snapshot(&tx, session)?;
        let existing: Option<u64> = tx
            .query_row(
                "SELECT amount FROM reservations WHERE session_id=?1 AND id=?2",
                params![session, reservation_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(old) = existing {
            if old != amount {
                return Err(Error::Conflict(reservation_id.into()));
            }
            crate::campaign::reserve_model(&tx, session, reservation_id, amount)?;
            return Ok(current);
        }
        crate::scan::guard_reservation(&tx, session, reservation_id, amount)?;
        crate::review::forbid_input(&tx, session)?;
        crate::campaign::reserve_model(&tx, session, reservation_id, amount)?;
        let total = current
            .charged
            .checked_add(current.reserved)
            .and_then(|n| n.checked_add(amount));
        if total.is_none_or(|n| n > current.limit) {
            if crate::scan::budget_denied(&tx, session, reservation_id, amount, &current)? {
                tx.commit()?;
            }
            return Err(Error::BudgetExceeded);
        }
        tx.execute(
            "INSERT INTO reservations(session_id,id,amount) VALUES (?1,?2,?3)",
            params![session, reservation_id, amount_sql],
        )?;
        append(
            &tx,
            session,
            "budget_reserved",
            &json!({"reservation_id":reservation_id,"amount":amount}),
        )?;
        let result = snapshot(&tx, session)?;
        tx.commit()?;
        Ok(result)
    }
    /// Actual charges may exceed their reservation/limit; never discard billed usage.
    pub fn settle_budget(
        &mut self,
        session: &str,
        reservation_id: &str,
        charged: u64,
    ) -> Result<BudgetSnapshot> {
        self.settle_budget_inner(session, reservation_id, charged, None)
    }
    /// Explicit trusted-operator reconciliation. Evidence is retained in the
    /// same transaction as the charge; unknown execution state is unchanged.
    pub fn reconcile_budget(
        &mut self,
        session: &str,
        reservation_id: &str,
        charged: u64,
        evidence: &str,
    ) -> Result<BudgetSnapshot> {
        crate::campaign::forbid_input(&self.conn, session)?;
        crate::scan::forbid_input(&self.conn, session)?;
        crate::review::forbid_input(&self.conn, session)?;
        if evidence.trim().is_empty() || evidence.len() > 32768 {
            return Err(Error::Invalid(
                "reconciliation evidence must be 1..32768 bytes".into(),
            ));
        }
        self.settle_budget_inner(session, reservation_id, charged, Some(evidence))
    }
    fn settle_budget_inner(
        &mut self,
        session: &str,
        reservation_id: &str,
        charged: u64,
        evidence: Option<&str>,
    ) -> Result<BudgetSnapshot> {
        let charged_sql = integer(charged)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::campaign::settle_model(&tx, session, reservation_id, charged)?;
        let prior: Option<Option<u64>> = tx
            .query_row(
                "SELECT charged FROM reservations WHERE session_id=?1 AND id=?2",
                params![session, reservation_id],
                |r| r.get(0),
            )
            .optional()?;
        match prior {
            None => return Err(Error::NotFound(reservation_id.into())),
            Some(Some(old)) => {
                if old != charged {
                    return Err(Error::Conflict(reservation_id.into()));
                }
                return snapshot(&tx, session);
            }
            Some(None) => {}
        }
        // Bound persisted aggregate before SQLite SUM can overflow.
        let current = snapshot(&tx, session)?;
        integer(
            current
                .charged
                .checked_add(charged)
                .ok_or_else(|| Error::Invalid("budget charge overflow".into()))?,
        )?;
        tx.execute(
            "UPDATE reservations SET charged=?3 WHERE session_id=?1 AND id=?2",
            params![session, reservation_id, charged_sql],
        )?;
        let mut payload = json!({"reservation_id":reservation_id,"charged":charged});
        if let Some(evidence) = evidence {
            payload["evidence"] = json!(evidence);
            payload["source"] = json!("operator_reconciliation");
        }
        append(
            &tx,
            session,
            if evidence.is_some() {
                "budget_reconciled"
            } else {
                "budget_settled"
            },
            &payload,
        )?;
        let result = snapshot(&tx, session)?;
        tx.commit()?;
        Ok(result)
    }
}
