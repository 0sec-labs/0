use super::*;
impl Store {
    #[allow(clippy::too_many_arguments)]
    pub fn create_operator_question(
        &mut self,
        session: &str,
        actor_id: &str,
        who: &str,
        command: &str,
        call: &str,
        origin_id: &str,
        request: &Request,
    ) -> Result<Record> {
        for value in [session, actor_id, who, command, call, origin_id] {
            id(value)?;
        }
        request
            .validate()
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actor = operation(&tx, actor_id)?;
        owner(&actor, session, who)?;
        if zero_protocol::agent::validate_actor_payload(&actor.payload).is_err() {
            return Err(bad("question target is not an actor"));
        }
        let root_id = actor.payload["parent_operation"]
            .as_str()
            .unwrap_or(actor_id)
            .to_owned();
        let root = operation(&tx, &root_id)?;
        owner(&root, session, who)?;
        if zero_protocol::agent::validate_actor_payload(&root.payload).is_err()
            || root.payload.get("parent_operation").is_some()
        {
            return Err(bad("question root differs"));
        }
        let count: u64 = tx.query_row(
            "SELECT count(*) FROM operator_questions WHERE actor_operation_id=?1",
            [actor_id],
            |r| r.get(0),
        )?;
        if count >= 128 {
            return Err(bad("operator question lifetime bound exceeded"));
        }
        let origin = read::origin(
            &tx,
            &actor,
            command,
            call,
            origin_id,
            request,
            &mut Reads::default(),
        )?;
        let mut payload = json!({"kind":"agent_operator_question","parent_operation":actor_id,"root_operation":root_id,"origin_inference_id":origin_id,"origin_payload_sha256":hash(&origin.payload)?,"origin_outcome_sha256":hash(&serde_json::to_value(&origin.outcome)?)?,"call_id":call,"request":request,"session_id":session,"tool_command":command,"schema_version":1});
        payload["request_sha256"] = json!(hash(&payload)?);
        let text = serde_json::to_string(&payload)?;
        let key = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO operations(id,session_id,command_id,payload,payload_hash,status) VALUES(?1,?2,?3,?4,?5,'admitted')",params![key,session,command,text,format!("{:x}",Sha256::digest(text.as_bytes()))])?;
        let mut op = operation(&tx, &key)?;
        let sequence = next(&tx, session)?;
        append(
            &tx,
            session,
            "command_admitted",
            &serde_json::to_value(&op)?,
        )?;
        tx.execute("INSERT INTO operator_questions(operation_id,session_id,actor_operation_id,root_operation_id,sequence) VALUES(?1,?2,?3,?4,?5)",params![key,session,actor_id,root_id,integer(sequence)?])?;
        tx.execute(
            "UPDATE operations SET status='running',owner=?2 WHERE id=?1",
            params![key, who],
        )?;
        op.status = OperationStatus::Running;
        op.owner = Some(who.into());
        append(
            &tx,
            session,
            "operation_started",
            &serde_json::to_value(&op)?,
        )?;
        let result = read::record(&tx, session, &key, &mut Reads::default())?;
        tx.commit()?;
        Ok(result)
    }
    pub fn decide_operator_question(
        &mut self,
        session: &str,
        command: &str,
        key: &str,
        expected: &str,
        decision: &Decision,
        who: &str,
    ) -> Result<(Record, Receipt, bool)> {
        for value in [session, command, key, expected, who] {
            id(value)?;
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior:Option<String>=tx.query_row("SELECT CASE WHEN length(CAST(question_operation_id AS BLOB))<=4096 THEN question_operation_id END FROM operator_question_decisions WHERE session_id=?1 AND command_id=?2",params![session,command],|r|r.get(0)).optional()?;
        if let Some(prior) = prior {
            let record = read::record(&tx, session, &prior, &mut Reads::default())?;
            let receipt = record
                .decision
                .clone()
                .ok_or_else(|| bad("decision receipt absent"))?;
            if prior != key || receipt.request_sha256 != expected || receipt.decision != *decision {
                return Err(bad("operator decision retry changed intent"));
            }
            tx.commit()?;
            return Ok((record, receipt, true));
        }
        let record = read::record(&tx, session, key, &mut Reads::default())?;
        if record.status != Status::Pending || record.request_sha256 != expected {
            return Err(bad("question is not pending or its request changed"));
        }
        decision
            .validate(&record.request)
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let mut op = full(&tx, key)?;
        owner(&op, session, who)?;
        owner(&operation(&tx, &record.actor_operation_id)?, session, who)?;
        owner(&operation(&tx, &record.root_operation_id)?, session, who)?;
        let receipt = Receipt {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session.into(),
            command_id: command.into(),
            question_operation_id: key.into(),
            request_sha256: expected.into(),
            decision: decision.clone(),
            sequence: next(&tx, session)?,
        };
        tx.execute("INSERT INTO operator_question_decisions(id,session_id,command_id,question_operation_id,request_sha256,decision,sequence) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![receipt.id,session,command,key,expected,serde_json::to_string(decision)?,integer(receipt.sequence)?])?;
        append(
            &tx,
            session,
            "operator_question_decided",
            &serde_json::to_value(&receipt)?,
        )?;
        settlement(
            &tx,
            &mut op,
            OperationStatus::Succeeded,
            outcome(key, expected, Some(decision)),
        )?;
        let result = read::record(&tx, session, key, &mut Reads::default())?;
        tx.commit()?;
        Ok((result, receipt, false))
    }
    pub fn cancel_operator_question(
        &mut self,
        session: &str,
        key: &str,
        who: &str,
    ) -> Result<Record> {
        for value in [session, key, who] {
            id(value)?;
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let record = read::record(&tx, session, key, &mut Reads::default())?;
        if matches!(
            record.status,
            Status::Answered | Status::Dismissed | Status::Cancelled
        ) {
            tx.commit()?;
            return Ok(record);
        }
        let mut op = full(&tx, key)?;
        owner(&op, session, who)?;
        settlement(
            &tx,
            &mut op,
            OperationStatus::Cancelled,
            outcome(key, &record.request_sha256, None),
        )?;
        let result = read::record(&tx, session, key, &mut Reads::default())?;
        tx.commit()?;
        Ok(result)
    }
}
