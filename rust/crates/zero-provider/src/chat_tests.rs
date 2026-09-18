use super::*;
fn request(input: Vec<Value>) -> ResponsesRequest {
    ResponsesRequest {
        model: "fixture".into(),
        instructions: "system".into(),
        input,
        tools: vec![],
        max_output_tokens: 128,
    }
}
fn chunk(delta: Value, finish: Value) -> Value {
    json!({"id":"r1","model":"resolved-model","choices":[{"index":0,"delta":delta,"finish_reason":finish}],"usage":null})
}
fn event(a: &mut Accumulator, value: Value) {
    a.event(&serde_json::to_vec(&value).unwrap()).unwrap();
}
fn usage() -> Value {
    json!({"id":"r1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":4}}})
}
fn tool_start() -> Value {
    chunk(
        json!({"role":"assistant","reasoning_content":"think ","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"inspect","arguments":"{\"path\":"}}]}),
        Value::Null,
    )
}
fn tool_end() -> Value {
    chunk(
        json!({"reasoning_content":"carefully","tool_calls":[{"index":0,"function":{"arguments":"\"README\"}"}}]}),
        json!("tool_calls"),
    )
}
#[test]
fn tool_fragments_reasoning_and_ids_round_trip_with_final_cached_usage() {
    let mut a = Accumulator::new("fixture");
    event(&mut a, tool_start());
    event(&mut a, tool_end());
    event(&mut a, usage());
    a.event(b"[DONE]").unwrap();
    let result = a.finish(None);
    assert_eq!(result.status, CompletionStatus::Completed);
    assert!(result.usage_is_final);
    assert_eq!(
        result.usage.unwrap(),
        Usage {
            input_tokens: 10,
            output_tokens: 3,
            cached_input_tokens: 4
        }
    );
    assert_eq!(
        result.content,
        vec![Content::ToolCall {
            id: "call-1".into(),
            name: "inspect".into(),
            arguments: json!({"path":"README"})
        }]
    );
    let raw = result.replay[0]["message"].clone();
    assert_eq!(raw["reasoning_content"], "think carefully");
    let mut input = result.replay;
    input.push(json!({"type":"function_call_output","call_id":"call-1","output":"evidence"}));
    let body = encode(&request(input)).unwrap();
    assert_eq!(body["messages"][1], raw);
    assert_eq!(
        body["messages"][2],
        json!({"role":"tool","tool_call_id":"call-1","content":"evidence"})
    );
    assert_eq!(body["stream_options"]["include_usage"], true);
    assert_eq!(body["max_completion_tokens"], 128);
}
#[test]
fn normalized_text_parallel_calls_and_outputs_translate_without_ids_lost() {
    let input = vec![
        json!({"role":"user","content":[{"type":"input_text","text":"inspect"}]}),
        json!({"role":"assistant","content":"working"}),
        json!({"type":"function_call","call_id":"a","name":"first","arguments":"{}"}),
        json!({"type":"function_call","call_id":"b","name":"second","arguments":"{}"}),
        json!({"type":"function_call_output","call_id":"b","output":"B"}),
        json!({"type":"function_call_output","call_id":"a","output":"A"}),
    ];
    let body = encode(&request(input)).unwrap();
    assert_eq!(
        body["messages"][1]["content"],
        json!([{"type":"text","text":"inspect"}])
    );
    assert_eq!(
        body["messages"][3]["tool_calls"].as_array().unwrap().len(),
        2
    );
    assert_eq!(body["messages"][3]["tool_calls"][0]["id"], "a");
    assert_eq!(body["messages"][3]["tool_calls"][1]["id"], "b");
}
#[test]
fn unsupported_input_and_unpaired_or_duplicate_tools_are_rejected() {
    for input in [
        vec![json!({"type":"reasoning","encrypted_content":"opaque"})],
        vec![
            json!({"role":"user","content":[{"type":"input_image","image_url":"https://example.test/x"}]}),
        ],
        vec![json!({"role":"user","content":"text","unmapped":true})],
        vec![
            json!({"type":"chat_completion_message","model":"different","message":{"role":"assistant","content":"text"}}),
        ],
        vec![json!({"type":"function_call_output","call_id":"missing","output":"x"})],
        vec![json!({"type":"function_call","call_id":"a","name":"tool","arguments":"{}"})],
        vec![json!({"type":"function_call","call_id":"a","name":"tool","arguments":"[]"})],
        vec![
            json!({"type":"function_call","call_id":"a","name":"tool","arguments":"{}"}),
            json!({"type":"function_call_output","call_id":"a","output":"x"}),
            json!({"type":"function_call_output","call_id":"a","output":"again"}),
        ],
    ] {
        assert!(encode(&request(input)).is_err());
    }
}
#[test]
fn done_and_consistent_finish_required_before_any_tool_promotion() {
    for finish in ["length", "content_filter", "stop", "other"] {
        let mut a = Accumulator::new("fixture");
        event(&mut a, tool_start());
        let mut end = tool_end();
        end["choices"][0]["finish_reason"] = json!(finish);
        event(&mut a, end);
        event(&mut a, usage());
        a.event(b"[DONE]").unwrap();
        let result = a.finish(None);
        assert_ne!(result.status, CompletionStatus::Completed);
        assert!(result.content.is_empty());
        assert!(encode(&request(result.replay)).is_err());
    }
    for interrupted in [None, Some("cancelled")] {
        let mut a = Accumulator::new("fixture");
        event(&mut a, tool_start());
        event(&mut a, tool_end());
        event(&mut a, usage());
        let result = a.finish(interrupted);
        assert_eq!(result.status, CompletionStatus::Incomplete);
        assert!(result.content.is_empty());
        assert!(!result.usage_is_final);
    }
    let mut a = Accumulator::new("fixture");
    event(
        &mut a,
        chunk(json!({"content":"text"}), json!("tool_calls")),
    );
    a.event(b"[DONE]").unwrap();
    assert_eq!(a.finish(None).status, CompletionStatus::Failed);
}
#[test]
fn malformed_arguments_duplicate_ids_and_multiple_choices_never_promote() {
    for args in ["{", "[]", "null"] {
        let mut a = Accumulator::new("fixture");
        event(
            &mut a,
            chunk(
                json!({"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"tool","arguments":args}}]}),
                json!("tool_calls"),
            ),
        );
        a.event(b"[DONE]").unwrap();
        let result = a.finish(None);
        assert_eq!(result.status, CompletionStatus::Failed);
        assert!(result.content.is_empty());
    }
    let mut a = Accumulator::new("fixture");
    event(
        &mut a,
        chunk(
            json!({"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"tool","arguments":"{}"}},{"index":1,"id":"a","type":"function","function":{"name":"tool","arguments":"{}"}}]}),
            json!("tool_calls"),
        ),
    );
    a.event(b"[DONE]").unwrap();
    assert_eq!(a.finish(None).status, CompletionStatus::Failed);
    let mut a = Accumulator::new("fixture");
    let mut value = chunk(json!({}), Value::Null);
    value["choices"]
        .as_array_mut()
        .unwrap()
        .push(json!({"index":1,"delta":{"content":"other"}}));
    assert!(a.event(&serde_json::to_vec(&value).unwrap()).is_err());
    assert!(a.finish(None).content.is_empty());
}
#[test]
fn provisional_or_absent_usage_is_not_final_and_invalid_cached_subset_rejected() {
    let mut a = Accumulator::new("fixture");
    let mut first = chunk(json!({"content":"text"}), Value::Null);
    first["usage"] = usage()["usage"].clone();
    event(&mut a, first);
    event(&mut a, chunk(json!({}), json!("stop")));
    a.event(b"[DONE]").unwrap();
    let result = a.finish(None);
    assert_eq!(result.status, CompletionStatus::Completed);
    assert!(!result.usage_is_final);
    assert!(result.usage.is_some());
    let mut a = Accumulator::new("fixture");
    event(&mut a, chunk(json!({"content":"text"}), json!("stop")));
    a.event(b"[DONE]").unwrap();
    let result = a.finish(None);
    assert!(!result.usage_is_final);
    assert!(result.usage.is_none());
    let mut a = Accumulator::new("fixture");
    let mut bad = usage();
    bad["usage"]["prompt_tokens_details"]["cached_tokens"] = json!(11);
    assert!(a.event(&serde_json::to_vec(&bad).unwrap()).is_err());
}
#[test]
fn opaque_details_preserved_once_unknown_or_ambiguous_deltas_rejected() {
    let details =
        json!([{"type":"reasoning.encrypted","id":"reason-1","data":"opaque","signature":"sig"}]);
    let mut a = Accumulator::new("fixture");
    event(
        &mut a,
        chunk(
            json!({"reasoning_details":details,"content":"text"}),
            json!("stop"),
        ),
    );
    a.event(b"[DONE]").unwrap();
    let result = a.finish(None);
    assert_eq!(result.replay[0]["message"]["reasoning_details"], details);
    assert_eq!(
        encode(&request(result.replay)).unwrap()["messages"][1]["reasoning_details"],
        details
    );
    for delta in [
        json!({"audio":{"data":"bytes"}}),
        json!({"reasoning_details":details}),
    ] {
        let mut a = Accumulator::new("fixture");
        event(
            &mut a,
            chunk(json!({"reasoning_details":details}), Value::Null),
        );
        let value = chunk(delta, Value::Null);
        assert!(a.event(&serde_json::to_vec(&value).unwrap()).is_err());
        let result = a.finish(None);
        assert_eq!(result.status, CompletionStatus::Failed);
        assert_eq!(result.replay[0]["chunks"][1], value);
        assert!(result.content.is_empty());
    }
}
#[test]
fn interleaved_tool_indices_order_correctly_and_identity_changes_poison() {
    let mut a = Accumulator::new("fixture");
    event(
        &mut a,
        chunk(
            json!({"tool_calls":[{"index":1,"id":"b","type":"function","function":{"name":"second","arguments":"{"}},{"index":0,"id":"a","type":"function","function":{"name":"first","arguments":"{}"}}]}),
            Value::Null,
        ),
    );
    event(
        &mut a,
        chunk(
            json!({"tool_calls":[{"index":1,"function":{"arguments":"}"}}]}),
            json!("tool_calls"),
        ),
    );
    a.event(b"[DONE]").unwrap();
    let result = a.finish(None);
    assert_eq!(result.status, CompletionStatus::Completed);
    assert!(matches!(&result.content[0],Content::ToolCall{id,..} if id=="a"));
    assert!(matches!(&result.content[1],Content::ToolCall{id,..} if id=="b"));
    let mut a = Accumulator::new("fixture");
    event(&mut a, tool_start());
    let mut wrong = tool_end();
    wrong["id"] = json!("changed");
    assert!(a.event(&serde_json::to_vec(&wrong).unwrap()).is_err());
    assert!(a.finish(None).content.is_empty());
}

#[test]
fn provider_error_payload_is_not_echoed_in_diagnostics() {
    let mut a = Accumulator::new("fixture");
    assert!(
        a.event(br#"{"error":{"message":"credential-secret-fixture"}}"#)
            .is_err()
    );
    let result = a.finish(None);
    assert_eq!(result.status, CompletionStatus::Failed);
    assert!(
        !serde_json::to_string(&result)
            .unwrap()
            .contains("credential-secret-fixture")
    );
}
