//! Self-contained inert HTML presentation. Supplied findings remain supplied claims.
use crate::{Error, MAX_REPORT_BYTES, Report, Result, text};
use serde_json::Value;
const LIMIT: usize = 4 * MAX_REPORT_BYTES;
const SEVERITIES: [&str; 5] = ["critical", "high", "medium", "low", "info"];
const COLORS: [(&str, &str, &str); 5] = [
    ("#991b1b", "#ffffff", "#f87171"),
    ("#c2410c", "#ffffff", "#fb923c"),
    ("#a16207", "#000000", "#facc15"),
    ("#1d4ed8", "#ffffff", "#60a5fa"),
    ("#4b5563", "#ffffff", "#9ca3af"),
];
pub(super) struct Html(pub(super) String);
impl Html {
    pub(super) fn raw(&mut self, fragment: &str) -> Result<()> {
        if self
            .0
            .len()
            .checked_add(fragment.len())
            .is_none_or(|n| n > LIMIT)
        {
            return Err(Error::Limit);
        }
        self.0.push_str(fragment);
        Ok(())
    }
    pub(super) fn text(&mut self, text: &str) -> Result<()> {
        for c in text.chars() {
            match c {
                '&' => self.raw("&amp;")?,
                '<' => self.raw("&lt;")?,
                '>' => self.raw("&gt;")?,
                '"' => self.raw("&quot;")?,
                '\'' => self.raw("&#39;")?,
                c if c.is_control() && !matches!(c, '\n' | '\r' | '\t') => {
                    self.raw(&format!("\\u{{{:x}}}", c as u32))?
                }
                _ => self.raw(c.encode_utf8(&mut [0; 4]))?,
            }
        }
        Ok(())
    }
    pub(super) fn field(&mut self, open: &str, value: &str, close: &str) -> Result<()> {
        self.raw(open)?;
        self.text(value)?;
        self.raw(close)
    }
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
fn count(v: &Value, key: &'static str) -> Result<Option<u64>> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(n) => n.as_u64().map(Some).ok_or(Error::Field(key)),
    }
}
fn array<'a>(v: &'a Value, key: &'static str) -> Result<&'a [Value]> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(a)) => Ok(a),
        _ => Err(Error::Field(key)),
    }
}
fn displayed_count(value: Option<u64>) -> String {
    value.map_or("not supplied".into(), |n| n.to_string())
}
fn duration(report: &Value) -> Result<String> {
    Ok(
        number(report, "durationMs")?.map_or("not supplied".into(), |n| {
            if n < 1000.0 {
                format!("{n}ms")
            } else {
                format!("{:.1}s", n / 1000.0)
            }
        }),
    )
}
fn category(value: &str) -> String {
    value
        .split('-')
        .map(|s| {
            let mut chars = s.chars();
            chars.next().map_or(String::new(), |c| {
                format!("{}{}", c.to_uppercase(), chars.as_str())
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}
fn tag(html: &mut Html, label: &str, value: &str) -> Result<()> {
    html.raw("<span class=\"meta-tag\">")?;
    html.text(label)?;
    html.text(value)?;
    html.raw("</span>")
}
impl Report {
    /// Deterministic local HTML, no scripts, network resources or active links.
    /// Escaping is not secret redaction, verification or disclosure authority.
    pub fn html(&self) -> Result<String> {
        let r = &self.value;
        let mut html = Html(String::new());
        html.raw("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">\n<title>0sec Report — ")?;
        html.text(text(r, "target")?)?;
        html.raw("</title>\n<style>\n")?;
        html.raw(include_str!("report.css"))?;
        html.raw("\n</style>\n</head>\n<body>\n<div class=\"header\"><div class=\"header-top\"><div><div class=\"brand\">0SEC</div><div class=\"brand-sub\">Security Scan Report</div></div></div><div class=\"meta-grid\">")?;
        let duration = duration(r)?;
        for (label, value) in [
            ("Target:", text(r, "target")?),
            (
                "Depth:",
                optional(r, "scanDepth")?.unwrap_or("not supplied"),
            ),
            ("Duration:", duration.as_str()),
            ("Started:", text(r, "startedAt")?),
        ] {
            html.raw("<span><strong>")?;
            html.text(label)?;
            html.raw("</strong> ")?;
            html.text(value)?;
            html.raw("</span>")?;
        }
        html.raw("</div></div>\n<p class=\"notice\">Findings, severity and status below are supplied report data. Rendering does not verify findings or establish target safety.</p>\n<div class=\"summary-section\"><div class=\"stat-box\"><h3>Findings</h3>")?;
        if !r["summary"].is_null() && !r["summary"].is_object() {
            return Err(Error::Field("summary"));
        }
        html.field(
            "<div class=\"big-num\">",
            &displayed_count(count(&r["summary"], "totalFindings")?),
            "</div><div class=\"sev-counts\">",
        )?;
        let mut counts = Vec::new();
        for (index, severity) in SEVERITIES.iter().enumerate() {
            let n = count(&r["summary"], severity)?;
            counts.push(n);
            html.raw(&format!("<div class=\"sev-count\"><span class=\"sev-dot\" style=\"background:{}\"></span><span class=\"sev-label\">{severity}</span>",COLORS[index].2))?;
            html.field(
                "<span class=\"sev-num\">",
                &displayed_count(n),
                "</span></div>",
            )?;
        }
        html.raw("</div>")?;
        if counts.iter().all(Option::is_some) {
            let total = counts.iter().flatten().map(|n| *n as f64).sum::<f64>();
            if total > 0.0 {
                html.raw("<div class=\"severity-bar\">")?;
                for (index, n) in counts.iter().enumerate() {
                    if let Some(n) = n.filter(|n| *n > 0) {
                        html.raw(&format!("<div class=\"bar-segment\" style=\"width:{}%;background:{}\" title=\"{n} {}\"></div>",n as f64/total*100.0,COLORS[index].2,SEVERITIES[index]))?;
                    }
                }
                html.raw("</div>")?;
            }
        }
        html.raw("</div><div class=\"stat-box\"><h3>Attacks Tested</h3>")?;
        html.field(
            "<div class=\"big-num\">",
            &displayed_count(count(&r["summary"], "totalAttacks")?),
            "</div><div class=\"timeline\">",
        )?;
        for (label, value) in [
            ("Started", text(r, "startedAt")?),
            ("Completed", text(r, "completedAt")?),
            ("Duration", duration.as_str()),
        ] {
            html.field(
                "<div class=\"timeline-row\"><span class=\"timeline-label\">",
                label,
                "</span>",
            )?;
            html.field("<span class=\"timeline-value\">", value, "</span></div>")?;
        }
        html.raw("</div></div></div>\n")?;
        let warnings = array(r, "warnings")?;
        if !warnings.is_empty() {
            html.raw(
                "<div class=\"section\"><h2 class=\"section-title warning-title\">Warnings</h2>",
            )?;
            for warning in warnings {
                html.field(
                    "<div class=\"warning-item\"><span class=\"warning-stage\">",
                    text(warning, "stage")?,
                    "</span> ",
                )?;
                html.text(text(warning, "message")?)?;
                html.raw("</div>")?;
            }
            html.raw("</div>")?;
        }
        html.raw("<div class=\"section\"><h2 class=\"section-title\">Findings</h2>")?;
        let mut findings = array(r, "findings")?.iter().collect::<Vec<_>>();
        findings.sort_by_key(|f| SEVERITIES.iter().position(|s| f["severity"] == *s));
        if findings.is_empty() {
            html.raw("<div class=\"no-findings\">No findings reported. This does not establish that the target is safe or that all tests ran.</div>")?;
        }
        for finding in findings {
            render_finding(&mut html, finding)?;
        }
        html.raw("</div>\n<div class=\"footer\">Rendered by 0sec. No external resources, scripts or automatic uploads.</div>\n</body>\n</html>")?;
        Ok(html.0)
    }
}
fn render_finding(html: &mut Html, f: &Value) -> Result<()> {
    let severity = text(f, "severity")?;
    let index = SEVERITIES
        .iter()
        .position(|s| *s == severity)
        .ok_or(Error::Field("severity"))?;
    html.raw(&format!("<div class=\"finding-card\"><div class=\"finding-header\"><span class=\"severity-badge\" style=\"background:{};color:{}\">{}</span>",COLORS[index].0,COLORS[index].1,severity.to_uppercase()))?;
    html.field(
        "<span class=\"finding-title\">",
        text(f, "title")?,
        "</span></div><div class=\"finding-meta\">",
    )?;
    tag(html, "Category: ", &category(text(f, "category")?))?;
    if text(f, "status")? == "confirmed" {
        html.raw("<span class=\"meta-tag confirmed\">Confirmed</span>")?;
    } else {
        tag(html, "", text(f, "status")?)?;
    }
    if let Some(confidence) = number(f, "confidence")? {
        if confidence > 1.0 {
            return Err(Error::Field("confidence"));
        }
        tag(
            html,
            "Confidence: ",
            &format!("{}%", (confidence * 100.0).round()),
        )?;
    }
    if let Some(cvss) = number(f, "cvssScore")? {
        tag(html, "CVSS: ", &format!("{cvss:.1}"))?;
    }
    if let Some(rank) = number(f, "findingRank")? {
        tag(html, "Rank: ", &rank.to_string())?;
    }
    if let Some(dedupe) = f.get("semanticDedupe").filter(|v| !v.is_null()) {
        let id = text(dedupe, "canonicalId")?;
        tag(
            html,
            "Canonical: ",
            &format!("{}…", id.chars().take(12).collect::<String>()),
        )?;
    }
    if let Some(vector) = optional(f, "cvssVector")?.filter(|s| !s.is_empty()) {
        tag(html, "CVSS vector: ", vector)?;
    }
    html.raw("</div>")?;
    if let Some(note) = optional(f, "triageNote")?.filter(|s| !s.is_empty()) {
        html.field("<p class=\"notice\">Triage: ", note, "</p>")?;
    }
    html.field(
        "<p class=\"finding-desc\">",
        text(f, "description")?,
        "</p>",
    )?;
    if let Some(analysis) = optional(&f["evidence"], "analysis")?.filter(|s| !s.is_empty()) {
        html.field(
            "<div class=\"evidence-analysis\"><strong>Analysis:</strong> ",
            analysis,
            "</div>",
        )?;
    }
    let steps = array(f, "pocSteps")?;
    if !steps.is_empty() {
        html.raw("<div class=\"proof\"><h3>Reproduction steps</h3><ol>")?;
        for step in steps.iter().take(20) {
            html.field("<li><strong>[", text(step, "kind")?, "]</strong> ")?;
            html.text(text(step, "summary")?)?;
            html.raw("</li>")?;
        }
        html.raw("</ol>")?;
        if steps.len() > 20 {
            html.raw(&format!("<p class=\"notice\">{} further step(s) omitted; use --format json for the full graph.</p>",steps.len()-20))?;
        }
        html.raw("</div>")?;
    }
    if let Some(remediation) = f.get("remediation").filter(|v| !v.is_null()) {
        render_remediation(html, remediation)?;
    }
    html.raw("<details class=\"evidence-details\"><summary>Request / Response</summary>")?;
    for (key, label) in [("request", "Request"), ("response", "Response")] {
        html.field(
            "<div class=\"evidence-block\"><div class=\"evidence-label\">",
            label,
            "</div>",
        )?;
        let raw = optional(&f["evidence"], key)?.unwrap_or("");
        if raw.is_empty() {
            html.raw("<p class=\"notice\">(not captured)</p>")?;
        } else {
            html.field(
                "<pre><code>",
                &raw.chars().take(4000).collect::<String>(),
                "</code></pre>",
            )?;
            let count = raw.chars().count();
            if count > 4000 {
                html.raw(&format!("<p class=\"notice\">Truncated for readability: {} of {count} characters not shown. Use --format json or --format sarif for complete evidence.</p>",count-4000))?;
            }
        }
        html.raw("</div>")?;
    }
    html.raw("</details></div>\n")
}
fn render_remediation(html: &mut Html, r: &Value) -> Result<()> {
    html.raw("<div class=\"remediation\"><h3>Remediation</h3>")?;
    html.field("<p>", text(r, "summary")?, "</p>")?;
    let steps = array(r, "steps")?;
    if !steps.is_empty() {
        html.raw("<ol>")?;
        for step in steps {
            html.field(
                "<li>",
                step.as_str().ok_or(Error::Field("remediation.steps"))?,
                "</li>",
            )?;
        }
        html.raw("</ol>")?;
    }
    if let Some(code) = r.get("codeExample").filter(|v| !v.is_null()) {
        html.raw("<details><summary>Suggested change</summary>")?;
        if let Some(language) = optional(code, "language")? {
            html.field("<p>Language: ", language, "</p>")?;
        }
        for (key, label) in [("before", "Before"), ("after", "After")] {
            html.field("<h4>", label, "</h4>")?;
            html.field("<pre><code>", text(code, key)?, "</code></pre>")?;
        }
        html.raw("</details>")?;
    }
    let references = array(r, "references")?;
    if !references.is_empty() {
        html.raw("<h4>References</h4><ul>")?;
        for reference in references {
            html.field(
                "<li>",
                reference
                    .as_str()
                    .ok_or(Error::Field("remediation.references"))?,
                "</li>",
            )?;
        }
        html.raw("</ul>")?;
    }
    html.raw("</div>")
}
