//! Explicit host provenance carried by the immutable review intent. No path here
//! is opened, and validating a receipt does not authenticate its Git origin.
use super::*;
use zero_protocol::source_acquisition::{AcquisitionReceiptInput, MAX_RECEIPT_BYTES};
pub(super) fn validate_retained(
    conn: &Connection,
    a: &ReviewAdmission,
    record: &ReviewRecord,
    r: &mut Reader,
) -> Result<()> {
    let digest:Option<String>=conn.query_row("SELECT CASE WHEN length(CAST(digest AS BLOB))=71 THEN digest END FROM operation_artifacts WHERE operation_id=?1 AND name='review.acquisition_receipt'",[&record.controller_operation_id],|row|row.get(0)).optional()?;
    let mut q=conn.prepare("SELECT sequence FROM events WHERE session_id=?1 AND kind='operation_artifact' AND json_extract(payload,'$.operation_id')=?2 AND json_extract(payload,'$.name')='review.acquisition_receipt' ORDER BY sequence LIMIT 2")?;
    let sequences = q
        .query_map(
            params![record.session_id, record.controller_operation_id],
            |row| row.get::<_, u64>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let Some(input) = &a.acquisition_receipt else {
        if digest.is_some() || !sequences.is_empty() {
            return Err(bad("acquisition artifact has no captured host provenance"));
        }
        return Ok(());
    };
    let expected = input.reference().map_err(bad)?;
    if digest.as_deref() != Some(expected.receipt_sha256.as_str()) || sequences.len() != 1 {
        return Err(bad("acquisition receipt attachment or witness absent"));
    }
    let bytes = r.artifact(conn, &expected.receipt_sha256, MAX_RECEIPT_BYTES)?;
    let binding: u64 = conn.query_row(
        "SELECT binding_sequence FROM reviews WHERE id=?1",
        [&record.id],
        |r| r.get(0),
    )?;
    if bytes != input.receipt.canonical_bytes().map_err(bad)?
        || sequences[0] >= binding
        || r.event(conn, &record.session_id, sequences[0])?.1
            != json!({"operation_id":record.controller_operation_id,"name":"review.acquisition_receipt","digest":expected.receipt_sha256,"bytes":bytes.len()})
    {
        return Err(bad("acquisition receipt bytes or attribution differs"));
    }
    Ok(())
}
impl Store {
    /// Read captured provenance without accessing the original receipt or source.
    pub fn review_acquisition_receipt(&self, key: &str) -> Result<Option<AcquisitionReceiptInput>> {
        let tx = self.conn.unchecked_transaction()?;
        Ok(read::bound(&tx, key, &mut Reader::new())?
            .admission
            .acquisition_receipt)
    }
}
