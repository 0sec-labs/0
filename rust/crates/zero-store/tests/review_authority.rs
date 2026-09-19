#![allow(clippy::unwrap_used)]
//! Store-only authority fixtures: permit witnesses, never real provider/source/sandbox effects.
use serde_json::{Value, json};
use zero_protocol::{agent::AgentRequest, review::*, session::OperationStatus};
use zero_store::{Operation, ReviewAdmission, Store};

fn hash(v: &Value) -> String {
    zero_web_verification::hash(v).unwrap()
}
fn prepared() -> ReviewAdmission {
    let profile:ReviewProfile=serde_json::from_value(json!({"schema_version":1,"provider":"p","model":"m","instructions":"Host review","question":"Inspect input handling","execution":{"backend":{"type":"docker","image":format!("sha256:{}","a".repeat(64))},"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":4096},"budget_limit":10,"currency":"units","reservation_per_turn":6,"max_turns":3,"max_hypotheses":2,"deadline_ms":60000})).unwrap();
    let files = json!([{"path":"app.rs","digest":format!("sha256:{}","b".repeat(64)),"bytes":10}]);
    let snapshot: zero_protocol::SnapshotPin = serde_json::from_value(
        json!({"id":"source","root":"/source","files":files,"digest":hash(&files)}),
    )
    .unwrap();
    let root = uuid::Uuid::new_v4().to_string();
    let request = profile.request(snapshot.clone(), &root).unwrap();
    let tools: Vec<_> = [
        "list_source_files",
        "read_source_lines",
        "search_source_text",
        "execute_snapshot",
        "submit_source_hypotheses",
    ]
    .into_iter()
    .map(|name| {
        let (properties, required) = match name {
            "read_source_lines" => (json!({"path":{"type":"string"},"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1}}), json!(["path","start_line","end_line"])),
            "execute_snapshot" => (json!({"argv":{"type":"array","items":{"type":"string"},"minItems":1}}), json!(["argv"])),
            _ => (json!({}), json!([])),
        };
        json!({"name":name,"description":"Host tool","parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})
    })
    .collect();
    let template = json!({"model":"m","instructions":request.instructions,"input":[],"max_output_tokens":8192,"tools":tools});
    let pins = json!({"p":{"endpoint":"http://127.0.0.1:9090/responses","wire_api":"responses","rates":{"input":1,"cached_input":1,"output":1}}});
    ReviewAdmission {
        review_id: uuid::Uuid::new_v4().to_string(),
        session_id: uuid::Uuid::new_v4().to_string(),
        controller_operation_id: uuid::Uuid::new_v4().to_string(),
        root_operation_id: root,
        input_path: "./source".into(),
        canonical_path: "/source".into(),
        profile_name: "local".into(),
        profile,
        snapshot,
        root_payload: json!({"kind":"offline_snapshot_agent","request":request,"endpoint":pins["p"]["endpoint"],"rates":pins["p"]["rates"],"review_template":template}),
        provider_context: serde_json::from_value(pins).unwrap(),
    }
}
fn setup() -> (tempfile::TempDir, Store, ReviewAdmission) {
    let d = tempfile::tempdir().unwrap();
    let mut s = Store::open(d.path().join("db")).unwrap();
    s.claim_engine_epoch("owner").unwrap();
    (d, s, prepared())
}

fn inference(a: &ReviewAdmission) -> Value {
    json!({"kind":"agent_inference","parent_operation":a.root_operation_id,
        "request":a.root_payload["review_template"],"endpoint":a.root_payload["endpoint"],
        "rates":a.root_payload["rates"],"wire_api":"responses"})
}
fn admit(s: &mut Store, a: &ReviewAdmission, command: &str, payload: Value) -> Operation {
    s.admit_owned_batch(&a.session_id, "owner", &[(command.into(), payload)])
        .unwrap()
        .remove(0)
}
fn complete_calls(s: &mut Store, a: &ReviewAdmission, calls: Value) -> Operation {
    let op = admit(
        s,
        a,
        &format!("{}:model:0", a.root_operation_id),
        inference(a),
    );
    s.reserve_budget(&a.session_id, &op.id, a.profile.reservation_per_turn)
        .unwrap();
    s.settle_budget(&a.session_id, &op.id, 1).unwrap();
    s.settle_operation(
        &op.id,
        "owner",
        OperationStatus::Succeeded,
        &json!({
            "status":"completed","response_id":"fixture-response","content":calls,
            "usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0},
            "usage_is_final":true,"replay":[],"error":null
        }),
    )
    .unwrap()
}
fn source_call() -> Value {
    json!({"type":"tool_call","id":"source-call","name":"read_source_lines",
        "arguments":{"path":"app.rs","start_line":1,"end_line":1}})
}
fn sandbox_call() -> Value {
    json!({"type":"tool_call","id":"sandbox-call","name":"execute_snapshot",
        "arguments":{"argv":["cat","app.rs"]}})
}
fn source(a: &ReviewAdmission) -> Value {
    let call = source_call();
    json!({"kind":"agent_source_tool","parent_operation":a.root_operation_id,
        "call_id":call["id"],"name":call["name"],"arguments":call["arguments"],
        "source_operation":null,"bundle_sha256":null,
        "source_identity":{"kind":"snapshot_catalog","sha256":a.snapshot.digest}})
}
fn sandbox(a: &ReviewAdmission, index: usize) -> Value {
    let request: AgentRequest = serde_json::from_value(a.root_payload["request"].clone()).unwrap();
    let mut execution = request.snapshot_request().unwrap();
    execution.execution_id = format!("agent-{}-0-{index}", a.root_operation_id);
    execution.argv = vec!["cat".into(), "app.rs".into()];
    json!({"kind":"agent_tool","parent_operation":a.root_operation_id,
        "call_id":"sandbox-call","request":execution})
}
fn rows(d: &tempfile::TempDir, table: &str) -> u64 {
    let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
    c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn starts(d: &tempfile::TempDir) -> u64 {
    let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
    c.query_row("SELECT count(*) FROM events WHERE kind='operation_detail' AND json_extract(payload,'$.kind')='review_effect_started'", [], |r| r.get(0)).unwrap()
}

#[test]
fn genuine_model_source_and_sandbox_have_owned_one_use_physical_permits() {
    let (d, mut s, a) = setup();
    s.admit_review("review", "owner", &a).unwrap();
    complete_calls(&mut s, &a, json!([source_call(), sandbox_call()]));
    let source = admit(
        &mut s,
        &a,
        &format!("{}:tool:0:0", a.root_operation_id),
        source(&a),
    );
    let sandbox = admit(
        &mut s,
        &a,
        &format!("{}:tool:0:1", a.root_operation_id),
        sandbox(&a, 1),
    );
    assert_eq!(
        starts(&d),
        0,
        "admission is not physical dispatch permission"
    );
    for (effect, request) in [
        (&source, source.payload.clone()),
        (&sandbox, sandbox.payload["request"].clone()),
    ] {
        assert!(
            s.begin_review_effect(&effect.id, "intruder", &request)
                .is_err()
        );
        s.begin_review_effect(&effect.id, "owner", &request)
            .unwrap();
        let count = starts(&d);
        assert!(
            s.begin_review_effect(&effect.id, "owner", &request)
                .is_err()
        );
        assert_eq!(
            starts(&d),
            count,
            "duplicate may not grant a second physical attempt"
        );
    }
    assert_eq!(starts(&d), 2);
    assert_eq!(s.budget(&a.session_id).unwrap().charged, 1);
    assert_eq!(s.budget(&a.session_id).unwrap().reserved, 0);
}

#[test]
fn altered_inference_authority_is_rejected_atomically() {
    for mutation in 0..8 {
        let (d, mut s, a) = setup();
        s.admit_review("review", "owner", &a).unwrap();
        let mut payload = inference(&a);
        match mutation {
            0 => payload["request"]["tools"][0]["name"] = json!("http_request"),
            1 => payload["request"]["tools"][1]["parameters"]["additionalProperties"] = json!(true),
            2 => payload["request"]["model"] = json!("other-model"),
            3 => payload["request"]["instructions"] = json!("new authority"),
            4 => payload["request"]["max_output_tokens"] = json!(999999),
            5 => payload["rates"]["input"] = json!(0),
            6 => payload["endpoint"] = json!("http://127.0.0.1:9091/responses"),
            _ => payload["parent_operation"] = json!(a.controller_operation_id),
        }
        let before = rows(&d, "events");
        assert!(
            s.admit_owned_batch(
                &a.session_id,
                "owner",
                &[(format!("{}:model:0", a.root_operation_id), payload)]
            )
            .is_err(),
            "mutation {mutation}"
        );
        assert_eq!(rows(&d, "operations"), 2);
        assert_eq!(rows(&d, "events"), before);
        assert_eq!(rows(&d, "reservations"), 0);
    }
}

#[test]
fn wrong_owner_and_wrong_reservation_cannot_acquire_provider_authority() {
    let (d, mut s, a) = setup();
    s.admit_review("review", "owner", &a).unwrap();
    assert!(
        s.admit_owned_batch(
            &a.session_id,
            "intruder",
            &[(format!("{}:model:0", a.root_operation_id), inference(&a))]
        )
        .is_err()
    );
    assert_eq!(rows(&d, "operations"), 2);
    let op = admit(
        &mut s,
        &a,
        &format!("{}:model:0", a.root_operation_id),
        inference(&a),
    );
    assert!(s.reserve_budget(&a.session_id, &op.id, 1).is_err());
    assert!(
        s.reserve_budget(&a.session_id, &a.root_operation_id, 6)
            .is_err()
    );
    assert_eq!(rows(&d, "reservations"), 0);
    s.reserve_budget(&a.session_id, &op.id, 6).unwrap();
    assert_eq!(s.budget(&a.session_id).unwrap().reserved, 6);
}

#[test]
fn source_and_backend_effects_cannot_change_the_original_model_call_or_pin() {
    for mutation in 0..10 {
        let (d, mut s, a) = setup();
        s.admit_review("review", "owner", &a).unwrap();
        complete_calls(&mut s, &a, json!([source_call(), sandbox_call()]));
        let (index, mut payload) = if mutation < 5 {
            (0, source(&a))
        } else {
            (1, sandbox(&a, 1))
        };
        match mutation {
            0 => payload["source_identity"]["sha256"] = json!(format!("sha256:{}", "c".repeat(64))),
            1 => payload["arguments"]["path"] = json!("other.rs"),
            2 => payload["source_operation"] = json!(a.controller_operation_id),
            3 => payload["bundle_sha256"] = json!(a.snapshot.digest),
            4 => payload["call_id"] = json!("invented"),
            5 => {
                payload["request"]["backend"]["image"] = json!(format!("sha256:{}", "c".repeat(64)))
            }
            6 => payload["request"]["snapshot"]["root"] = json!("/other"),
            7 => payload["request"]["argv"] = json!(["sh", "-c", "unoffered command"]),
            8 => payload["request"]["timeout_ms"] = json!(2000),
            _ => payload["request"]["execution_id"] = json!("another-execution"),
        }
        let before = rows(&d, "events");
        assert!(
            s.admit_owned_batch(
                &a.session_id,
                "owner",
                &[(format!("{}:tool:0:{index}", a.root_operation_id), payload)]
            )
            .is_err(),
            "mutation {mutation}"
        );
        assert_eq!(rows(&d, "operations"), 3);
        assert_eq!(rows(&d, "events"), before);
        assert_eq!(starts(&d), 0);
    }
}

#[test]
fn physical_fence_rejects_changed_request_without_consuming_the_valid_attempt() {
    let (d, mut s, a) = setup();
    s.admit_review("review", "owner", &a).unwrap();
    complete_calls(&mut s, &a, json!([sandbox_call()]));
    let op = admit(
        &mut s,
        &a,
        &format!("{}:tool:0:0", a.root_operation_id),
        sandbox(&a, 0),
    );
    let mut altered = op.payload["request"].clone();
    altered["argv"] = json!(["false"]);
    assert!(s.begin_review_effect(&op.id, "owner", &altered).is_err());
    assert_eq!(starts(&d), 0);
    s.begin_review_effect(&op.id, "owner", &op.payload["request"])
        .unwrap();
    assert_eq!(starts(&d), 1);
}

#[test]
fn missing_unfinished_or_duplicated_model_origins_cannot_authorize_a_source_read() {
    for variant in 0..3 {
        let (d, mut s, a) = setup();
        s.admit_review("review", "owner", &a).unwrap();
        if variant == 1 {
            admit(
                &mut s,
                &a,
                &format!("{}:model:0", a.root_operation_id),
                inference(&a),
            );
        } else if variant == 2 {
            complete_calls(&mut s, &a, json!([source_call(), source_call()]));
        }
        let before = rows(&d, "operations");
        assert!(
            s.admit_owned_batch(
                &a.session_id,
                "owner",
                &[(format!("{}:tool:0:0", a.root_operation_id), source(&a))]
            )
            .is_err()
        );
        assert_eq!(rows(&d, "operations"), before);
        assert_eq!(starts(&d), 0);
    }
}

#[test]
fn cancellation_after_admission_prevents_physical_start_and_new_children() {
    let (d, mut s, a) = setup();
    s.admit_review("review", "owner", &a).unwrap();
    complete_calls(&mut s, &a, json!([source_call(), sandbox_call()]));
    let op = admit(
        &mut s,
        &a,
        &format!("{}:tool:0:0", a.root_operation_id),
        source(&a),
    );
    s.request_review_stop(&a.review_id, "owner", ReviewCloseReason::Cancelled)
        .unwrap();
    assert!(s.begin_review_effect(&op.id, "owner", &op.payload).is_err());
    assert!(
        s.admit_owned_batch(
            &a.session_id,
            "owner",
            &[(format!("{}:tool:0:1", a.root_operation_id), sandbox(&a, 1))]
        )
        .is_err()
    );
    assert_eq!(starts(&d), 0);
}

#[test]
fn expired_review_and_owner_loss_cannot_start_an_admitted_effect() {
    for owner_loss in [false, true] {
        let (d, mut s, mut a) = setup();
        a.profile.deadline_ms = 1000;
        let record = s.admit_review("review", "owner", &a).unwrap().review;
        complete_calls(&mut s, &a, json!([source_call()]));
        let op = admit(
            &mut s,
            &a,
            &format!("{}:tool:0:0", a.root_operation_id),
            source(&a),
        );
        if owner_loss {
            s.claim_engine_epoch("next").unwrap();
        } else {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            std::thread::sleep(std::time::Duration::from_millis(
                record.deadline_at_ms.saturating_sub(now) + 5,
            ));
            s.request_review_stop(&a.review_id, "owner", ReviewCloseReason::Deadline)
                .unwrap();
        }
        assert!(s.begin_review_effect(&op.id, "owner", &op.payload).is_err());
        assert_eq!(starts(&d), 0);
        if owner_loss {
            assert!(s.begin_review_effect(&op.id, "next", &op.payload).is_err());
        }
    }
}

#[test]
fn lost_original_model_witness_prevents_dispatch_of_an_existing_child() {
    let (d, mut s, a) = setup();
    s.admit_review("review", "owner", &a).unwrap();
    let model = complete_calls(&mut s, &a, json!([source_call()]));
    let op = admit(
        &mut s,
        &a,
        &format!("{}:tool:0:0", a.root_operation_id),
        source(&a),
    );
    let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
    c.execute(
        "DELETE FROM events WHERE kind='operation_settled' AND json_extract(payload,'$.id')=?1",
        [&model.id],
    )
    .unwrap();
    assert!(s.begin_review_effect(&op.id, "owner", &op.payload).is_err());
    assert_eq!(starts(&d), 0);
}

#[test]
fn joined_actor_keeps_frozen_role_and_parent_source_authority() {
    for captured_widened in [false, true] {
        let (d, mut s, mut a) = setup();
        let policy = json!({"max_parallel":1,"max_children":1,"roles":[{
            "name":"reader","provider":"p","model":"child-model","instructions":"Read source only",
            "description":"Bounded helper","tools":["read_source_lines"],"max_turns":1,"reservation_per_turn":2
        }]});
        a.profile.delegation_policy = Some(serde_json::from_value(policy.clone()).unwrap());
        let root_request = a
            .profile
            .request(a.snapshot.clone(), &a.root_operation_id)
            .unwrap();
        a.root_payload["request"] = serde_json::to_value(&root_request).unwrap();
        a.root_payload["review_template"]["tools"].as_array_mut().unwrap().push(json!({
        "name":"delegate_tasks","description":"Join bounded tasks","parameters":{
            "type":"object","properties":{"tasks":{"type":"array"}},"required":["tasks"],"additionalProperties":false
        }
    }));
        let role = &root_request.delegation_policy.as_ref().unwrap().roles[0];
        let mut child_request = root_request.clone();
        child_request.model = role.model.clone();
        child_request.instructions = format!(
            "{}\n\nHost-defined delegated role {}:\n{}",
            root_request.instructions, role.name, role.instructions
        );
        child_request.prompt = "Read app.rs".into();
        child_request.max_turns = role.max_turns;
        child_request.reservation_per_turn = role.reservation_per_turn;
        child_request.delegation_policy = None;
        child_request.source_submission_max_hypotheses = None;
        let mut template = json!({"model":role.model,"instructions":child_request.instructions,"input":[],"max_output_tokens":8192,
        "tools":[a.root_payload["review_template"]["tools"][1]]});
        if captured_widened {
            template["tools"]
                .as_array_mut()
                .unwrap()
                .push(a.root_payload["review_template"]["tools"][3].clone());
        }
        a.root_payload["delegation_context"] = json!({"version":1,"policy":policy,"roles":[{
            "name":"reader","endpoint":a.root_payload["endpoint"],"rates":a.root_payload["rates"],"wire_api":"responses","template":template
        }]});
        s.admit_review("review", "owner", &a).unwrap();
        let tasks = json!([{"role":"reader","prompt":"Read app.rs"}]);
        complete_calls(
            &mut s,
            &a,
            json!([{"type":"tool_call","id":"delegate","name":"delegate_tasks","arguments":{"tasks":tasks}}]),
        );
        let group_command = format!("{}:tool:0:0", a.root_operation_id);
        let child_command = format!("{group_command}:agent:0");
        let group = json!({"kind":"agent_delegation","parent_operation":a.root_operation_id,
        "call_id":"delegate","tasks":tasks,"child_commands":[child_command],
        "delegation_context_sha256":hash(&a.root_payload["delegation_context"])});
        admit(&mut s, &a, &group_command, group);
        let child_payload = json!({"kind":"offline_snapshot_agent","parent_operation":a.root_operation_id,
        "request":child_request,"endpoint":a.root_payload["endpoint"],"rates":a.root_payload["rates"],"wire_api":"responses",
        "delegation_role":"reader","delegation_index":0,"delegation_group_command":group_command,"delegation_template":template});
        if captured_widened {
            assert!(
                s.admit_owned_batch(&a.session_id, "owner", &[(child_command, child_payload)])
                    .is_err()
            );
            assert_eq!(rows(&d, "operations"), 4);
            assert_eq!(starts(&d), 0);
            continue;
        }
        for mutation in 0..4 {
            let mut payload = child_payload.clone();
            match mutation {
                0 => payload["request"]["instructions"] = json!("Discard parent authority"),
                1 => payload["request"]["prompt"] = json!("Unissued task"),
                2 => payload["delegation_template"]["tools"]
                    .as_array_mut()
                    .unwrap()
                    .push(a.root_payload["review_template"]["tools"][3].clone()),
                _ => payload["rates"]["input"] = json!(0),
            }
            assert!(
                s.admit_owned_batch(&a.session_id, "owner", &[(child_command.clone(), payload)])
                    .is_err(),
                "mutation {mutation}"
            );
            assert_eq!(rows(&d, "operations"), 4);
        }
        let child = admit(&mut s, &a, &child_command, child_payload);
        let model = admit(
            &mut s,
            &a,
            &format!("{}:model:0", child.id),
            json!({
                "kind":"agent_inference","parent_operation":child.id,"request":template,
                "endpoint":a.root_payload["endpoint"],"rates":a.root_payload["rates"],"wire_api":"responses"
            }),
        );
        s.reserve_budget(&a.session_id, &model.id, 2).unwrap();
        s.settle_budget(&a.session_id, &model.id, 1).unwrap();
        s.settle_operation(&model.id,"owner",OperationStatus::Succeeded,&json!({
        "status":"completed","response_id":"child-response","content":[source_call()],
        "usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0},"usage_is_final":true,"replay":[],"error":null
    })).unwrap();
        let mut payload = source(&a);
        payload["parent_operation"] = json!(child.id);
        let effect = admit(&mut s, &a, &format!("{}:tool:0:0", child.id), payload);
        s.begin_review_effect(&effect.id, "owner", &effect.payload)
            .unwrap();
        assert_eq!(starts(&d), 1);
        assert_eq!(s.budget(&a.session_id).unwrap().charged, 2);
    }
}

#[test]
fn source_preparation_is_owned_single_use_and_closed_before_copy_permission() {
    for closed in [false, true] {
        let (d, mut s, a) = setup();
        s.admit_review("review", "owner", &a).unwrap();
        let before = rows(&d, "events");
        assert!(
            s.begin_review_source_preparation(&a.root_operation_id, "intruder")
                .is_err()
        );
        assert!(
            s.begin_review_source_preparation(&a.controller_operation_id, "owner")
                .is_err()
        );
        assert_eq!(rows(&d, "events"), before);
        if closed {
            s.request_review_stop(&a.review_id, "owner", ReviewCloseReason::Cancelled)
                .unwrap();
            let events = rows(&d, "events");
            assert!(
                s.begin_review_source_preparation(&a.root_operation_id, "owner")
                    .is_err()
            );
            assert_eq!(rows(&d, "events"), events);
        } else {
            s.begin_review_source_preparation(&a.root_operation_id, "owner")
                .unwrap();
            assert_eq!(rows(&d, "events"), before + 1);
            assert!(
                s.begin_review_source_preparation(&a.root_operation_id, "owner")
                    .is_err()
            );
            assert_eq!(rows(&d, "events"), before + 1);
        }
    }
}

#[test]
fn budget_denial_persists_exact_cause_without_creating_a_reservation() {
    let (d, mut s, a) = setup();
    s.admit_review("review", "owner", &a).unwrap();
    let first = admit(
        &mut s,
        &a,
        &format!("{}:model:0", a.root_operation_id),
        inference(&a),
    );
    s.reserve_budget(&a.session_id, &first.id, 6).unwrap();
    // Actual final usage may exceed the original estimate; it must remain charged.
    s.settle_budget(&a.session_id, &first.id, 8).unwrap();
    s.settle_operation(
        &first.id,
        "owner",
        OperationStatus::Succeeded,
        &json!({
            "status":"completed","response_id":"expensive-response","content":[source_call()],
            "usage":{"input_tokens":4,"output_tokens":4,"cached_input_tokens":0},
            "usage_is_final":true,"replay":[],"error":null
        }),
    )
    .unwrap();
    let second = admit(
        &mut s,
        &a,
        &format!("{}:model:1", a.root_operation_id),
        inference(&a),
    );
    assert!(matches!(
        s.reserve_budget(&a.session_id, &second.id, 6),
        Err(zero_store::Error::BudgetExceeded)
    ));
    let budget = s.budget(&a.session_id).unwrap();
    assert_eq!((budget.limit, budget.charged, budget.reserved), (10, 8, 0));
    assert_eq!(rows(&d, "reservations"), 1);
    let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
    let events: Vec<String> = c
        .prepare("SELECT payload FROM events WHERE session_id=?1 AND kind='review_budget_denied'")
        .unwrap()
        .query_map([&a.session_id], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(&events[0]).unwrap(),
        json!({
            "review_id":a.review_id,"operation_id":second.id,"actor_operation_id":a.root_operation_id,
            "requested":6,"charged":8,"reserved":0,"limit":10,"owner":"owner"
        })
    );
    drop(c);
    drop(s);
    let reopened = Store::open(d.path().join("db")).unwrap();
    let budget = reopened.budget(&a.session_id).unwrap();
    assert_eq!((budget.charged, budget.reserved), (8, 0));
    assert_eq!(rows(&d, "reservations"), 1);
}
