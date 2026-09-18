//! Pure legacy report renderers. Rendering never establishes finding validity.
mod markdown;
use serde_json::{Value, json};
use std::collections::HashSet;
pub const MAX_REPORT_BYTES: usize = 16 * 1024 * 1024;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid report field: {0}")]
    Field(&'static str),
    #[error("report size or finding limit exceeded")]
    Limit,
    #[error("invalid report JSON")]
    Json,
}
pub type Result<T> = std::result::Result<T, Error>;
/// Validated renderer input, retaining unknown additive fields in JSON output.
/// This is not a scanner, verifier, redactor or disclosure authorization object.
pub struct Report {
    value: Value,
}
impl Report {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_REPORT_BYTES {
            return Err(Error::Limit);
        }
        let value: Value = serde_json::from_slice(bytes).map_err(|_| Error::Json)?;
        for key in ["target", "startedAt", "completedAt"] {
            text(&value, key)?;
        }
        if value
            .get("executionSuccessful")
            .is_some_and(|v| !v.is_boolean())
        {
            return Err(Error::Field("executionSuccessful"));
        }
        let findings = value["findings"]
            .as_array()
            .ok_or(Error::Field("findings"))?;
        if findings.len() > 10_000 {
            return Err(Error::Limit);
        }
        for finding in findings {
            for key in [
                "id",
                "templateId",
                "title",
                "description",
                "severity",
                "category",
                "status",
            ] {
                text(finding, key)?;
            }
            level(finding)?;
            if !finding["evidence"].is_object() {
                return Err(Error::Field("evidence"));
            }
            if let Some(steps) = finding.get("pocSteps").filter(|v| !v.is_null()) {
                let steps = steps.as_array().ok_or(Error::Field("pocSteps"))?;
                if steps.len() > 10_000 {
                    return Err(Error::Limit);
                }
                for step in steps {
                    for key in ["id", "kind", "summary"] {
                        text(step, key)?;
                    }
                    action_summary(&step["action"])?;
                }
            }
        }
        Ok(Self { value })
    }
    /// All original report fields remain present. Object ordering is not a wire
    /// contract; callers should compare JSON values rather than whitespace.
    pub fn json(&self) -> Result<String> {
        bounded_pretty(&self.value, 4 * MAX_REPORT_BYTES)
    }
    /// Match the existing TypeScript SARIF renderer on validated legacy reports.
    /// The caller supplies the actual exporting product version explicitly.
    pub fn sarif(&self, version: &str) -> Result<String> {
        if version.is_empty() || version.len() > 128 || version.chars().any(char::is_control) {
            return Err(Error::Field("exporter version"));
        }
        let target = text(&self.value, "target")?;
        let findings = self.value["findings"]
            .as_array()
            .ok_or(Error::Field("findings"))?;
        // Bound expansion before building a result tree: a long target URI
        // repeated across thousands of steps must not allocate unbounded memory.
        let target_bytes = serde_json::to_vec(&self.value["target"])
            .map_err(|_| Error::Json)?
            .len();
        let mut expansion = serde_json::to_vec(&self.value)
            .map_err(|_| Error::Json)?
            .len();
        for finding in findings {
            let steps = finding
                .get("pocSteps")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let own = serde_json::to_vec(finding).map_err(|_| Error::Json)?.len();
            expansion = expansion
                .checked_add(own.checked_mul(8).ok_or(Error::Limit)?)
                .and_then(|n| n.checked_add(target_bytes.checked_mul(steps + 2)?))
                .and_then(|n| n.checked_add((steps + 1).checked_mul(512)?))
                .ok_or(Error::Limit)?;
            if expansion > 4 * MAX_REPORT_BYTES {
                return Err(Error::Limit);
            }
        }
        let mut seen = HashSet::new();
        let mut rules = Vec::new();
        let mut results = Vec::new();
        for finding in findings {
            let template = text(finding, "templateId")?;
            let severity = level(finding)?;
            if seen.insert(template) {
                rules.push(json!({"id":template,"name":finding["title"],"shortDescription":{"text":finding["title"]},"defaultConfiguration":{"level":severity},"properties":{"category":finding["category"],"severity":finding["severity"]}}));
            }
            let fingerprint = [
                finding
                    .get("fingerprint")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                template,
                text(finding, "category")?,
                text(finding, "title")?,
                target,
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("|");
            let mut properties = json!({"findingId":finding["id"],"category":finding["category"],"severity":finding["severity"],"status":finding["status"],"evidence":finding["evidence"]});
            for key in ["cvssScore", "confidence", "findingRank"] {
                if let Some(value) = finding.get(key) {
                    properties[key] = value.clone();
                }
            }
            for (from, to) in [
                ("cvssVector", "cvssVector"),
                ("publishability", "publishability"),
                ("noveltyVerdict", "noveltyVerdict"),
                ("dedupRefs", "dedupRefs"),
                ("advisoryMatches", "advisoryMatches"),
                ("verification_result", "verificationResult"),
                ("inlineValidation", "inlineValidation"),
                ("supplyChain", "supplyChain"),
                ("kernelExploit", "kernelExploit"),
                ("semanticDedupe", "semanticDedupe"),
            ] {
                if let Some(value) = finding.get(from).filter(|v| truthy(v)) {
                    properties[to] = value.clone();
                }
            }
            let mut result = json!({"ruleId":template,"level":severity,"message":{"text":finding["description"]},"locations":[{"physicalLocation":{"artifactLocation":{"uri":target}}}],"partialFingerprints":{"primary":fingerprint},"properties":properties});
            if let Some(steps) = finding
                .get("pocSteps")
                .and_then(Value::as_array)
                .filter(|s| !s.is_empty())
            {
                let mut locations = Vec::new();
                for step in steps {
                    let mut properties = json!({"stepId":step["id"],"kind":step["kind"],"action":action_summary(&step["action"])?});
                    if let Some(expect) = step.get("expect") {
                        properties["expect"] = expect.clone();
                    }
                    locations.push(json!({"location":{"physicalLocation":{"artifactLocation":{"uri":target}},"message":{"text":format!("{}: {}",text(step,"kind")?,text(step,"summary")?)},"properties":properties}}));
                }
                result["codeFlows"] = json!([{"threadFlows":[{"locations":locations}]}]);
            }
            results.push(result);
        }
        let sarif = json!({"$schema":"https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json","version":"2.1.0","runs":[{"tool":{"driver":{"name":"0sec","version":version,"informationUri":"https://github.com/0sec-labs/0sec","rules":rules}},"results":results,"invocations":[{"executionSuccessful":self.value.get("executionSuccessful")!=Some(&Value::Bool(false)),"startTimeUtc":self.value["startedAt"],"endTimeUtc":self.value["completedAt"]}]}]});
        bounded_pretty(&sarif, 4 * MAX_REPORT_BYTES)
    }
}
fn text<'a>(value: &'a Value, key: &'static str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(Error::Field(key))
}
fn level(finding: &Value) -> Result<&'static str> {
    match text(finding, "severity")? {
        "critical" | "high" => Ok("error"),
        "medium" => Ok("warning"),
        "low" | "info" => Ok("note"),
        _ => Err(Error::Field("severity")),
    }
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64() != Some(0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn action_summary(action: &Value) -> Result<Value> {
    let kind = text(action, "type")?;
    let mut output = json!({"type":kind});
    let fields: &[(&str, &str)] = match kind {
        "shell" => &[("cmd", "command"), ("cwd", "cwd")],
        "http" => &[("method", "method"), ("url", "url"), ("headers", "headers")],
        "docker" => &[("image", "image"), ("args", "args")],
        "note" => &[],
        _ => return Err(Error::Field("action.type")),
    };
    for (source, dest) in fields {
        if let Some(value) = action.get(*source) {
            output[*dest] = value.clone();
        }
    }
    Ok(output)
}

fn bounded_pretty(value: &Value, limit: usize) -> Result<String> {
    struct Writer {
        bytes: Vec<u8>,
        limit: usize,
        exceeded: bool,
    }
    impl std::io::Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self
                .bytes
                .len()
                .checked_add(bytes.len())
                .is_none_or(|n| n > self.limit)
            {
                self.exceeded = true;
                return Err(std::io::Error::other("report output limit"));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Writer {
        bytes: Vec::new(),
        limit,
        exceeded: false,
    };
    if serde_json::to_writer_pretty(&mut writer, value).is_err() {
        return Err(if writer.exceeded {
            Error::Limit
        } else {
            Error::Json
        });
    }
    String::from_utf8(writer.bytes).map_err(|_| Error::Json)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pretty_print_expansion_is_capped_during_serialization() {
        let value = json!({"nested":{"key":["a","b","c"]}});
        let compact = serde_json::to_vec(&value).unwrap();
        assert!(matches!(
            bounded_pretty(&value, compact.len()),
            Err(Error::Limit)
        ));
        assert_eq!(
            serde_json::from_str::<Value>(&bounded_pretty(&value, 1024).unwrap()).unwrap(),
            value
        );
    }
}
