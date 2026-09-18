use super::*;
impl Store {
    #[allow(clippy::too_many_arguments)]
    pub fn create_tool_approval(
        &mut self,
        session: &str,
        actor_id: &str,
        who: &str,
        command: &str,
        origin_id: &str,
        call: &str,
        alias: &str,
        effect: &Value,
    ) -> Result<Record> {
        for s in [session, actor_id, who, command, origin_id, call, alias] {
            id(s)?;
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut cache = Cache::default();
        let actor = cache.reads.operation(&tx, actor_id)?;
        owner(&actor, session, who)?;
        if zero_protocol::agent::validate_actor_payload(&actor.payload).is_err() {
            return Err(bad("approval target is not an actor"));
        }
        let root_id = actor.payload["parent_operation"]
            .as_str()
            .unwrap_or(actor_id);
        let root = cache.reads.operation(&tx, root_id)?;
        owner(&root, session, who)?;
        if zero_protocol::agent::validate_actor_payload(&root.payload).is_err()
            || root.payload.get("parent_operation").is_some()
        {
            return Err(bad("approval root differs"));
        }
        let count: u64 = tx.query_row(
            "SELECT count(*) FROM tool_approvals WHERE actor_operation_id=?1",
            [actor_id],
            |r| r.get(0),
        )?;
        if count >= 128 {
            return Err(bad("approval actor lifetime limit exceeded"));
        }
        let intent = intent::derive(
            &tx, &actor, command, origin_id, call, alias, effect, &mut cache,
        )?;
        let bytes = serde_json::to_vec(&intent)?;
        if bytes.len() > MAX {
            return Err(bad("approval intent exceeds 8 MiB"));
        }
        let digest = hash(&intent)?;
        let payload = json!({"kind":"agent_approved_tool","parent_operation":actor_id,"root_operation":root_id,"origin_inference_id":origin_id,"call_id":call,"tool_name":alias,"intent_sha256":digest});
        let (operation, sequence) = insert(&tx, session, command, &payload, who)?;
        tx.execute(
            "INSERT OR IGNORE INTO artifacts(digest,bytes) VALUES(?1,?2)",
            params![digest, bytes],
        )?;
        if crate::artifacts::read(&tx, &digest)? != bytes {
            return Err(bad("approval artifact collision"));
        }
        tx.execute("INSERT INTO operation_artifacts(operation_id,name,digest) VALUES(?1,'approval.intent',?2)",params![operation.id,digest])?;
        append(
            &tx,
            session,
            "operation_artifact",
            &json!({"operation_id":operation.id,"name":"approval.intent","digest":digest,"bytes":bytes.len()}),
        )?;
        tx.execute("INSERT INTO tool_approvals(operation_id,session_id,actor_operation_id,root_operation_id,sequence,intent_sha256) VALUES(?1,?2,?3,?4,?5,?6)",params![operation.id,session,actor_id,root_id,integer(sequence)?,digest])?;
        let record = read::checked(&tx, session, &operation.id, &mut Cache::default())?.record;
        tx.commit()?;
        Ok(record)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn decide_tool_approval(
        &mut self,
        session: &str,
        command: &str,
        key: &str,
        digest: &str,
        decision: &Decision,
        who: &str,
    ) -> Result<(Record, Receipt, bool)> {
        for s in [session, command, key, digest, who] {
            id(s)?;
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior:Option<String>=tx.query_row("SELECT CASE WHEN length(CAST(approval_operation_id AS BLOB))<=4096 THEN approval_operation_id END FROM tool_approval_decisions WHERE session_id=?1 AND command_id=?2",params![session,command],|r|r.get(0)).optional()?;
        if let Some(prior) = prior {
            let r = read::checked(&tx, session, &prior, &mut Cache::default())?.record;
            let d = r
                .decision
                .clone()
                .ok_or_else(|| bad("approval decision absent"))?;
            if prior != key || d.intent_sha256 != digest || d.decision != *decision {
                return Err(bad("approval decision retry changed intent"));
            }
            tx.commit()?;
            return Ok((r, d, true));
        }
        let mut cache = Cache::default();
        let checked = read::checked(&tx, session, key, &mut cache)?;
        let r = &checked.record;
        if r.status != Status::Pending || r.intent_sha256 != digest {
            return Err(bad("approval is not pending or digest changed"));
        }
        owner(&checked.operation, session, who)?;
        owner(
            &*cache.reads.operation(&tx, &r.actor_operation_id)?,
            session,
            who,
        )?;
        owner(
            &*cache.reads.operation(&tx, &r.root_operation_id)?,
            session,
            who,
        )?;
        let receipt = Receipt {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session.into(),
            command_id: command.into(),
            approval_operation_id: key.into(),
            intent_sha256: digest.into(),
            decision: *decision,
            sequence: next(&tx, session)?,
        };
        tx.execute("INSERT INTO tool_approval_decisions(id,session_id,command_id,approval_operation_id,intent_sha256,decision,sequence) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![receipt.id,session,command,key,digest,if *decision==Decision::Approve{"approve"}else{"deny"},integer(receipt.sequence)?])?;
        append(
            &tx,
            session,
            "tool_approval_decided",
            &serde_json::to_value(&receipt)?,
        )?;
        if *decision == Decision::Deny {
            settlement(
                &tx,
                &mut (*checked.operation).clone(),
                OperationStatus::Succeeded,
                terminal(key, digest, "denied"),
            )?;
        }
        let record = read::checked(&tx, session, key, &mut Cache::default())?.record;
        tx.commit()?;
        Ok((record, receipt, false))
    }
    pub fn consume_tool_approval(
        &mut self,
        session: &str,
        key: &str,
        who: &str,
        digest: &str,
        command: &str,
        effect: &Value,
    ) -> Result<Operation> {
        for s in [session, key, who, digest, command] {
            id(s)?;
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut cache = Cache::default();
        let checked = read::checked(&tx, session, key, &mut cache)?;
        let r = &checked.record;
        if r.status != Status::Approved
            || r.intent_sha256 != digest
            || checked.intent["effect_command_id"] != command
            || checked.intent["effect_payload"] != *effect
        {
            return Err(bad(
                "approval consumption differs, is unavailable or already consumed",
            ));
        }
        owner(&checked.operation, session, who)?;
        owner(
            &*cache.reads.operation(&tx, &r.actor_operation_id)?,
            session,
            who,
        )?;
        owner(
            &*cache.reads.operation(&tx, &r.root_operation_id)?,
            session,
            who,
        )?;
        let mut payload = effect.clone();
        payload
            .as_object_mut()
            .ok_or_else(|| bad("effect must be object"))?
            .insert("approval_operation".into(), json!(key));
        let (operation, _) = insert(&tx, session, command, &payload, who)?;
        let consumption = Consumption {
            effect_operation_id: operation.id.clone(),
            effect_command_id: command.into(),
            effect_payload_sha256: hash(&payload)?,
            sequence: next(&tx, session)?,
        };
        tx.execute("INSERT INTO tool_approval_consumptions(approval_operation_id,effect_operation_id,effect_command_id,effect_payload_sha256,sequence) VALUES(?1,?2,?3,?4,?5)",params![key,operation.id,command,consumption.effect_payload_sha256,integer(consumption.sequence)?])?;
        append(
            &tx,
            session,
            "tool_approval_consumed",
            &json!({"approval_operation_id":key,"intent_sha256":digest,"consumption":consumption}),
        )?;
        read::checked(&tx, session, key, &mut Cache::default())?;
        tx.commit()?;
        Ok(operation)
    }
    pub fn cancel_tool_approval(&mut self, session: &str, key: &str, who: &str) -> Result<Record> {
        for s in [session, key, who] {
            id(s)?;
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let checked = read::checked(&tx, session, key, &mut Cache::default())?;
        let r = checked.record;
        if matches!(
            r.status,
            Status::Consumed | Status::Denied | Status::Cancelled
        ) {
            tx.commit()?;
            return Ok(r);
        }
        owner(&checked.operation, session, who)?;
        settlement(
            &tx,
            &mut (*checked.operation).clone(),
            OperationStatus::Cancelled,
            terminal(key, &r.intent_sha256, "cancelled"),
        )?;
        let record = read::checked(&tx, session, key, &mut Cache::default())?.record;
        tx.commit()?;
        Ok(record)
    }
}
