//! The optional managed grant is part of the original immutable intent.
use super::*;

pub(super) fn deadline(
    admission: &ScanAdmission,
    command: &str,
    created: u64,
    grant: Option<&ManagedScanGrant>,
) -> Result<u64> {
    let relative = created
        .checked_add(admission.profile.deadline_ms)
        .ok_or_else(|| bad("deadline overflow"))?;
    let deadline = match grant {
        None => relative,
        Some(grant) => {
            grant.validate().map_err(bad)?;
            if grant.command_id() != command
                || grant.target != admission.target
                || grant.scan_profile_name != admission.profile_name
                || serde_json::to_value(&grant.scan_profile)?
                    != serde_json::to_value(&admission.profile)?
                || serde_json::to_value(&grant.http_policy)?
                    != admission.root_payload["http_context"]["profile"]
                || serde_json::to_value(&grant.providers)?
                    != serde_json::to_value(&admission.provider_context)?
                || grant.expires_at_ms <= created
            {
                return Err(bad("managed grant authority or expiry differs"));
            }
            relative.min(grant.expires_at_ms)
        }
    };
    integer(deadline)?;
    Ok(deadline)
}

pub(super) fn intent(
    admission: &ScanAdmission,
    command: &str,
    created: u64,
    deadline: u64,
    grant: Option<&ManagedScanGrant>,
) -> Result<Value> {
    let mut value = json!({"schema_version":1,"kind":"native_scan_intent","admission":admission,"command_id":command,"created_at_ms":created,"deadline_at_ms":deadline});
    if let Some(grant) = grant {
        value["managed_grant"] = serde_json::to_value(grant)?;
    }
    Ok(value)
}

impl Store {
    /// Reconstruct the full grant from the original admission and its witnesses.
    /// Expired grants remain readable; this method never admits or resumes work.
    pub fn scan_managed_grant(&self, scan_id: &str) -> Result<Option<ManagedScanGrant>> {
        let tx = self.conn.unchecked_transaction()?;
        Ok(read::bound(&tx, scan_id, &mut Reader::new())?.managed_grant)
    }
}
