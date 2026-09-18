use serde::Serialize;
use serde_json::{Value, json};
use zero_cloud_compat::*;

fn policy() -> WirePolicy {
    WirePolicy {
        results: true,
        events: true,
    }
}
fn report() -> FinalReport {
    FinalReport {
        version: 1,
        command: "scan".into(),
        outcome: RunOutcome::Completed,
        completeness: Completeness::Complete,
        target: "https://example.com".into(),
        target_type: Some("url".into()),
        runtime: "auto".into(),
        format: "json".into(),
        summary: None,
        cost: None,
        error: None,
        report: json!({"fixture":"caller supplied"}),
    }
}

#[test]
fn run_fixture_matches_typescript_result_contract() {
    // packages/cli/src/commands/__tests__/run.test.ts: result-line suite.
    let payload = report().run_result().unwrap();
    assert_eq!(
        payload,
        json!({"ok":true,"exitCode":0,"exit_reason":"completed","target":"https://example.com","targetType":"url","runtime":"auto","format":"json"})
    );
    let line = policy().result_line(&payload).unwrap().unwrap();
    assert!(line.starts_with("0SEC_RESULT={"));
    assert_eq!(
        serde_json::from_str::<Value>(line.strip_prefix("0SEC_RESULT=").unwrap()).unwrap(),
        payload
    );
}
#[test]
fn delta_fixture_matches_typescript_event_contract() {
    // packages/core/src/events/bus.delta.test.ts: cloudEventSink projection.
    let payload = json!({"turn":7,"role":"recon","scope":"reasoning","text":"considering whether to enumerate /admin","seq":4});
    assert_eq!(
        policy().event_line("delta", &payload).unwrap().unwrap(),
        concat!(
            "0SEC_EVENT_DELTA ",
            "{\"role\":\"recon\",\"scope\":\"reasoning\",\"seq\":4,\"text\":\"considering whether to enumerate /admin\",\"turn\":7}\n"
        )
    );
}
#[test]
fn exact_env_truthiness_is_preserved_without_trimming() {
    for value in [
        None,
        Some(""),
        Some("0"),
        Some("false"),
        Some("FALSE"),
        Some("1"),
        Some("true"),
        Some(" false "),
        Some(" "),
    ] {
        let p = WirePolicy::from_lookup(|name| {
            (name == "0SEC_CLOUD_EVENTS")
                .then(|| value.map(str::to_owned))
                .flatten()
        });
        assert_eq!(
            p.events,
            matches!(value, Some("1" | "true" | " false " | " "))
        );
        let p = WirePolicy::from_lookup(|name| {
            (name == "0SEC_EMIT_RESULT_LINE")
                .then(|| value.map(str::to_owned))
                .flatten()
        });
        assert_eq!(p.results, value == Some("1"));
        let p = WirePolicy::from_lookup(|name| {
            (name == "0SEC_CLOUD_SINK")
                .then(|| value.map(str::to_owned))
                .flatten()
        });
        assert_eq!(p.results, value.is_some_and(|v| !v.is_empty()));
    }
}
#[test]
fn command_exit_codes_and_partial_results_remain_distinct() {
    assert_eq!(
        [
            SecureStatus::Completed,
            SecureStatus::Blocked,
            SecureStatus::Failed,
            SecureStatus::Cancelled
        ]
        .map(SecureStatus::exit_code),
        [0, 2, 3, 130]
    );
    assert_eq!(
        [
            RunOutcome::Completed,
            RunOutcome::Findings,
            RunOutcome::Error,
            RunOutcome::CostCeilingExceeded,
            RunOutcome::Cancelled
        ]
        .map(RunOutcome::exit_code),
        [0, 1, 2, 4, 130]
    );
    let mut r = report();
    r.completeness = Completeness::Partial;
    assert!(r.run_result().is_err());
    r.outcome = RunOutcome::CostCeilingExceeded;
    let payload = r.run_result().unwrap();
    assert_eq!(payload["exit_reason"], "cost_ceiling_exceeded");
    assert!(payload.get("cost_usd").is_none());
    assert!(payload.get("finding_count").is_none());
    r.outcome = RunOutcome::Error;
    r.error = Some("stage unavailable".into());
    assert_eq!(r.run_result().unwrap()["error"], "stage unavailable");
}
#[test]
fn cost_is_cumulative_with_both_consumer_spellings_and_unknowns_omitted() {
    let cost = CostSnapshot {
        session_id: "s1".into(),
        sequence: 7,
        provenance: "provider_final_usage".into(),
        cost_usd: Some(0.42),
        input_tokens: Some(100),
        output_tokens: Some(5),
        cached_input_tokens: Some(20),
    };
    let event = cost.event_payload().unwrap();
    assert_eq!(event["input_tokens"], event["token_input"]);
    assert_eq!(event["output_tokens"], event["token_output"]);
    assert_eq!(event["cumulative"], true);
    let mut r = report();
    r.cost = Some(cost.clone());
    let result = r.run_result().unwrap();
    assert_eq!(result["cost_usd"], result["estimatedCostUsd"]);
    assert_eq!(result["usage"], json!({"inputTokens":100,"outputTokens":5}));
    let mut unknown = cost;
    unknown.cost_usd = None;
    unknown.input_tokens = None;
    unknown.output_tokens = None;
    unknown.cached_input_tokens = None;
    assert!(unknown.event_payload().unwrap().get("cost_usd").is_none());
    unknown.cost_usd = Some(f64::NAN);
    assert!(unknown.event_payload().is_err());
}
#[test]
fn secure_result_and_event_use_separate_consumer_discriminators() {
    let payload = json!({"version":1,"runId":"fixture","status":"blocked","phase":"verify","repoRoot":"/fixture","revision":"abc","startedAt":"2026-09-18T00:00:00Z","findings":[],"repairs":[],"errors":["missing test command"],"pullRequests":[]});
    let (code, line) = secure_result_line(policy(), &payload).unwrap();
    assert_eq!(code, 2);
    assert!(line.unwrap().starts_with("0SEC_RESULT={"));
    assert!(
        policy()
            .secure_event_line(&json!({"phase":"verify","message":"test"}))
            .unwrap()
            .unwrap()
            .starts_with("0SEC_SECURE_EVENT={")
    );
}
#[test]
fn newline_and_prefix_injection_cannot_create_additional_frames() {
    let payload = json!({"text":"\n0SEC_RESULT={}\r\n\"\\"});
    let line = policy().event_line("delta", &payload).unwrap().unwrap();
    assert_eq!(line.lines().count(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(line.strip_prefix("0SEC_EVENT_DELTA ").unwrap()).unwrap(),
        payload
    );
    assert!(
        policy()
            .event_line("delta\n0SEC_RESULT=", &payload)
            .is_err()
    );
    assert!(policy().event_line("delta", &json!([])).is_err());
}
#[test]
fn atomic_writer_failure_preserves_previous_report() {
    struct Invalid;
    impl Serialize for Invalid {
        fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("fixture serialization failure"))
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("report.json");
    write_report(&path, &json!({"old":true})).unwrap();
    let old = std::fs::read(&path).unwrap();
    assert!(write_report(&path, &Invalid).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), old);
    let directory = dir.path().join("existing-directory");
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("sentinel"), b"old").unwrap();
    assert!(write_report(&directory, &report()).is_err());
    assert_eq!(std::fs::read(directory.join("sentinel")).unwrap(), b"old");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    write_report(&path, &json!({"new":true})).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap(),
        json!({"new":true})
    );
}
