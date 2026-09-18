#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use zero_report::Report;
const SOURCE: &[u8] = include_bytes!("fixtures/markdown-report.json");
fn fixture() -> Value {
    serde_json::from_slice(SOURCE).unwrap()
}
fn render(value: &Value) -> String {
    Report::parse(&serde_json::to_vec(value).unwrap())
        .unwrap()
        .markdown()
        .unwrap()
}
#[test]
fn ordinary_legacy_enrichment_matches_actual_typescript_byte_for_byte() {
    assert_eq!(
        Report::parse(SOURCE).unwrap().markdown().unwrap(),
        include_str!("fixtures/typescript.markdown.md")
    );
}
#[test]
fn hostile_markup_cannot_inject_links_html_headings_tables_or_close_code_fences() {
    let mut r = fixture();
    r["target"] = json!("target | injected\n# heading <script>alert(1)</script>");
    r["findings"][0]["title"] =
        json!("[click](javascript:alert(1)) ![image](https://example.invalid/a) **claim**");
    r["findings"][0]["description"] =
        json!("<img src=x onerror=alert(1)> &lt;svg&gt;\n# heading\u{1b}[31m");
    r["findings"][0]["evidence"]["request"] =
        json!("```\n# injected\n<script>code only</script>\n````");
    r["findings"][0]["remediation"]["codeExample"]["before"] =
        json!("```\n<script>code only</script>");
    r["findings"][0]["remediation"]["codeExample"]["language"] = json!("js\n```\n<script>");
    r["findings"][0]["remediation"]["references"] =
        json!(["[link](javascript:alert(1))", "<https://evil.invalid/>"]);
    let out = render(&r);
    assert!(out.contains("target \\| injected<br>\\# heading &lt;script&gt;"));
    assert!(out.contains("\\[click\\](javascript:alert(1))"));
    assert!(out.contains("\\!\\[image\\]"));
    assert!(out.contains("&lt;img src=x onerror=alert(1)&gt; &amp;lt;svg&amp;gt;"));
    assert!(!out.contains('\u{1b}'));
    assert!(out.contains("`````\n```\n# injected\n<script>code only</script>\n````\n`````"));
    assert!(!out.contains("```js\n"));
    assert!(out.contains("- &lt;https://evil.invalid/&gt;"));
}
#[test]
fn evidence_and_poc_elisions_are_explicit_and_unicode_boundaries_remain_valid() {
    let mut r = fixture();
    r["findings"][0]["evidence"]["request"] = json!("😀".repeat(4001));
    r["findings"][0]["evidence"]["response"] = json!("");
    let step = r["findings"][0]["pocSteps"][0].clone();
    r["findings"][0]["pocSteps"] = json!(vec![step; 25]);
    let out = render(&r);
    assert_eq!(out.matches('😀').count(), 4000);
    assert!(out.contains("```\n_Truncated for readability: 1 of 4001 characters not shown"));
    assert!(out.contains("5 further step(s) omitted"));
    assert!(out.contains("_(not captured)_"));
}
#[test]
fn empty_failed_reports_never_acquire_a_clean_or_verified_verdict() {
    let mut r = fixture();
    r["findings"] = json!([]);
    r["warnings"] = json!([]);
    let out = render(&r);
    assert!(out.contains("No findings reported"));
    assert!(!out.contains("passed all tests"));
    assert!(!out.contains("No Vulnerabilities Found"));
    let r: Value = serde_json::from_slice(include_bytes!("fixtures/report.json")).unwrap();
    let out = render(&r);
    assert!(out.contains("| Duration | not supplied |"));
    assert!(out.contains("- **Status:** discovered"));
    assert!(!out.contains("**Remediation:**"));
    assert!(!out.contains("undefined"));
}
#[test]
fn malformed_markdown_fields_fail_locally_without_changing_json_acceptance() {
    for (key, value) in [
        ("warnings", json!("secret")),
        ("durationMs", json!(-1)),
        ("summary", json!([])),
    ] {
        let mut r = fixture();
        r[key] = value;
        let report = Report::parse(&serde_json::to_vec(&r).unwrap()).unwrap();
        assert!(report.markdown().is_err());
        assert!(report.json().is_ok());
        assert!(report.sarif("fixture").is_ok());
    }
}

#[test]
fn standalone_remediation_cannot_create_lists_or_thematic_breaks() {
    for (raw, expected) in [
        ("- injected", "\\- injected"),
        ("1. injected", "1\\. injected"),
        ("1) injected", "1\\) injected"),
        ("+ injected", "\\+ injected"),
        ("---", "\\---"),
    ] {
        let mut r = fixture();
        r["findings"][0]["remediation"]["summary"] = json!(raw);
        assert!(render(&r).contains(&format!("**Remediation:**\n\n{expected}\n")));
    }
}

#[test]
fn escaped_text_expansion_fails_at_output_limit_instead_of_truncating_a_finding() {
    let mut r = fixture();
    r["findings"][0]["description"] = json!("&".repeat(14 * 1024 * 1024));
    let input = serde_json::to_vec(&r).unwrap();
    assert!(input.len() < zero_report::MAX_REPORT_BYTES);
    assert!(matches!(
        Report::parse(&input).unwrap().markdown(),
        Err(zero_report::Error::Limit)
    ));
}
