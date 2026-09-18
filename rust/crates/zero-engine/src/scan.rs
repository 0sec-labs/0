//! A durable owner for one scoped HTTP investigation; reports never confer verification.
use super::*;
use serde::Serialize;
use std::{collections::BTreeMap, io::Write, path::Path};
use zero_protocol::{
    Operation,
    agent::{AgentResult, AgentStatus},
    campaign::CampaignProviderContext,
    scan::*,
    source::{ClaimedSeverity, SecurityConclusion},
};
mod controller;
mod provenance;
fn error(e: impl std::fmt::Display) -> EngineError {
    EngineError::State(e.to_string())
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
fn same(a: &impl Serialize, b: &impl Serialize) -> Result<bool, EngineError> {
    Ok(serde_json::to_value(a)? == serde_json::to_value(b)?)
}
struct Bounded {
    bytes: Vec<u8>,
    limit: usize,
}
impl Write for Bounded {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        if b.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other("scan report exceeds byte limit"));
        }
        self.bytes.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn encode(report: &impl Serialize) -> Result<Option<Vec<u8>>, EngineError> {
    let mut w = Bounded {
        bytes: vec![],
        limit: MAX_SCAN_REPORT_BYTES,
    };
    match serde_json::to_writer(&mut w, report) {
        Ok(()) => Ok(Some(w.bytes)),
        Err(e) if e.is_io() => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub fn read_scan_status(path: &Path, id: &str) -> Result<ScanSnapshot, EngineError> {
    provenance::snapshot(&Store::open_read_only(path)?, id)
}
pub fn read_scan_report(path: &Path, id: &str) -> Result<ScanReport, EngineError> {
    provenance::report(&Store::open_read_only(path)?.scan_read_snapshot(id)?, id)
}
pub fn read_scans(path: &Path, before: Option<u64>, limit: u32) -> Result<ScanPage, EngineError> {
    Ok(Store::open_read_only(path)?.scan_page(before, limit)?)
}
impl Engine {
    pub fn configure_scan(&self, name: &str, profile: ScanProfile) -> Result<(), EngineError> {
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(error("invalid scan profile name"));
        }
        profile.validate().map_err(error)?;
        let control = lock(&self.shared.control)?;
        if control.closing || !control.active.is_empty() {
            return Err(error("scan configuration requires an idle engine"));
        }
        let mut profiles = lock(&self.shared.scan_profiles)?;
        if profiles.contains_key(name) {
            return Err(error("scan profile is already configured"));
        }
        profiles.insert(name.into(), profile);
        Ok(())
    }
    pub(crate) fn scan_status(&self, id: &str) -> Result<Reply, EngineError> {
        Ok(Reply::ScanStatus {
            scan: provenance::snapshot(&*lock(&self.shared.store)?, id)?,
        })
    }
    pub(crate) fn scan_report(&self, id: &str) -> Result<Reply, EngineError> {
        Ok(Reply::ScanReport {
            report: provenance::report(&lock(&self.shared.store)?.scan_read_snapshot(id)?, id)?,
        })
    }
    pub(crate) fn scans(&self, before: Option<u64>, limit: u32) -> Result<Reply, EngineError> {
        Ok(Reply::Scans {
            page: lock(&self.shared.store)?.scan_page(before, limit)?,
        })
    }
    pub(crate) fn cancel_scan(&self, id: &str) -> Result<Reply, EngineError> {
        let control = lock(&self.shared.control)?;
        let mut store = lock(&self.shared.store)?;
        let scan = store.scan_record(id)?;
        let accepted =
            store.request_scan_stop(id, &self.shared.owner, ScanCloseReason::Cancelled)?;
        if accepted {
            if let Some(active) = control.active.get(&scan.session_id) {
                active.cancel.cancel();
            }
        }
        Ok(Reply::ScanCancelled {
            scan_id: id.into(),
            accepted,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_report_writer_counts_escaped_bytes() {
        let mut w = Bounded {
            bytes: vec![],
            limit: 16,
        };
        assert!(serde_json::to_writer(&mut w, &"\0".repeat(4)).is_err());
        assert!(w.bytes.len() <= 16);
    }
}
