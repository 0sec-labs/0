//! Native reports and explicit legacy stdout framing. No uploads or scans.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{io::Write, path::Path};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid report or wire payload: {0}")]
    Invalid(&'static str),
    #[error("report serialization failed")]
    Json(#[from] serde_json::Error),
    #[error("report file operation failed")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    Completed,
    Findings,
    Error,
    CostCeilingExceeded,
    Cancelled,
}
impl RunOutcome {
    pub fn exit_code(self) -> u8 {
        match self {
            Self::Completed => 0,
            Self::Findings => 1,
            Self::Error => 2,
            Self::CostCeilingExceeded => 4,
            Self::Cancelled => 130,
        }
    }
    pub fn reason(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Findings => "findings",
            Self::Error => "error",
            Self::CostCeilingExceeded => "cost_ceiling_exceeded",
            Self::Cancelled => "cancelled",
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecureStatus {
    Completed,
    Blocked,
    Failed,
    Cancelled,
}
/// SecureProjectResult's terminal envelope. Nested findings/repairs retain
/// their original schemas until the specialist implementations are migrated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureResult {
    pub version: u32,
    pub run_id: String,
    pub status: SecureStatus,
    pub phase: String,
    pub repo_root: String,
    pub revision: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    pub findings: Vec<Value>,
    pub repairs: Vec<Value>,
    pub errors: Vec<String>,
    pub pull_requests: Vec<String>,
}
impl SecureStatus {
    pub fn exit_code(self) -> u8 {
        match self {
            Self::Completed => 0,
            Self::Blocked => 2,
            Self::Failed => 3,
            Self::Cancelled => 130,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub total_findings: u64,
    pub critical: u64,
    pub high: u64,
    pub medium: u64,
    pub low: u64,
    pub info: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Completeness {
    Complete,
    Partial,
    Failed,
    Cancelled,
}
/// A cumulative snapshot, never a delta. Unknown fields remain None, never zero.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostSnapshot {
    pub session_id: String,
    pub sequence: u64,
    pub provenance: String,
    pub cost_usd: Option<f64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
}
impl CostSnapshot {
    fn validate(&self) -> Result<(), Error> {
        if self.session_id.is_empty()
            || self.provenance.is_empty()
            || self.cost_usd.is_some_and(|v| !v.is_finite() || v < 0.0)
            || matches!((self.cached_input_tokens, self.input_tokens), (Some(c),Some(i)) if c > i)
        {
            return Err(Error::Invalid("cost provenance or totals"));
        }
        Ok(())
    }
    pub fn event_payload(&self) -> Result<Value, Error> {
        self.validate()?;
        let mut payload = json!({"session_id":self.session_id,"sequence":self.sequence,"provenance":self.provenance,"cumulative":true});
        let object = payload
            .as_object_mut()
            .ok_or(Error::Invalid("cost object"))?;
        if let Some(cost) = self.cost_usd {
            object.insert("cost_usd".into(), json!(cost));
        }
        for (name, value) in [
            ("input_tokens", self.input_tokens),
            ("token_input", self.input_tokens),
            ("output_tokens", self.output_tokens),
            ("token_output", self.output_tokens),
            ("cached_input_tokens", self.cached_input_tokens),
        ] {
            if let Some(value) = value {
                object.insert(name.into(), json!(value));
            }
        }
        Ok(payload)
    }
}

/// Canonical local report envelope. The original command report stays intact.
/// Findings are caller-supplied evidence; no default empty successful report exists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinalReport {
    pub version: u32,
    pub command: String,
    pub outcome: RunOutcome,
    pub completeness: Completeness,
    pub target: String,
    pub target_type: Option<String>,
    pub runtime: String,
    pub format: String,
    pub summary: Option<Summary>,
    pub cost: Option<CostSnapshot>,
    pub error: Option<String>,
    pub report: Value,
}
impl FinalReport {
    pub fn validate(&self) -> Result<(), Error> {
        if self.version != 1 || self.command.is_empty() || !self.report.is_object() {
            return Err(Error::Invalid("report envelope"));
        }
        if matches!(self.outcome, RunOutcome::Completed | RunOutcome::Findings)
            && !matches!(self.completeness, Completeness::Complete)
        {
            return Err(Error::Invalid("partial work cannot be a clean completion"));
        }
        if let Some(cost) = &self.cost {
            cost.validate()?;
        }
        Ok(())
    }
    /// Generic run.ts ABI, distinct from secure's terminal result schema.
    pub fn run_result(&self) -> Result<Value, Error> {
        self.validate()?;
        if self.command == "secure" {
            return Err(Error::Invalid("secure requires its own result adapter"));
        }
        let mut result = json!({"ok":self.outcome == RunOutcome::Completed,"exitCode":self.outcome.exit_code(),"exit_reason":self.outcome.reason(),"target":self.target,"runtime":self.runtime,"format":self.format});
        let object = result
            .as_object_mut()
            .ok_or(Error::Invalid("result object"))?;
        if let Some(value) = &self.target_type {
            object.insert("targetType".into(), json!(value));
        }
        if let Some(value) = &self.error {
            object.insert("error".into(), json!(value));
        }
        if let Some(value) = &self.summary {
            object.insert("summary".into(), serde_json::to_value(value)?);
            object.insert("finding_count".into(), json!(value.total_findings));
        }
        if let Some(cost) = &self.cost {
            if let Some(value) = cost.cost_usd {
                object.insert("cost_usd".into(), json!(value));
                object.insert("estimatedCostUsd".into(), json!(value));
            }
            if let Some(value) = cost.input_tokens {
                object.insert("token_input".into(), json!(value));
            }
            if let Some(value) = cost.output_tokens {
                object.insert("token_output".into(), json!(value));
            }
            if let (Some(input), Some(output)) = (cost.input_tokens, cost.output_tokens) {
                object.insert(
                    "usage".into(),
                    json!({"inputTokens":input,"outputTokens":output}),
                );
            }
        }
        Ok(result)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WirePolicy {
    pub results: bool,
    pub events: bool,
}
impl WirePolicy {
    /// Environment lookup is explicit so tests/embedders need no global mutation.
    pub fn from_lookup(mut get: impl FnMut(&str) -> Option<String>) -> Self {
        let results = get("0SEC_EMIT_RESULT_LINE").as_deref() == Some("1")
            || get("0SEC_CLOUD_SINK").is_some_and(|s| !s.is_empty());
        let events = get("0SEC_CLOUD_EVENTS")
            .is_some_and(|s| !s.is_empty() && s != "0" && !s.eq_ignore_ascii_case("false"));
        Self { results, events }
    }
    pub fn result_line(self, payload: &Value) -> Result<Option<String>, Error> {
        if self.results {
            Ok(Some(object_line("0SEC_RESULT=", payload)?))
        } else {
            Ok(None)
        }
    }
    pub fn event_line(self, event_type: &str, payload: &Value) -> Result<Option<String>, Error> {
        if event_type.is_empty()
            || !event_type
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err(Error::Invalid("event type"));
        }
        if !self.events {
            return Ok(None);
        }
        Ok(Some(object_line(
            &format!("0SEC_EVENT_{} ", event_type.to_ascii_uppercase()),
            payload,
        )?))
    }
    pub fn secure_event_line(self, payload: &Value) -> Result<Option<String>, Error> {
        if self.results {
            Ok(Some(object_line("0SEC_SECURE_EVENT=", payload)?))
        } else {
            Ok(None)
        }
    }
}
fn object_line(prefix: &str, payload: &Value) -> Result<String, Error> {
    if !payload.is_object() {
        return Err(Error::Invalid("wire payload must be an object"));
    }
    Ok(format!("{prefix}{}\n", serde_json::to_string(payload)?))
}
/// Preserve SecureProjectResult fields without coercing it into generic run output.
pub fn secure_result_line(
    policy: WirePolicy,
    payload: &Value,
) -> Result<(u8, Option<String>), Error> {
    let result: SecureResult = serde_json::from_value(payload.clone())
        .map_err(|_| Error::Invalid("secure result fields"))?;
    if result.version != 1 {
        return Err(Error::Invalid("secure result fields"));
    }
    Ok((result.status.exit_code(), policy.result_line(payload)?))
}
/// Validated canonical native report writer.
pub fn write_final_report(path: &Path, report: &FinalReport) -> Result<(), Error> {
    report.validate()?;
    write_report(path, report)
}
/// Serialize before replacing. All failures before rename preserve the old file.
/// Parent must exist; no paths are selected from environment implicitly.
pub fn write_report<T: Serialize>(path: &Path, report: &T) -> Result<(), Error> {
    let mut bytes = serde_json::to_vec_pretty(report)?;
    bytes.push(b'\n');
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(&bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|error| Error::Io(error.error))?;
    // No post-rename failure is reported as an uncommitted write.
    Ok(())
}
