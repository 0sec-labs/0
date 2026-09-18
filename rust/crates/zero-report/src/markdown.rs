//! Legacy presentation with inert user text and no synthesized clean verdict.
use crate::{Error, MAX_REPORT_BYTES, Report, Result, text};
use serde_json::Value;
const LIMIT: usize = 4 * MAX_REPORT_BYTES;
pub(super) struct Lines(pub(super) String);
impl Lines {
    pub(super) fn line(&mut self, line: &str) -> Result<()> {
        if self
            .0
            .len()
            .checked_add(line.len() + 1)
            .is_none_or(|n| n > LIMIT)
        {
            return Err(Error::Limit);
        }
        if !self.0.is_empty() {
            self.0.push('\n');
        }
        self.0.push_str(line);
        Ok(())
    }
    fn code(&mut self, raw: &str, language: &str) -> Result<()> {
        let longest = raw.split(|c| c != '`').map(str::len).max().unwrap_or(0);
        let fence = "`".repeat(3.max(longest + 1));
        let language = if language.len() <= 32
            && language
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_+-".contains(&b))
        {
            language
        } else {
            ""
        };
        self.line(&format!("{fence}{language}"))?;
        self.line(&controls(raw))?;
        self.line(&fence)
    }
}
fn controls(raw: &str) -> String {
    let mut output = String::new();
    for c in raw.chars() {
        if c.is_control() && !matches!(c, '\n' | '\r' | '\t') {
            output.push_str(&format!("\\u{{{:x}}}", c as u32));
        } else {
            output.push(c);
        }
    }
    output
}

pub(super) fn escape(raw: &str) -> String {
    let mut out = String::new();
    for c in controls(raw).chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\n' => out.push_str("<br>"),
            '\r' => out.push_str("&#13;"),
            '\\' | '`' | '*' | '_' | '[' | ']' | '|' | '#' | '!' | '~' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}
