#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use zero_context::{
    ContextPolicy, ContextState, Error, MAX_STATE_BYTES, project, validate_receipt,
};
use zero_protocol::model::{Completion, CompletionStatus, Content};
fn policy(bytes: u32) -> ContextPolicy {
    ContextPolicy {
        schema_version: 1,
        max_input_bytes: bytes,
        keep_recent_rounds: 1,
    }
}
fn round(wire: &str, id: &str, text: &str) -> Completion {
    let replay = match wire {
        "responses" => vec![
            json!({"type":"reasoning","id":"opaque","encrypted_content":"preserve-opaque-bytes"}),
            json!({"type":"function_call","call_id":id,"name":"tool","arguments":"{}"}),
        ],
        "chat" => vec![
            json!({"type":"chat_completion_message","model":"fixture","message":{"role":"assistant","content":null,"reasoning_content":text,"reasoning_details":[{"opaque":"exact"}],"tool_calls":[{"id":id,"type":"function","function":{"name":"tool","arguments":"{}"}}]}}),
        ],
        "google" => vec![
            json!({"type":"google_content","model":"fixture","response_id":"r1","content":{"role":"model","parts":[{"text":text,"thought":true,"thoughtSignature":"opaque-signature"},{"functionCall":{"id":id,"name":"tool","args":{}}}]},"call_ids":[id]}),
        ],
        "anthropic" => vec![
            json!({"type":"anthropic_message","model":"fixture","usage":{"input_tokens":1},"message":{"role":"assistant","content":[{"type":"thinking","thinking":text,"signature":"signed-verbatim"},{"type":"redacted_thinking","data":"opaque-verbatim"},{"type":"tool_use","id":id,"name":"tool","input":{}}]}}),
        ],
        _ => unreachable!(),
    };
    Completion {
        status: CompletionStatus::Completed,
        response_id: Some(id.into()),
        content: vec![Content::ToolCall {
            id: id.into(),
            name: "tool".into(),
            arguments: json!({}),
        }],
        usage: None,
        usage_is_final: false,
        replay,
        error: None,
    }
}
fn output(id: &str, text: &str) -> Value {
    json!({"type":"function_call_output","call_id":id,"output":text})
}
#[test]
fn all_wire_formats_omit_whole_rounds_and_preserve_every_user_prompt() {
    for wire in ["responses", "chat", "anthropic", "google"] {
        let protected = json!({"role":"user","content":"original user constraints"});
        let mut state = ContextState::protected(vec![protected.clone()]).unwrap();
        let old = round(wire, "old", "old reasoning");
        state
            .append_round("old-op", &old, vec![output("old", &"x".repeat(2500))])
            .unwrap();
        state.append_user("new user constraints").unwrap();
        let latest = round(wire, "new", "new reasoning");
        let result = output("new", "known nonzero exit result retained");
        state
            .append_round("new-op", &latest, vec![result.clone()])
            .unwrap();
        let before = state.to_bytes().unwrap();
        let projected = project(&state, &policy(2048)).unwrap();
        let mut expected = vec![
            protected,
            json!({"role":"user","content":"new user constraints"}),
        ];
        expected.extend(latest.replay);
        expected.push(result);
        assert_eq!(projected.input, expected, "{wire}");
        assert_eq!(projected.receipt.omitted.len(), 1);
        assert_eq!(
            projected.receipt.omitted[0]
                .inference_operation_id
                .as_deref(),
            Some("old-op")
        );
        assert_eq!(state.to_bytes().unwrap(), before);
        validate_receipt(&state, &policy(2048), &projected.receipt).unwrap();
        let restored = ContextState::from_bytes(&before).unwrap();
        assert_eq!(
            project(&restored, &policy(2048)).unwrap().receipt,
            projected.receipt
        );
    }
}
#[test]
fn exact_serialized_byte_boundary_accounts_for_json_escaping_and_empty_spans() {
    let mut state = ContextState::protected(vec![]).unwrap();
    state.append_user(&"\"\\é\n".repeat(200)).unwrap();
    state
        .append_round("a", &round("responses", "a", ""), vec![output("a", "one")])
        .unwrap();
    state
        .append_round("b", &round("responses", "b", ""), vec![output("b", "two")])
        .unwrap();
    let bytes = serde_json::to_vec(&state.input()).unwrap().len();
    let exact = project(&state, &policy(bytes as u32)).unwrap();
    assert!(exact.receipt.omitted.is_empty());
    assert_eq!(exact.receipt.projected_bytes, bytes as u64);
    let smaller = project(&state, &policy(bytes as u32 - 1)).unwrap();
    assert_eq!(smaller.receipt.omitted.len(), 1);
    assert_eq!(
        smaller.receipt.projected_bytes,
        serde_json::to_vec(&smaller.input).unwrap().len() as u64
    );
}
#[test]
fn mandatory_text_and_recent_round_overflow_fail_without_changing_state() {
    let state =
        ContextState::protected(vec![json!({"role":"user","content":"x".repeat(1500)})]).unwrap();
    let before = state.to_bytes().unwrap();
    assert!(matches!(
        project(&state, &policy(1024)),
        Err(Error::MandatoryOverflow)
    ));
    assert_eq!(before, state.to_bytes().unwrap());
    let mut state = ContextState::protected(vec![]).unwrap();
    state
        .append_round(
            "a",
            &round("responses", "a", ""),
            vec![output("a", &"x".repeat(1500))],
        )
        .unwrap();
    assert!(matches!(
        project(&state, &policy(1024)),
        Err(Error::MandatoryOverflow)
    ));
    // Legacy assistant/tool context is protected, never inferred as droppable.
    let legacy = ContextState::protected(state.input()).unwrap();
    assert!(matches!(
        project(&legacy, &policy(1024)),
        Err(Error::MandatoryOverflow)
    ));
}
#[test]
fn correlation_rejects_missing_duplicate_reordered_or_forged_results_atomically() {
    let mut complete = round("responses", "a", "");
    complete
        .replay
        .push(json!({"type":"function_call","call_id":"b","name":"tool","arguments":"{}"}));
    complete.content.push(Content::ToolCall {
        id: "b".into(),
        name: "tool".into(),
        arguments: json!({}),
    });
    for outputs in [
        vec![output("a", "a")],
        vec![output("a", "a"), output("a", "a")],
        vec![output("b", "b"), output("a", "a")],
        vec![
            output("a", "a"),
            json!({"role":"user","content":"new instruction"}),
        ],
    ] {
        let mut state = ContextState::protected(vec![]).unwrap();
        let before = state.to_bytes().unwrap();
        assert!(state.append_round("op", &complete, outputs).is_err());
        assert_eq!(before, state.to_bytes().unwrap());
    }
    let mut state = ContextState::protected(vec![]).unwrap();
    state
        .append_round("op", &complete, vec![output("a", "a"), output("b", "b")])
        .unwrap();
    assert!(
        state
            .append_round("op", &complete, vec![output("a", "a"), output("b", "b")])
            .is_err()
    );
}
#[test]
fn loaded_round_cannot_hide_user_text_or_invalid_call_metadata() {
    let mut state = ContextState::protected(vec![]).unwrap();
    state
        .append_round("op", &round("responses", "a", ""), vec![output("a", "a")])
        .unwrap();
    let encoded = serde_json::to_value(state).unwrap();
    for forged in [
        json!({"type":"message","role":"user","content":"instruction"}),
        json!({"type":"chat_completion_message","message":{"role":"user","content":"instruction"}}),
        json!({"type":"anthropic_message","message":{"role":"user","content":[]}}),
        json!({"type":"function_call_output","call_id":"a","output":"orphan"}),
    ] {
        let mut changed = encoded.clone();
        changed["spans"][1]["replay"][0] = forged;
        assert!(ContextState::from_bytes(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
    let mut changed = encoded;
    changed["spans"][1]["call_ids"] = json!(["forged"]);
    assert!(ContextState::from_bytes(&serde_json::to_vec(&changed).unwrap()).is_err());
}
#[test]
fn receipt_identity_covers_policy_state_and_ordered_span_selection() {
    let mut state = ContextState::protected(vec![json!({"role":"user","content":"user"})]).unwrap();
    state
        .append_round(
            "one",
            &round("responses", "a", ""),
            vec![output("a", &"x".repeat(2000))],
        )
        .unwrap();
    state
        .append_round("two", &round("responses", "b", ""), vec![output("b", "b")])
        .unwrap();
    let p = policy(1024);
    let receipt = project(&state, &p).unwrap().receipt;
    for field in ["state_sha256", "input_sha256", "projected_sha256"] {
        let mut changed = serde_json::to_value(&receipt).unwrap();
        changed[field] = json!("sha256:forged");
        assert!(validate_receipt(&state, &p, &serde_json::from_value(changed).unwrap()).is_err());
    }
    let mut changed = receipt.clone();
    changed.omitted[0].inference_operation_id = Some("forged".into());
    assert!(validate_receipt(&state, &p, &changed).is_err());
    let mut changed = receipt.clone();
    changed.policy.max_input_bytes = 2048;
    assert!(validate_receipt(&state, &p, &changed).is_err());
    let mut changed = receipt.clone();
    changed.retained.reverse();
    assert!(validate_receipt(&state, &p, &changed).is_err());
}
#[test]
fn state_artifact_and_item_bounds_and_strict_deserialization() {
    assert!(ContextState::protected(vec![json!(null); 10001]).is_err());
    assert!(ContextState::from_bytes(&vec![b' '; MAX_STATE_BYTES + 1]).is_err());
    let mut state = ContextState::protected(vec![]).unwrap();
    assert!(state.append_user(&"x".repeat(MAX_STATE_BYTES)).is_err());
    assert!(state.input().is_empty());
    let mut wire = serde_json::to_value(&state).unwrap();
    wire["extra"] = json!(true);
    assert!(ContextState::from_bytes(&serde_json::to_vec(&wire).unwrap()).is_err());
}
#[test]
fn invalid_policy_or_incomplete_provider_round_is_not_projected() {
    let mut state = ContextState::protected(vec![]).unwrap();
    let mut incomplete = round("responses", "a", "");
    incomplete.status = CompletionStatus::Incomplete;
    assert!(
        state
            .append_round("op", &incomplete, vec![output("a", "a")])
            .is_err()
    );
    for p in [
        ContextPolicy {
            schema_version: 2,
            ..policy(1024)
        },
        policy(1023),
        policy(4 * 1024 * 1024 + 1),
        ContextPolicy {
            keep_recent_rounds: 0,
            ..policy(1024)
        },
        ContextPolicy {
            keep_recent_rounds: 33,
            ..policy(1024)
        },
    ] {
        assert!(project(&state, &p).is_err());
    }
}
#[test]
fn none_policy_preserves_legacy_agent_request_serialization() {
    let wire = json!({"provider":"p","model":"m","instructions":"i","prompt":"p","execution":{"execution_id":"e","image":"local","argv":["true"],"build_argv":null,"stdin":null,"snapshot":{"id":"s","root":"/tmp/source","digest":"sha256:abc","files":[]},"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024},"max_turns":2,"reservation_per_turn":10});
    let request: zero_protocol::agent::AgentRequest = serde_json::from_value(wire.clone()).unwrap();
    assert!(request.context_policy.is_none());
    assert_eq!(serde_json::to_value(request).unwrap(), wire);
}

#[test]
fn borrowed_round_witnesses_locate_exact_original_items_across_protected_and_user_spans() {
    let mut state = ContextState::protected(vec![
        json!({"role":"user","content":"legacy"}),
        json!({"role":"assistant","content":"legacy answer"}),
    ])
    .unwrap();
    let a = round("responses", "a", "");
    state
        .append_round("first-op", &a, vec![output("a", "first result")])
        .unwrap();
    state.append_user("followup").unwrap();
    let b = round("anthropic", "b", "signed thinking");
    state
        .append_round("second-op", &b, vec![output("b", "second result")])
        .unwrap();
    let input = state.input();
    let witnesses: Vec<_> = state.round_witnesses().collect();
    assert_eq!(witnesses.len(), 2);
    assert_eq!(witnesses[0].span_index, 1);
    assert_eq!(witnesses[0].input_start, 2);
    assert_eq!(witnesses[1].input_start, 2 + a.replay.len() + 2);
    assert_eq!(witnesses[1].inference_operation_id, "second-op");
    for witness in witnesses {
        let end = witness.input_start + witness.replay.len() + witness.tool_outputs.len();
        let combined: Vec<_> = witness
            .replay
            .iter()
            .chain(witness.tool_outputs)
            .cloned()
            .collect();
        assert_eq!(&input[witness.input_start..end], combined);
        assert_eq!(witness.call_ids.len(), witness.tool_outputs.len());
    }
}
