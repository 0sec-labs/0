#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use zero_report::{Error, Report};
const SOURCE: &[u8] = include_bytes!("fixtures/html-report.json");
fn fixture() -> Value {
    serde_json::from_slice(SOURCE).unwrap()
}
fn render(value: &Value) -> String {
    Report::parse(&serde_json::to_vec(value).unwrap())
        .unwrap()
        .html()
        .unwrap()
}
fn contents<'a>(html: &'a str, open: &str, close: &str) -> Vec<&'a str> {
    html.split(open)
        .skip(1)
        .map(|s| s.split_once(close).unwrap().0)
        .collect()
}
#[test]
fn legacy_golden_field_content_severity_order_and_evidence_are_preserved() {
    let out = render(&fixture());
    let golden = include_str!("fixtures/typescript.html");
    // Compare actual TypeScript DOM fields, not our deliberately different CSP,
    // neutral verdict text, deterministic footer or additional proof/remediation.
    for (open, close) in [
        ("<span class=\"finding-title\">", "</span>"),
        ("<p class=\"finding-desc\">", "</p>"),
        ("<span class=\"sev-label\">", "</span>"),
        ("<span class=\"sev-num\">", "</span>"),
        ("<div class=\"big-num\">", "</div>"),
        ("<span class=\"timeline-value\">", "</span>"),
        ("<span class=\"warning-stage\">", "</span>"),
    ] {
        assert_eq!(
            contents(&out, open, close),
            contents(golden, open, close),
            "{open}"
        );
    }
    for tag in contents(golden, "<span class=\"meta-tag\">", "</span>") {
        assert!(
            contents(&out, "<span class=\"meta-tag\">", "</span>").contains(&tag),
            "{tag}"
        );
    }
    for evidence in contents(golden, "<pre><code>", "</code></pre>") {
        assert!(contents(&out, "<pre><code>", "</code></pre>").contains(&evidence));
    }
    assert!(out.contains("<span class=\"meta-tag confirmed\">Confirmed</span>"));
    assert!(out.contains("<h3>Reproduction steps</h3>"));
    assert!(out.contains("<h3>Remediation</h3>"));
    assert!(out.contains("db.query(sql, [input])"));
    assert!(out.contains("<li>https://owasp.org/sqli</li>"));
    assert_eq!(out, render(&fixture()));
}
#[test]
fn every_user_context_is_escaped_and_urls_are_inert_text() {
    let mut r = fixture();
    let attack = "\"><script>alert(1)</script><img src=x onerror=alert(1)><a href='javascript:alert(1)'>click</a>&\u{1b}";
    for key in ["target", "scanDepth", "startedAt", "completedAt"] {
        r[key] = json!(attack);
    }
    r["warnings"] = json!([{"stage":attack,"message":attack}]);
    let f = &mut r["findings"][0];
    for key in [
        "title",
        "category",
        "status",
        "description",
        "triageNote",
        "cvssVector",
    ] {
        f[key] = json!(attack);
    }
    f["evidence"] = json!({"request":attack,"response":attack,"analysis":attack});
    f["semanticDedupe"] = json!({"canonicalId":attack});
    f["pocSteps"] = json!([{"id":"x","kind":attack,"summary":attack,"action":{"type":"note"}}]);
    f["remediation"] = json!({"summary":attack,"steps":[attack],"references":["javascript:alert(1)",attack],"codeExample":{"before":attack,"after":"</code></pre><script>boom</script>","language":attack}});
    let out = render(&r);
    for forbidden in ["<script", "<img", "<a ", "<link", "<iframe", "\u{1b}"] {
        assert!(!out.contains(forbidden), "{forbidden}");
    }
    // Attribute-looking text is preserved as escaped evidence, but never occurs
    // inside an actual tag's attribute list.
    for tag in out
        .split('<')
        .skip(1)
        .filter_map(|s| s.split_once('>').map(|v| v.0))
    {
        for attribute in ["href=", " src=", "onerror=", "onclick="] {
            assert!(!tag.contains(attribute), "{tag}");
        }
    }
    assert!(out.contains("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert!(out.contains("&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;boom&lt;/script&gt;"));
    assert!(out.contains("&#39;javascript:alert(1)&#39;"));
    assert!(out.contains("<li>javascript:alert(1)</li>"));
    assert!(out.contains(
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    ));
    assert_eq!(out.matches("<style>").count(), 1);
}
#[test]
fn evidence_and_proof_truncations_are_visible_and_unicode_safe() {
    let mut r = fixture();
    let f = &mut r["findings"][0];
    f["evidence"]["request"] = json!("😀".repeat(4002));
    f["evidence"]["response"] = json!("");
    f["pocSteps"] = json!(vec![
        json!({"id":"x","kind":"note","summary":"fixture","action":{"type":"note"}});
        23
    ]);
    let out = render(&r);
    assert_eq!(out.matches('😀').count(), 4000);
    assert!(out.contains("</code></pre><p class=\"notice\">Truncated for readability: 2 of 4002 characters not shown."));
    assert!(out.contains("3 further step(s) omitted"));
    assert!(out.contains("(not captured)"));
}
#[test]
fn empty_partial_or_missing_metadata_never_becomes_clean() {
    for warnings in [json!([]), json!([{"stage":"execution","message":"failed"}])] {
        let mut r = fixture();
        r["findings"] = json!([]);
        r["warnings"] = warnings;
        r["summary"] = json!({"totalFindings":0,"totalAttacks":0,"critical":0,"high":0,"medium":0,"low":0,"info":0});
        let out = render(&r);
        assert!(out.contains("No findings reported"));
        assert!(!out.contains("CLEAN"));
        assert!(!out.contains("passed all tests"));
        assert!(!out.contains("Confirmed</span>"));
    }
    let report: Value = serde_json::from_slice(include_bytes!("fixtures/report.json")).unwrap();
    let out = render(&report);
    assert!(out.contains("not supplied"));
    assert!(out.contains(">discovered</span>"));
}
#[test]
fn malformed_optional_fields_fail_without_affecting_existing_exports() {
    for (key, value) in [
        ("durationMs", json!("secret")),
        ("summary", json!([])),
        ("warnings", json!(false)),
    ] {
        let mut r = fixture();
        r[key] = value;
        let report = Report::parse(&serde_json::to_vec(&r).unwrap()).unwrap();
        assert!(report.html().is_err());
        assert!(report.json().is_ok());
        assert!(report.sarif("test").is_ok());
    }
    for key in ["confidence", "cvssScore", "findingRank"] {
        let mut r = fixture();
        r["findings"][0][key] = json!("<script>");
        assert!(
            Report::parse(&serde_json::to_vec(&r).unwrap())
                .unwrap()
                .html()
                .is_err()
        );
    }
}
#[test]
fn html_escape_expansion_is_bounded_without_silently_dropping_findings() {
    let mut r = fixture();
    r["findings"][0]["description"] = json!("&".repeat(14 * 1024 * 1024));
    let input = serde_json::to_vec(&r).unwrap();
    assert!(input.len() < zero_report::MAX_REPORT_BYTES);
    assert!(matches!(
        Report::parse(&input).unwrap().html(),
        Err(Error::Limit)
    ));
}

#[test]
fn severity_sort_keeps_original_order_within_equal_severity() {
    let mut r = fixture();
    let mut first = r["findings"][3].clone();
    first["title"] = json!("first high");
    let mut second = first.clone();
    second["title"] = json!("second high");
    r["findings"] = json!([
        first,
        r["findings"][0].clone(),
        second,
        r["findings"][4].clone()
    ]);
    let out = render(&r);
    assert_eq!(
        contents(&out, "<span class=\"finding-title\">", "</span>"),
        vec![
            "Quoted &quot;title&quot; — Unicode",
            "first high",
            "second high",
            "Finding 4"
        ]
    );
}