fn optional<'a>(v: &'a Value, key: &'static str) -> Result<Option<&'a str>> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        _ => Err(Error::Field(key)),
    }
}
fn number(v: &Value, key: &'static str) -> Result<Option<f64>> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(n) => n
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map(Some)
            .ok_or(Error::Field(key)),
    }
}
fn count(v: &Value, key: &'static str) -> Result<String> {
    match v.get(key) {
        None | Some(Value::Null) => Ok("not supplied".into()),
        Some(n) => n.as_u64().map(|n| n.to_string()).ok_or(Error::Field(key)),
    }
}
fn array<'a>(v: &'a Value, key: &'static str) -> Result<&'a [Value]> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(a)) => Ok(a),
        _ => Err(Error::Field(key)),
    }
}
fn evidence(lines: &mut Lines, label: &str, raw: Option<&str>) -> Result<()> {
    lines.line(&format!("**{label}:**"))?;
    let raw = raw.unwrap_or("");
    if raw.is_empty() {
        lines.line("")?;
        return lines.line("_(not captured)_");
    }
    let chars = raw.chars().count();
    let body = raw.chars().take(4000).collect::<String>();
    lines.code(&body, "")?;
    if chars > 4000 {
        lines.line(&format!("_Truncated for readability: {} of {chars} characters not shown. Use `--format json` or `--format sarif` for the complete evidence._",chars-4000))?;
    }
    Ok(())
}
impl Report {
    /// Render supplied legacy report data; no inferred verification or clean verdict.
    pub fn markdown(&self) -> Result<String> {
        let r = &self.value;
        let mut lines = Lines(String::new());
        lines.line("# 0sec Scan Report")?;
        lines.line("")?;
        lines.line("| Field | Value |")?;
        lines.line("|-------|-------|")?;
        lines.line(&format!("| Target | {} |", escape(text(r, "target")?)))?;
        lines.line(&format!(
            "| Depth | {} |",
            escape(optional(r, "scanDepth")?.unwrap_or("not supplied"))
        ))?;
        lines.line(&format!("| Started | {} |", escape(text(r, "startedAt")?)))?;
        let duration = number(r, "durationMs")?
            .map_or("not supplied".into(), |n| format!("{:.1}s", n / 1000.0));
        lines.line(&format!("| Duration | {duration} |"))?;
        lines.line("")?;
        lines.line("## Summary")?;
        lines.line("")?;
        if !r["summary"].is_null() && !r["summary"].is_object() {
            return Err(Error::Field("summary"));
        }
        for (key, label) in [
            ("totalAttacks", "Attacks"),
            ("totalFindings", "Findings"),
            ("critical", "Critical"),
            ("high", "High"),
            ("medium", "Medium"),
            ("low", "Low"),
        ] {
            let n = count(&r["summary"], key)?;
            if matches!(key, "totalAttacks" | "totalFindings") || (n != "0" && n != "not supplied")
            {
                lines.line(&format!("- **{label}:** {n}"))?;
            }
        }
        lines.line("")?;
        let warnings = array(r, "warnings")?;
        if !warnings.is_empty() {
            lines.line("## Warnings")?;
            lines.line("")?;
            for w in warnings {
                lines.line(&format!(
                    "- **{}:** {}",
                    escape(text(w, "stage")?),
                    escape(text(w, "message")?)
                ))?;
            }
            lines.line("")?;
        }
        let findings = array(r, "findings")?;
        if findings.is_empty() {
            lines.line("## No findings reported")?;
            lines.line("")?;
            lines.line("This report contains no findings. Rendering does not establish that the target is safe or that all tests ran.")?;
        } else {
            lines.line("## Findings")?;
            lines.line("")?;
            for f in findings {
                finding(&mut lines, f)?;
            }
        }
        Ok(lines.0)
    }
}
fn finding(lines: &mut Lines, f: &Value) -> Result<()> {
    lines.line(&format!(
        "### [{}] {}",
        text(f, "severity")?.to_uppercase(),
        escape(text(f, "title")?)
    ))?;
    lines.line("")?;
    for (key, label) in [("category", "Category"), ("status", "Status")] {
        lines.line(&format!("- **{label}:** {}", escape(text(f, key)?)))?;
    }
    let score = number(f, "cvssScore")?;
    let vector = optional(f, "cvssVector")?.filter(|s| !s.is_empty());
    if score.is_some() || vector.is_some() {
        let score = score.map_or("n/a".into(), |s| s.to_string());
        // Code spans use a longer fence when a supplied vector contains backticks.
        let vector = vector.map_or(String::new(), |s| {
            let max = s.split(|c| c != '`').map(str::len).max().unwrap_or(0);
            let fence = "`".repeat(max + 1);
            if max == 0 && !s.contains(['\n', '\r']) {
                format!(" (`{}`)", controls(s))
            } else {
                format!(
                    " ({fence} {} {fence})",
                    controls(s).replace(['\n', '\r'], " ")
                )
            }
        });
        lines.line(&format!("- **CVSS:** {score}{vector}"))?;
    }
    if let Some(n) = number(f, "confidence")? {
        if n > 1.0 {
            return Err(Error::Field("confidence"));
        }
        lines.line(&format!("- **Confidence:** {}%", (n * 100.0).round()))?;
    }
    if let Some(s) = optional(f, "triageNote")?.filter(|s| !s.is_empty()) {
        lines.line(&format!("- **Triage:** {}", escape(s)))?;
    }
    lines.line(&format!(
        "- **Description:** {}",
        escape(text(f, "description")?)
    ))?;
    lines.line("")?;
    if let Some(s) = optional(&f["evidence"], "analysis")?.filter(|s| !s.is_empty()) {
        lines.line(&format!("**Evidence:** {}", escape(s)))?;
        lines.line("")?;
    }
    let steps = array(f, "pocSteps")?;
    if !steps.is_empty() {
        lines.line("**Reproduction steps:**")?;
        lines.line("")?;
        for (i, step) in steps.iter().take(20).enumerate() {
            lines.line(&format!(
                "{}. **[{}]** {}",
                i + 1,
                escape(text(step, "kind")?),
                escape(text(step, "summary")?)
            ))?;
        }
        if steps.len() > 20 {
            lines.line("")?;
            lines.line(&format!(
                "_{} further step(s) omitted; the full graph is in `--format json`._",
                steps.len() - 20
            ))?;
        }
        lines.line("")?;
    }
    if let Some(remediation) = f.get("remediation").filter(|v| !v.is_null()) {
        remediate(lines, remediation)?;
    }
    lines.line("<details>")?;
    lines.line("<summary>Request / Response</summary>")?;
    lines.line("")?;
    evidence(lines, "Request", optional(&f["evidence"], "request")?)?;
    lines.line("")?;
    evidence(lines, "Response", optional(&f["evidence"], "response")?)?;
    lines.line("</details>")?;
    lines.line("")
}
fn remediate(lines: &mut Lines, r: &Value) -> Result<()> {
    lines.line("**Remediation:**")?;
    lines.line("")?;
    let summary = escape(text(r, "summary")?);
    // Remediation summary occupies its own paragraph: prevent list/thematic
    // breaks and indentation from reinterpreting supplied text as structure.
    let summary = summary.trim_start_matches([' ', '\t']);
    let marker = summary.bytes().take_while(u8::is_ascii_digit).count();
    let mut summary = summary.to_owned();
    if summary.starts_with(['-', '+', '=']) {
        summary.insert(0, '\\');
    } else if marker > 0
        && summary
            .as_bytes()
            .get(marker)
            .is_some_and(|c| matches!(c, b'.' | b')'))
    {
        summary.insert(marker, '\\');
    }
    lines.line(&summary)?;
    let steps = array(r, "steps")?;
    if !steps.is_empty() {
        lines.line("")?;
        for step in steps {
            lines.line(&format!(
                "1. {}",
                escape(step.as_str().ok_or(Error::Field("remediation.steps"))?)
            ))?;
        }
    }
    if let Some(code) = r.get("codeExample").filter(|v| !v.is_null()) {
        lines.line("")?;
        lines.line("<details>")?;
        lines.line("<summary>Suggested change</summary>")?;
        lines.line("")?;
        for (key, label) in [("before", "Before:"), ("after", "After:")] {
            lines.line(label)?;
            lines.line("")?;
            lines.code(text(code, key)?, text(code, "language")?)?;
            if key == "before" {
                lines.line("")?;
            }
        }
        lines.line("</details>")?;
    }
    let refs = array(r, "references")?;
    if !refs.is_empty() {
        lines.line("")?;
        lines.line("References:")?;
        for reference in refs {
            lines.line(&format!(
                "- {}",
                escape(
                    reference
                        .as_str()
                        .ok_or(Error::Field("remediation.references"))?
                )
            ))?;
        }
    }
    lines.line("")
}
