use super::*;
pub(super) fn validate(a: &ScanAdmission) -> Result<()> {
    for key in [
        &a.scan_id,
        &a.session_id,
        &a.controller_operation_id,
        &a.root_operation_id,
    ] {
        uuid::Uuid::parse_str(key).map_err(bad)?;
    }
    let unique: std::collections::BTreeSet<_> = [
        &a.scan_id,
        &a.session_id,
        &a.controller_operation_id,
        &a.root_operation_id,
    ]
    .into_iter()
    .collect();
    if unique.len() != 4
        || a.input_target.is_empty()
        || a.input_target.len() > 8192
        || a.profile_name.is_empty()
        || a.profile_name.len() > 128
    {
        return Err(bad("admission identity bounds"));
    }
    a.profile.validate().map_err(bad)?;
    if a.provider_context.len() > 9 || encode(a)?.len() > MAX_SCAN_INTENT_BYTES - 1024 {
        return Err(bad("intent bound"));
    }
    let request = zero_protocol::agent::validate_actor_payload(&a.root_payload).map_err(bad)?;
    if serde_json::to_value(&request)?
        != serde_json::to_value(a.profile.request(&a.target).map_err(bad)?)?
        || a.root_payload.get("parent_operation").is_some()
        || a.root_payload.get("scan_context").is_some()
        || a.root_payload.get("scan_operation_id").is_some()
        || a.root_payload["http_output_version"] != 2
    {
        return Err(bad("root bypasses frozen scan request"));
    }
    let template: zero_protocol::model::ResponsesRequest =
        serde_json::from_value(a.root_payload["scan_template"].clone())?;
    if template.model != request.model
        || template.instructions != request.instructions
        || !template.input.is_empty()
    {
        return Err(bad("captured scan template differs"));
    }
    let mut names = std::collections::BTreeSet::new();
    for tool in &template.tools {
        if !names.insert(&tool.name)
            || !matches!(
                tool.name.as_str(),
                "http_request" | "submit_web_hypotheses" | "delegate_tasks" | "run_web_experiment"
            )
            || (tool.name == "delegate_tasks" && request.delegation_policy.is_none())
            || (tool.name == "run_web_experiment" && request.web_experiment_policy.is_none())
        {
            return Err(bad("scan tool authority differs"));
        }
    }
    if !names.contains(&"http_request".to_string())
        || !names.contains(&"submit_web_hypotheses".to_string())
    {
        return Err(bad("required scan tools absent"));
    }
    let h = &a.root_payload["http_context"];
    let policy: zero_protocol::http::HttpProfilePolicy =
        serde_json::from_value(h["profile"].clone())?;
    if zero_http::normalize_target(&policy, &a.input_target).map_err(bad)? != a.target
        || zero_http::normalize_target(&policy, &a.target).map_err(bad)? != a.target
        || serde_json::to_value(zero_http::normalize_policy(policy.clone()).map_err(bad)?)?
            != h["profile"]
        || h["schema_version"] != 1
        || h["profile_name"] != a.profile.http_profile
        || h["original_root_command"] != format!("scan:{}:root", a.scan_id)
        || h["profile_sha256"] != hash(&h["profile"])?
        || h["account_id"]
            != hash(
                &json!({"session_id":a.session_id,"original_root_command":h["original_root_command"],"profile_sha256":h["profile_sha256"]}),
            )?
    {
        return Err(bad("HTTP target or account authority differs"));
    }
    hooks::provider(&a.root_payload, &request.provider, &a.provider_context)?;
    for role in request.delegation_policy.iter().flat_map(|p| &p.roles) {
        let p = a
            .provider_context
            .get(&role.provider)
            .ok_or_else(|| bad("role provider absent"))?;
        if p.endpoint.len() > 8192 || p.endpoint.is_empty() {
            return Err(bad("provider route bounds"));
        }
    }
    Ok(())
}
fn insert(
    conn: &rusqlite::Transaction<'_>,
    id: &str,
    session: &str,
    command: &str,
    payload: &Value,
    owner: &str,
) -> Result<Operation> {
    let text = encode(payload)?;
    conn.execute("INSERT INTO operations(id,session_id,command_id,payload,payload_hash,status) VALUES(?1,?2,?3,?4,?5,'admitted')",params![id,session,command,text,format!("{:x}",Sha256::digest(text.as_bytes()))])?;
    let mut op = Operation {
        id: id.into(),
        session_id: session.into(),
        command_id: command.into(),
        payload: payload.clone(),
        status: OperationStatus::Admitted,
        owner: None,
        outcome: None,
    };
    append(
        conn,
        session,
        "command_admitted",
        &serde_json::to_value(&op)?,
    )?;
    conn.execute(
        "UPDATE operations SET status='running',owner=?2 WHERE id=?1",
        params![id, owner],
    )?;
    op.status = OperationStatus::Running;
    op.owner = Some(owner.into());
    append(
        conn,
        session,
        "operation_started",
        &serde_json::to_value(&op)?,
    )?;
    Ok(op)
}
impl Store {
    pub fn admit_scan(
        &mut self,
        command: &str,
        owner: &str,
        a: &ScanAdmission,
    ) -> Result<AdmittedScan> {
        id(command)?;
        id(owner)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(record) = read::by_command(&tx, command, &mut Reader::new())? {
            if record.input_target != a.input_target || record.profile_name != a.profile_name {
                return Err(bad("command reused for different target/profile"));
            }
            let bound = read::bound(&tx, &record.id, &mut Reader::new())?;
            return Ok(AdmittedScan {
                scan: record,
                root: bound.root,
                controller: bound.controller,
                duplicate: true,
            });
        }
        epoch(&tx, owner)?;
        validate(a)?;
        let created = now()?;
        let deadline = created
            .checked_add(a.profile.deadline_ms)
            .ok_or_else(|| bad("deadline overflow"))?;
        integer(deadline)?;
        let intent = json!({"schema_version":1,"kind":"native_scan_intent","admission":a,"command_id":command,"created_at_ms":created,"deadline_at_ms":deadline});
        let bytes = encode(&intent)?.into_bytes();
        if bytes.len() > MAX_SCAN_INTENT_BYTES {
            return Err(bad("intent exceeds bound"));
        }
        let digest = hash(&intent)?;
        let session = zero_protocol::session::Session {
            id: a.session_id.clone(),
            generation: format!("native-scan:{}", a.scan_id),
            generation_epoch: None,
            created_at_ms: created,
            budget_limit: a.profile.budget_limit,
        };
        tx.execute(
            "INSERT INTO sessions(id,generation,created_at_ms,budget_limit) VALUES(?1,?2,?3,?4)",
            params![
                session.id,
                session.generation,
                integer(created)?,
                integer(session.budget_limit)?
            ],
        )?;
        append(
            &tx,
            &session.id,
            "session_created",
            &serde_json::to_value(&session)?,
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO artifacts(digest,bytes) VALUES(?1,?2)",
            params![digest, bytes],
        )?;
        if crate::artifacts::read(&tx, &digest)? != bytes {
            return Err(bad("artifact collision"));
        }
        let sequence: u64 =
            tx.query_row("SELECT coalesce(max(sequence),0)+1 FROM scans", [], |r| {
                r.get(0)
            })?;
        let record = ScanRecord {
            schema_version: 1,
            id: a.scan_id.clone(),
            command_id: command.into(),
            session_id: a.session_id.clone(),
            controller_operation_id: a.controller_operation_id.clone(),
            root_operation_id: a.root_operation_id.clone(),
            input_target: a.input_target.clone(),
            target: a.target.clone(),
            profile_name: a.profile_name.clone(),
            intent_sha256: digest.clone(),
            profile_sha256: hash(&a.profile)?,
            http_account_id: a.root_payload["http_context"]["account_id"]
                .as_str()
                .ok_or_else(|| bad("account absent"))?
                .into(),
            created_at_ms: created,
            deadline_at_ms: deadline,
            sequence,
        };
        let controller = insert(
            &tx,
            &a.controller_operation_id,
            &a.session_id,
            &format!("scan:{}", a.scan_id),
            &json!({"kind":"native_scan","scan_id":a.scan_id,"intent_sha256":digest,"root_operation_id":a.root_operation_id}),
            owner,
        )?;
        let mut root_payload = a.root_payload.clone();
        root_payload["scan_operation_id"] = json!(controller.id);
        root_payload["scan_context"] = context(&record);
        let root = insert(
            &tx,
            &a.root_operation_id,
            &a.session_id,
            &format!("scan:{}:root", a.scan_id),
            &root_payload,
            owner,
        )?;
        tx.execute(
            "INSERT INTO operation_artifacts(operation_id,name,digest) VALUES(?1,'scan.intent',?2)",
            params![controller.id, digest],
        )?;
        append(
            &tx,
            &a.session_id,
            "operation_artifact",
            &json!({"operation_id":controller.id,"name":"scan.intent","digest":digest,"bytes":bytes.len()}),
        )?;
        let binding: u64 = tx.query_row(
            "SELECT coalesce(max(sequence),0)+1 FROM events WHERE session_id=?1",
            [&a.session_id],
            |r| r.get(0),
        )?;
        tx.execute("INSERT INTO scans(sequence,id,command_id,session_id,controller_operation_id,root_operation_id,intent_sha256,record,binding_sequence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![integer(sequence)?,record.id,command,record.session_id,record.controller_operation_id,record.root_operation_id,digest,encode(&record)?,integer(binding)?])?;
        append(
            &tx,
            &a.session_id,
            "scan_created",
            &serde_json::to_value(&record)?,
        )?;
        crate::http::ensure_account(&tx, &a.session_id, &root.payload["http_context"])?;
        tx.commit()?;
        Ok(AdmittedScan {
            scan: record,
            controller,
            root,
            duplicate: false,
        })
    }
}
