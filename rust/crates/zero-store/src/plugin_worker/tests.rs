use super::*;
struct Fixture {
    store: Store,
    session: String,
    actor: Operation,
    worker: Operation,
    context: Value,
}
fn sha() -> String {
    format!("sha256:{}", "a".repeat(64))
}
impl Fixture {
    fn new(approval: bool) -> Self {
        Self::with_timeout(approval, 60_000)
    }
    fn with_timeout(approval: bool, timeout: u64) -> Self {
        Self::with_source(approval, timeout, true)
    }
    fn with_source(approval: bool, timeout: u64, source: bool) -> Self {
        let mut store = Store::open(":memory:").unwrap();
        store.claim_engine_epoch("owner").unwrap();
        let session = store.create_session("g", 100).unwrap().id;
        let profile = json!({"schema_version":1,"base_url":"http://localhost/","in_scope":["localhost"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":["/"],"denied_path_prefixes":[],"allowed_methods":["GET","POST"],"allowed_headers":[],"redirect":{"mode":"follow","max_hops":1},"limits":{"timeout_ms":1000,"max_request_body_bytes":100,"max_response_wire_bytes":100,"max_response_decoded_bytes":100,"max_request_header_bytes":100,"max_request_headers":10,"max_response_header_bytes":100,"max_response_headers":10,"max_dns_answers":10,"max_dns_cname_depth":2,"max_dns_queries":10},"rate":{"default":{"requests_per_interval":10,"interval_ms":1000,"burst":10},"per_host":{},"jitter_ms":0},"budget":{"max_requests":3,"max_request_body_bytes":10,"max_response_decoded_bytes":300}});
        let profile =
            zero_http::normalize_policy(serde_json::from_value(profile).unwrap()).unwrap();
        let digest = zero_http::profile_sha256(&profile).unwrap();
        let account = hash(
            &json!({"session_id":session,"original_root_command":"actor","profile_sha256":digest}),
        )
        .unwrap();
        let context = json!({"schema_version":1,"profile_name":"test","profile":profile,"profile_sha256":digest,"account_id":account,"original_root_command":"actor"});
        let binding = json!({"alias":"inspect","plugin":"checker","tool":"check"});
        let plugin = json!({"generation":"g","epoch":1,"selected":[{"binding":binding,"manifest":"a".repeat(64),"capabilities":["filesystem-read","network"]}],"workers":{"checker":{"schema_version":1,"operations":["list_source_files","read_source_lines","http_request"],"max_calls":2,"max_callbacks":3}},"launch":{"backend":{"type":"docker","image":sha()},"interpreter":["node"],"timeout_ms":timeout,"memory_mb":128,"cpus":1,"max_output_bytes":4096}});
        let mut request = json!({"provider":"p","model":"m","instructions":"fixed","prompt":"inspect","max_turns":3,"reservation_per_turn":1,"execution":{"execution_id":"profile","image":sha(),"snapshot":{"id":"s","root":"/tmp/source","digest":sha(),"files":[{"path":"entry","digest":sha(),"bytes":0}]},"argv":["true"],"timeout_ms":1000,"memory_mb":128,"cpus":1,"max_output_bytes":1024},"plugin_tools":[binding],"http_profile":"test","source_snapshot_tools":source});
        if approval {
            request["tool_approval_policy"] = json!({"require_approval":["http_request"]});
        }
        let request: zero_protocol::agent::AgentRequest = serde_json::from_value(request).unwrap();
        request.validate_capabilities().unwrap();
        let payload = json!({"kind":"offline_snapshot_agent","request":request,"plugin_context":plugin,"http_context":context,"http_output_version":2});
        let actor = store
            .admit_owned_batch(&session, "owner", &[("actor".into(), payload)])
            .unwrap()
            .remove(0);
        store.ensure_http_account(&session, &context).unwrap();
        let worker = store
            .register_plugin_worker(
                &session,
                &actor.id,
                "owner",
                &uuid::Uuid::new_v4().to_string(),
                "checker",
                "/tmp/worker-attempt",
            )
            .unwrap();
        Self {
            store,
            session,
            actor,
            worker,
            context,
        }
    }
    fn call(&mut self, turn: u32) -> (Operation, PluginPin) {
        let input = json!({"query":format!("q{turn}")});
        let call_id = format!("call{turn}");
        let origin=self.store.admit_owned_batch(&self.session,"owner",&[(format!("{}:model:{turn}",self.actor.id),json!({"kind":"agent_inference","parent_operation":self.actor.id,"request":{"tools":[{"name":"inspect","description":"fixed","parameters":{"type":"object"}}]}}))]).unwrap().remove(0);
        self.store.settle_operation(&origin.id,"owner",OperationStatus::Succeeded,&json!({"status":"completed","response_id":"r","content":[{"type":"tool_call","id":call_id,"name":"inspect","arguments":input}],"usage":null,"replay":[],"error":null})).unwrap();
        let call=self.store.admit_owned_batch(&self.session,"owner",&[(format!("{}:tool:{turn}:0",self.actor.id),json!({"kind":"agent_plugin","parent_operation":self.actor.id,"call_id":call_id,"binding":{"alias":"inspect","plugin":"checker","tool":"check"},"plugin_context":self.actor.payload["plugin_context"],"input":input}))]).unwrap().remove(0);
        let pin = PluginPin {
            generation: "g".into(),
            epoch: 1,
            lease_id: uuid::Uuid::new_v4().to_string(),
            lease_owner: call.id.clone(),
            plugin_manifest: "a".repeat(64),
        };
        (call, pin)
    }
    fn start(&mut self) -> (Operation, PluginPin) {
        let (call, pin) = self.call(0);
        self.store
            .bind_plugin_worker_call(&self.worker.id, &call.id, "owner", &pin)
            .unwrap();
        self.store
            .prepare_plugin_worker(&self.worker.id, "owner", &sha(), "worker-execution")
            .unwrap();
        self.store
            .begin_plugin_worker(&self.worker.id, "owner")
            .unwrap();
        (call, pin)
    }
    fn reply(&mut self, call: &Operation) {
        let digest = self
            .store
            .retain_operation_artifact(
                &call.id,
                "owner",
                "plugin.worker_reply",
                br#"{"type":"result","value":{}}"#,
            )
            .unwrap();
        self.store
            .append_operation_event(
                &call.id,
                "owner",
                "plugin.worker_reply",
                &json!({"worker_operation_id":self.worker.id,"reply_artifact":digest}),
            )
            .unwrap();
    }
    fn callback(
        &mut self,
        pin: &PluginPin,
        index: u64,
        op: PluginHostOperation,
        input: Value,
    ) -> Operation {
        self.store
            .admit_plugin_callback(&self.worker.id, "owner", &pin.lease_id, index, op, &input)
            .unwrap()
    }
    fn hop(&self, index: u32, url: &str) -> Value {
        json!({"index":index,"host":"localhost","profile_sha256":self.context["profile_sha256"],"url":url,"method":"POST","addresses":["127.0.0.1:80"],"selected_address":"127.0.0.1:80","request_body_bytes":2,"response_decoded_limit":100})
    }
}
#[test]
fn source_callback_is_one_use_and_wire_reply_closes_only_that_call() {
    let mut f = Fixture::new(false);
    let (call, pin) = f.start();
    assert!(f.store.begin_plugin_worker(&f.worker.id, "owner").is_err());
    assert!(
        f.store
            .bind_plugin_worker_call(&f.worker.id, &call.id, "owner", &pin)
            .is_err()
    );
    assert!(
        f.store
            .admit_plugin_callback(
                &f.worker.id,
                "owner",
                "foreign",
                1,
                PluginHostOperation::ListSourceFiles,
                &json!({})
            )
            .is_err()
    );
    let cb = f.callback(&pin, 1, PluginHostOperation::ListSourceFiles, json!({}));
    f.store
        .begin_plugin_callback_effect(&cb.id, "owner")
        .unwrap();
    assert!(
        f.store
            .begin_plugin_callback_effect(&cb.id, "owner")
            .is_err()
    );
    f.store
        .settle_operation(
            &cb.id,
            "owner",
            OperationStatus::Succeeded,
            &json!({"files":[]}),
        )
        .unwrap();
    let (next, nextpin) = f.call(1);
    assert!(
        f.store
            .bind_plugin_worker_call(&f.worker.id, &next.id, "owner", &nextpin)
            .is_err()
    );
    f.reply(&call);
    assert!(
        f.store
            .admit_plugin_callback(
                &f.worker.id,
                "owner",
                &pin.lease_id,
                2,
                PluginHostOperation::ListSourceFiles,
                &json!({})
            )
            .is_err()
    );
    f.store
        .bind_plugin_worker_call(&f.worker.id, &next.id, "owner", &nextpin)
        .unwrap();
    assert!(
        f.store
            .admit_plugin_callback(
                &f.worker.id,
                "owner",
                &pin.lease_id,
                2,
                PluginHostOperation::ListSourceFiles,
                &json!({})
            )
            .is_err()
    );
    let cb = f.callback(
        &nextpin,
        2,
        PluginHostOperation::ReadSourceLines,
        json!({"path":"entry","start":1,"end":1}),
    );
    f.store
        .begin_plugin_callback_effect(&cb.id, "owner")
        .unwrap();
    assert_eq!(
        f.store.plugin_worker_call(&call.id).unwrap().unwrap()["inference_operation_id"],
        f.store
            .get_operation_by_command(&f.session, &format!("{}:model:0", f.actor.id))
            .unwrap()
            .id
    );
    assert_eq!(
        f.store.plugin_worker_call(&call.id).unwrap().unwrap()["ordinal"],
        0
    );
    assert_eq!(
        f.store.plugin_worker_call(&next.id).unwrap().unwrap()["ordinal"],
        1
    );
    f.store
        .settle_operation(&f.actor.id, "owner", OperationStatus::Cancelled, &json!({}))
        .unwrap();
    assert!(
        f.store
            .begin_plugin_callback_effect(&cb.id, "owner")
            .is_err()
    );
    assert!(f.store.plugin_worker_record(&f.worker.id).is_ok());
}
#[test]
fn callback_http_requires_own_approval_and_charges_original_account() {
    let mut f = Fixture::new(true);
    let (call, pin) = f.start();
    let cb = f.callback(
        &pin,
        1,
        PluginHostOperation::HttpRequest,
        json!({"url":"http://localhost/","body":"{}"}),
    );
    let payload = f.store.plugin_callback_http_payload(&cb.id).unwrap();
    assert!(f.store.admit_plugin_callback_http(&cb.id, "owner").is_err());
    assert!(
        f.store
            .admit_command(&f.session, "forged", &payload)
            .is_err()
    );
    let approval = f
        .store
        .create_plugin_callback_approval(&cb.id, "owner")
        .unwrap();
    assert_eq!(
        f.store
            .tool_approval_intent(&f.session, &approval.operation_id)
            .unwrap()["schema_version"],
        2
    );
    assert!(
        f.store
            .consume_tool_approval(
                &f.session,
                &approval.operation_id,
                "owner",
                &approval.intent_sha256,
                &format!("{}:http", cb.id),
                &payload
            )
            .is_err()
    );
    f.store
        .decide_tool_approval(
            &f.session,
            "approve-http",
            &approval.operation_id,
            &approval.intent_sha256,
            &zero_protocol::approvals::ToolApprovalDecision::Approve,
            "owner",
        )
        .unwrap();
    let effect = f
        .store
        .consume_tool_approval(
            &f.session,
            &approval.operation_id,
            "owner",
            &approval.intent_sha256,
            &format!("{}:http", cb.id),
            &payload,
        )
        .unwrap();
    let account = f.context["account_id"].as_str().unwrap().to_owned();
    assert!(
        f.store
            .admit_http_hop(
                &f.session,
                &effect.id,
                "owner",
                &account,
                &f.hop(0, "http://localhost/changed"),
                1000
            )
            .is_err()
    );
    let permit = f
        .store
        .admit_http_hop(
            &f.session,
            &effect.id,
            "owner",
            &account,
            &f.hop(0, "http://localhost/"),
            1000,
        )
        .unwrap();
    let crate::HttpAdmission::Admitted { receipt } = permit else {
        panic!("must admit")
    };
    assert!(
        f.store
            .admit_http_hop(
                &f.session,
                &effect.id,
                "owner",
                &account,
                &f.hop(0, "http://localhost/"),
                1000
            )
            .is_err()
    );
    f.store
        .observe_http_headers(&f.session, &effect.id, "owner", &receipt, 302, None, 1000)
        .unwrap();
    f.store.settle_http_hop(&f.session,&effect.id,"owner",&receipt,&json!({"index":0,"permit":{"id":receipt},"status":302,"request_body_bytes":2,"response_wire_bytes":0,"response_decoded_bytes":0,"complete":true,"error":null,"redirect_url":"http://localhost/next"})).unwrap();
    f.reply(&call);
    assert!(
        f.store
            .admit_http_hop(
                &f.session,
                &effect.id,
                "owner",
                &account,
                &f.hop(1, "http://localhost/next"),
                2000
            )
            .is_err()
    );
    let count: u64 = f
        .store
        .conn
        .query_row(
            "SELECT count(*) FROM http_dispatches WHERE account_id=?1",
            [&account],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}
#[test]
fn reserved_kinds_and_corrupt_orphan_callback_inventory_fail_closed() {
    for variant in 0..4 {
        let mut f = Fixture::new(false);
        let (_, pin) = f.start();
        assert!(
            f.store
                .admit_command(&f.session, "forge", &f.worker.payload)
                .is_err()
        );
        assert!(
            f.store
                .admit_owned_batch(
                    &f.session,
                    "owner",
                    &[("forge".into(), f.worker.payload.clone())]
                )
                .is_err()
        );
        let cb = f.callback(&pin, 1, PluginHostOperation::ListSourceFiles, json!({}));
        match variant {
            0 => {
                f.store
                    .conn
                    .execute("DELETE FROM operations WHERE id=?1", [&cb.id])
                    .unwrap();
            }
            1 => {
                f.store.conn.execute("UPDATE operations SET payload=json_set(payload,'$.input.path','/etc/passwd') WHERE id=?1",[&cb.id]).unwrap();
            }
            2 => {
                f.store
                    .conn
                    .execute(
                        "DELETE FROM events WHERE kind='plugin_worker_callback_admitted'",
                        [],
                    )
                    .unwrap();
            }
            _ => {
                f.store
                    .conn
                    .execute(
                        "DELETE FROM events WHERE kind='plugin_worker_callback_admitted'",
                        [],
                    )
                    .unwrap();
                f.store
                    .conn
                    .execute("DELETE FROM operations WHERE id=?1", [&cb.id])
                    .unwrap();
            }
        }
        assert!(f.store.plugin_worker_record(&f.worker.id).is_err());
        assert!(
            f.store
                .admit_plugin_callback(
                    &f.worker.id,
                    "owner",
                    &pin.lease_id,
                    2,
                    PluginHostOperation::ListSourceFiles,
                    &json!({})
                )
                .is_err()
        );
    }
}
#[test]
fn changed_generation_scope_and_epoch_cannot_start_or_dispatch() {
    let mut f = Fixture::new(false);
    let (call, mut pin) = f.call(0);
    pin.epoch = 2;
    assert!(
        f.store
            .bind_plugin_worker_call(&f.worker.id, &call.id, "owner", &pin)
            .is_err()
    );
    pin.epoch = 1;
    f.store
        .bind_plugin_worker_call(&f.worker.id, &call.id, "owner", &pin)
        .unwrap();
    f.store
        .prepare_plugin_worker(&f.worker.id, "owner", &sha(), "worker")
        .unwrap();
    f.store.begin_plugin_worker(&f.worker.id, "owner").unwrap();
    assert!(
        f.store
            .admit_plugin_callback(
                &f.worker.id,
                "owner",
                &pin.lease_id,
                1,
                PluginHostOperation::SearchSourceText,
                &json!({})
            )
            .is_err()
    );
    assert!(
        f.store
            .admit_plugin_callback(
                &f.worker.id,
                "owner",
                &pin.lease_id,
                1,
                PluginHostOperation::HttpRequest,
                &json!({"url":"http://example.com/"})
            )
            .is_err()
    );
    f.store.claim_engine_epoch("replacement").unwrap();
    assert!(
        f.store
            .admit_plugin_callback(
                &f.worker.id,
                "owner",
                &pin.lease_id,
                1,
                PluginHostOperation::ListSourceFiles,
                &json!({})
            )
            .is_err()
    );
    assert!(f.store.plugin_worker_record(&f.worker.id).is_ok());
}

#[test]
fn absolute_deadline_does_not_reset_on_new_attempt_or_preparation() {
    // Leave enough room for bounded journal setup when the full Store suite
    // runs concurrently. Expiry is measured from the retained registration,
    // not from the end of preparation or an assumed setup duration.
    let mut f = Fixture::with_timeout(false, 5_000);
    let deadline = f.worker.payload["deadline_at_ms"].as_u64().unwrap();
    let (call, pin) = f.call(0);
    f.store
        .bind_plugin_worker_call(&f.worker.id, &call.id, "owner", &pin)
        .unwrap();
    f.store
        .prepare_plugin_worker(&f.worker.id, "owner", &sha(), "worker")
        .unwrap();
    assert_eq!(
        f.store.plugin_worker_record(&f.worker.id).unwrap().payload["deadline_at_ms"],
        deadline
    );
    std::thread::sleep(std::time::Duration::from_millis(
        deadline.saturating_sub(now().unwrap()).saturating_add(1),
    ));
    assert!(f.store.begin_plugin_worker(&f.worker.id, "owner").is_err());
    assert!(
        f.store
            .register_plugin_worker(
                &f.session,
                &f.actor.id,
                "owner",
                &uuid::Uuid::new_v4().to_string(),
                "checker",
                "/tmp/retry"
            )
            .is_err()
    );
    assert!(f.store.plugin_worker_record(&f.worker.id).is_ok());
}
#[test]
fn approval_consumption_after_actor_cancellation_is_rejected_without_http_admission() {
    let mut f = Fixture::new(true);
    let (_, pin) = f.start();
    let cb = f.callback(
        &pin,
        1,
        PluginHostOperation::HttpRequest,
        json!({"url":"http://localhost/","body":"{}"}),
    );
    let payload = f.store.plugin_callback_http_payload(&cb.id).unwrap();
    let approval = f
        .store
        .create_plugin_callback_approval(&cb.id, "owner")
        .unwrap();
    f.store
        .decide_tool_approval(
            &f.session,
            "approve",
            &approval.operation_id,
            &approval.intent_sha256,
            &zero_protocol::approvals::ToolApprovalDecision::Approve,
            "owner",
        )
        .unwrap();
    f.store
        .settle_operation(&f.actor.id, "owner", OperationStatus::Cancelled, &json!({}))
        .unwrap();
    assert!(
        f.store
            .consume_tool_approval(
                &f.session,
                &approval.operation_id,
                "owner",
                &approval.intent_sha256,
                &format!("{}:http", cb.id),
                &payload
            )
            .is_err()
    );
    assert!(
        f.store
            .get_tool_approval(&f.session, &approval.operation_id)
            .unwrap()
            .consumption
            .is_none()
    );
    assert_eq!(
        f.store
            .conn
            .query_row("SELECT count(*) FROM http_dispatches", [], |r| r
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn missing_call_link_or_success_without_source_start_cannot_be_read_as_valid() {
    for variant in 0..2 {
        let mut f = Fixture::new(false);
        let (_, pin) = f.start();
        if variant == 0 {
            f.store
                .conn
                .execute(
                    "DELETE FROM events WHERE kind='plugin_worker_call_bound'",
                    [],
                )
                .unwrap();
        } else {
            let cb = f.callback(&pin, 1, PluginHostOperation::ListSourceFiles, json!({}));
            f.store
                .settle_operation(
                    &cb.id,
                    "owner",
                    OperationStatus::Succeeded,
                    &json!({"files":[]}),
                )
                .unwrap();
        }
        assert!(f.store.plugin_worker_record(&f.worker.id).is_err());
    }
}

#[test]
fn failed_callback_witness_rolls_back_slot_and_operation() {
    let mut f = Fixture::new(false);
    let (_, pin) = f.start();
    let counts = |store: &Store| {
        store
            .conn
            .query_row(
                "SELECT (SELECT count(*) FROM operations),(SELECT count(*) FROM events)",
                [],
                |r| Ok((r.get::<_, u64>(0)?, r.get::<_, u64>(1)?)),
            )
            .unwrap()
    };
    let before = counts(&f.store);
    f.store.conn.execute_batch("CREATE TRIGGER reject_callback BEFORE INSERT ON events WHEN NEW.kind='plugin_worker_callback_admitted' BEGIN SELECT RAISE(ABORT,'fixture witness failure'); END;").unwrap();
    assert!(
        f.store
            .admit_plugin_callback(
                &f.worker.id,
                "owner",
                &pin.lease_id,
                1,
                PluginHostOperation::ListSourceFiles,
                &json!({})
            )
            .is_err()
    );
    assert_eq!(counts(&f.store), before);
    f.store
        .conn
        .execute_batch("DROP TRIGGER reject_callback")
        .unwrap();
    f.callback(&pin, 1, PluginHostOperation::ListSourceFiles, json!({}));
}
#[test]
fn deleted_consumption_and_effect_projection_cannot_replay_callback_permission() {
    let mut f = Fixture::new(true);
    let (_, pin) = f.start();
    let cb = f.callback(
        &pin,
        1,
        PluginHostOperation::HttpRequest,
        json!({"url":"http://localhost/"}),
    );
    let payload = f.store.plugin_callback_http_payload(&cb.id).unwrap();
    let approval = f
        .store
        .create_plugin_callback_approval(&cb.id, "owner")
        .unwrap();
    f.store
        .decide_tool_approval(
            &f.session,
            "approve",
            &approval.operation_id,
            &approval.intent_sha256,
            &zero_protocol::approvals::ToolApprovalDecision::Approve,
            "owner",
        )
        .unwrap();
    let command = format!("{}:http", cb.id);
    let op = f
        .store
        .consume_tool_approval(
            &f.session,
            &approval.operation_id,
            "owner",
            &approval.intent_sha256,
            &command,
            &payload,
        )
        .unwrap();
    f.store
        .conn
        .execute(
            "DELETE FROM tool_approval_consumptions WHERE approval_operation_id=?1",
            [&approval.operation_id],
        )
        .unwrap();
    f.store
        .conn
        .execute("DELETE FROM operations WHERE id=?1", [&op.id])
        .unwrap();
    assert!(
        f.store
            .get_tool_approval(&f.session, &approval.operation_id)
            .is_err()
    );
    assert!(
        f.store
            .consume_tool_approval(
                &f.session,
                &approval.operation_id,
                "owner",
                &approval.intent_sha256,
                &command,
                &payload
            )
            .is_err()
    );
    assert!(
        f.store
            .get_operation_by_command(&f.session, &command)
            .is_err()
    );
}

#[test]
fn execution_pin_alone_does_not_authorize_source_callback() {
    let mut f = Fixture::with_source(false, 60_000, false);
    let (_, pin) = f.start();
    assert!(
        f.store
            .admit_plugin_callback(
                &f.worker.id,
                "owner",
                &pin.lease_id,
                1,
                PluginHostOperation::ListSourceFiles,
                &json!({"max_results":1})
            )
            .is_err()
    );
    assert!(
        f.store
            .get_operation_by_command(&f.session, &format!("{}:callback:1", f.worker.id))
            .is_err()
    );
}
#[test]
fn delegated_plugin_cannot_restore_removed_source_tool() {
    let mut f = Fixture::new(false);
    let (call, pin) = f.start();
    let mut state = state(&f.store.conn, &f.worker.id, &mut Reader::new()).unwrap();
    state.actor.payload["parent_operation"] = json!(state.root.id);
    state.actor.payload["delegation_template"] = json!({"tools":[{"name":"inspect"}]});
    let callback = Operation {
        id: "cb".into(),
        session_id: f.session.clone(),
        command_id: format!("{}:callback:1", f.worker.id),
        owner: Some("owner".into()),
        status: OperationStatus::Running,
        outcome: None,
        payload: json!({"kind":"agent_plugin_callback","parent_operation":state.actor.id,"root_operation":state.root.id,"worker_id":f.worker.id,"call_operation_id":call.id,"pin":pin,"callback_id":1,"operation":"list_source_files","input":{"max_results":1}}),
    };
    assert!(validate_callback_payload(&state, &call, &pin, &callback).is_err());
    state.actor.payload["delegation_template"]["tools"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"list_source_files"}));
    validate_callback_payload(&state, &call, &pin, &callback).unwrap();
}
