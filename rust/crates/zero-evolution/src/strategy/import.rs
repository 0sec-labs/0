use super::*;
use zero_protocol::strategy_search::StrategySearchReport;
enum VerifiedReport {
    Fixed(Box<StrategyReport>),
    Search(Box<StrategySearchReport>),
}
fn search_head(d: &StrategySearchEvidenceDescriptor) -> StrategyEvidenceDescriptor {
    StrategyEvidenceDescriptor {
        schema_version: d.schema_version,
        binding: d.binding.clone(),
        campaign_id: d.campaign_id.clone(),
        snapshot_sha256: d.snapshot_sha256.clone(),
        report_sha256: d.report_sha256.clone(),
        suite_sha256: d.suite_sha256.clone(),
        pair_sha256: d.pair_sha256.clone(),
    }
}
fn descriptor_head(bytes: &[u8]) -> Result<StrategyEvidenceDescriptor> {
    let v: Value = serde_json::from_slice(bytes)?;
    match v["schema_version"].as_u64() {
        Some(1) => Ok(serde_json::from_value(v)?),
        Some(2) => Ok(search_head(&serde_json::from_value(v)?)),
        _ => Err(invalid("unsupported strategy evidence descriptor")),
    }
}

fn request_hash(request: &StrategyImportRequest) -> Result<String> {
    if request.command_id.is_empty()
        || request.command_id.len() > 256
        || request.campaign_id.is_empty()
        || request.campaign_id.len() > 256
        || !zero_protocol::is_sha256(&request.expected_evidence_sha256)
    {
        return Err(invalid("invalid strategy import intent"));
    }
    Ok(hash(encode(request)?.as_bytes()))
}
fn usability(conn: &Connection, r: &StrategyImportReceipt) -> Result<StrategyEligibilityUsability> {
    let state = lifecycle::current(conn)?;
    if state.generation.as_deref() != Some(&r.baseline_generation) {
        return Ok(StrategyEligibilityUsability::StaleBaseline);
    }
    if state.epoch != r.baseline_epoch {
        return Ok(StrategyEligibilityUsability::StaleEpoch);
    }
    if state.state_digest != r.baseline_state_sha256 {
        return Ok(StrategyEligibilityUsability::StaleState);
    }
    let e: Eligibility = read_json(conn, "eligibilities", &r.eligibility_sha256)?;
    let Some(Scope::Measured {
        canary_required, ..
    }) = e.strategy_scope
    else {
        return Err(invalid("strategy measured scope absent"));
    };
    Ok(if canary_required {
        StrategyEligibilityUsability::MissingActivationPrerequisite
    } else {
        StrategyEligibilityUsability::Current
    })
}
fn record(conn: &Connection, command: &str) -> Result<Option<StrategyImportReceipt>> {
    let row:Option<(String,String,String,String,String,String)>=conn.query_row("SELECT CASE WHEN length(CAST(record_json AS BLOB))<=?2 THEN record_json END,CASE WHEN length(CAST(record_sha256 AS BLOB))=71 THEN record_sha256 END,CASE WHEN length(CAST(request_sha256 AS BLOB))=71 THEN request_sha256 END,CASE WHEN length(CAST(evidence_sha256 AS BLOB))=71 THEN evidence_sha256 END,CASE WHEN length(CAST(receipt_sha256 AS BLOB))=71 THEN receipt_sha256 END,CASE WHEN length(CAST(eligibility_sha256 AS BLOB))=71 THEN eligibility_sha256 END FROM strategy_imports WHERE command_id=?1",params![command,MAX_JSON_BYTES],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    let Some((raw, digest, request, evidence, receipt, eligibility)) = row else {
        return Ok(None);
    };
    let r: StrategyImportReceipt = serde_json::from_str(&raw)?;
    let projection:(String,String,String)=conn.query_row("SELECT CASE WHEN length(CAST(suite_sha256 AS BLOB))=71 THEN suite_sha256 END,CASE WHEN length(CAST(pair_sha256 AS BLOB))=71 THEN pair_sha256 END,CASE WHEN length(CAST(campaign_id AS BLOB))<=256 THEN campaign_id END FROM strategy_imports WHERE command_id=?1",[command],|q|Ok((q.get(0)?,q.get(1)?,q.get(2)?)))?;
    if projection
        != (
            r.suite_sha256.clone(),
            r.pair_sha256.clone(),
            r.campaign_id.clone(),
        )
    {
        return Err(invalid("strategy import suite projection differs"));
    }

    if hash(raw.as_bytes()) != digest
        || r.registry != identity(conn)?
        || r.command_id != command
        || r.request_sha256 != request
        || r.evidence_sha256 != evidence
        || r.evaluation_receipt_sha256 != receipt
        || r.eligibility_sha256 != eligibility
    {
        return Err(invalid("strategy import projection differs"));
    }
    let descriptor = descriptor_head(&bounded_artifact(conn, &evidence, MAX_JSON_BYTES)?)?;
    let e: Eligibility = read_json(conn, "eligibilities", &eligibility)?;
    let evaluation: EvaluationReceipt = read_json(conn, "receipts", &receipt)?;
    if descriptor.binding.registry != r.registry
        || descriptor.campaign_id != r.campaign_id
        || descriptor.report_sha256 != r.report_sha256
        || descriptor.suite_sha256 != r.suite_sha256
        || descriptor.pair_sha256 != r.pair_sha256
        || descriptor.binding.candidate_generation != r.candidate_generation
        || descriptor.binding.baseline_generation != r.baseline_generation
        || descriptor.binding.baseline_epoch != r.baseline_epoch
        || descriptor.binding.baseline_state_sha256 != r.baseline_state_sha256
        || e.generation != r.candidate_generation
        || e.receipt.as_deref() != Some(&receipt)
        || evaluation.candidate != r.candidate_generation
        || evaluation.baseline != r.baseline_generation
        || evaluation.decision != EvaluationDecision::Eligible
        || !matches!(e.strategy_scope,Some(Scope::Measured{binding,evidence_sha256,report_sha256,..}) if *binding==descriptor.binding && evidence_sha256==evidence && report_sha256==r.report_sha256)
    {
        return Err(invalid("strategy import scope/receipt differs"));
    }
    Ok(Some(r))
}
fn prior(
    conn: &Connection,
    request: &StrategyImportRequest,
) -> Result<Option<StrategyImportResult>> {
    let digest = request_hash(request)?;
    let Some(receipt) = record(conn, &request.command_id)? else {
        return Ok(None);
    };
    if receipt.request_sha256 != digest
        || receipt.campaign_id != request.campaign_id
        || receipt.evidence_sha256 != request.expected_evidence_sha256
    {
        return Err(Error::Conflict("strategy import command reused".into()));
    }
    Ok(Some(StrategyImportResult {
        receipt_sha256: hash(encode(&receipt)?.as_bytes()),
        usability: usability(conn, &receipt)?,
        receipt,
        duplicate: true,
    }))
}
impl Registry {
    pub fn strategy_import_by_command(
        &self,
        request: &StrategyImportRequest,
    ) -> Result<Option<StrategyImportResult>> {
        let tx = self.conn.unchecked_transaction()?;
        prior(&tx, request)
    }
    pub fn strategy_import_receipt(&self, digest: &str) -> Result<StrategyImportResult> {
        let tx = self.conn.unchecked_transaction()?;
        let command:String=tx.query_row("SELECT CASE WHEN length(CAST(command_id AS BLOB))<=256 THEN command_id END FROM strategy_imports WHERE record_sha256=?1",[digest],|r|r.get(0)).optional()?.ok_or_else(||Error::Missing(digest.into()))?;
        let receipt = record(&tx, &command)?.ok_or_else(|| Error::Missing(digest.into()))?;
        Ok(StrategyImportResult {
            receipt_sha256: hash(encode(&receipt)?.as_bytes()),
            usability: usability(&tx, &receipt)?,
            receipt,
            duplicate: true,
        })
    }
    pub fn strategy_evidence_descriptor(
        &self,
        receipt_digest: &str,
    ) -> Result<StrategyEvidenceDescriptor> {
        let result = self.strategy_import_receipt(receipt_digest)?;
        Ok(serde_json::from_slice(&self.artifact_bounded(
            &result.receipt.evidence_sha256,
            MAX_JSON_BYTES,
        )?)?)
    }
    /// Trusted host bridge only: F is the compiled source-evidence validator, never selected by model input.
    pub fn import_strategy_evidence<F>(
        &mut self,
        request: &StrategyImportRequest,
        descriptor: &StrategyEvidenceDescriptor,
        artifacts: &std::collections::BTreeMap<String, Vec<u8>>,
        verify: F,
    ) -> Result<StrategyImportResult>
    where
        F: FnOnce(&dyn Fn(&str) -> Result<Vec<u8>>) -> Result<StrategyReport>,
    {
        if descriptor.schema_version != 1 {
            return Err(invalid("fixed-pair descriptor version differs"));
        }
        self.import_measured(
            request,
            descriptor,
            &encode(descriptor)?,
            None,
            artifacts,
            |reader| verify(reader).map(|report| VerifiedReport::Fixed(Box::new(report))),
        )
    }
    pub fn import_strategy_search_evidence<F>(
        &mut self,
        request: &StrategyImportRequest,
        descriptor: &StrategySearchEvidenceDescriptor,
        artifacts: &std::collections::BTreeMap<String, Vec<u8>>,
        verify: F,
    ) -> Result<StrategyImportResult>
    where
        F: FnOnce(&dyn Fn(&str) -> Result<Vec<u8>>) -> Result<StrategySearchReport>,
    {
        if descriptor.schema_version != 2 {
            return Err(invalid("adaptive search descriptor version differs"));
        }
        self.import_measured(
            request,
            &search_head(descriptor),
            &encode(descriptor)?,
            Some(descriptor),
            artifacts,
            |reader| verify(reader).map(|report| VerifiedReport::Search(Box::new(report))),
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn import_measured<F>(
        &mut self,
        request: &StrategyImportRequest,
        descriptor: &StrategyEvidenceDescriptor,
        encoded_descriptor: &str,
        search: Option<&StrategySearchEvidenceDescriptor>,
        artifacts: &std::collections::BTreeMap<String, Vec<u8>>,
        verify: F,
    ) -> Result<StrategyImportResult>
    where
        F: FnOnce(&dyn Fn(&str) -> Result<Vec<u8>>) -> Result<VerifiedReport>,
    {
        if let Some(prior) = self.strategy_import_by_command(request)? {
            return Ok(prior);
        }
        let request_digest = request_hash(request)?;
        if !matches!(descriptor.schema_version, 1 | 2)
            || hash(encoded_descriptor.as_bytes()) != request.expected_evidence_sha256
            || descriptor.campaign_id != request.campaign_id
            || artifacts.len() > 4096
            || artifacts
                .get(&request.expected_evidence_sha256)
                .map(Vec::as_slice)
                != Some(encoded_descriptor.as_bytes())
        {
            return Err(invalid("strategy evidence root differs"));
        }
        let mut total = 0usize;
        for (id, bytes) in artifacts {
            total = total
                .checked_add(bytes.len())
                .ok_or_else(|| invalid("strategy evidence overflow"))?;
            if bytes.is_empty()
                || bytes.len() > 4 * 1024 * 1024
                || total > 64 * 1024 * 1024
                || hash(bytes) != *id
            {
                return Err(invalid("strategy evidence bounds or identity"));
            }
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(prior) = prior(&tx, request)? {
            return Ok(prior);
        }
        let used:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM strategy_imports WHERE suite_sha256=?1) OR EXISTS(SELECT 1 FROM eligibilities WHERE CASE WHEN length(CAST(json AS BLOB))<=1048576 AND json_valid(json) THEN json_extract(json,'$.strategy_scope.protected_suite_sha256') END=?1)",[&descriptor.suite_sha256],|r|r.get(0))?;
        if used {
            return Err(Error::Ineligible(
                "protected strategy suite already imported in this registry".into(),
            ));
        }
        validate_binding(&tx, &descriptor.binding, true)?;
        let (candidate, _, authority) = parts(&tx, &descriptor.binding.candidate_generation)?;
        if !authority
            .accepted_suite_sha256
            .contains(&descriptor.suite_sha256)
        {
            return Err(Error::Ineligible(
                "strategy protected suite not authorized".into(),
            ));
        }
        for (id, bytes) in artifacts {
            tx.execute(
                "INSERT OR IGNORE INTO artifacts(digest,bytes) VALUES(?1,?2)",
                params![id, bytes],
            )?;
            if bounded_artifact(&tx, id, 4 * 1024 * 1024)? != *bytes {
                return Err(invalid("strategy artifact collision"));
            }
        }
        let reader = |id: &str| -> Result<Vec<u8>> {
            if !artifacts.contains_key(id) {
                return Err(invalid("strategy evidence read outside imported closure"));
            }
            bounded_artifact(&tx, id, 4 * 1024 * 1024)
        };
        let verified = verify(&reader)?;
        let raw_report = match &verified {
            VerifiedReport::Fixed(r) => encode(r)?,
            VerifiedReport::Search(r) => encode(r)?,
        };
        if hash(raw_report.as_bytes()) != descriptor.report_sha256
            || artifacts.get(&descriptor.report_sha256).map(Vec::as_slice)
                != Some(raw_report.as_bytes())
        {
            return Err(invalid("full canonical strategy report differs"));
        }
        let qualification = match &verified {
            VerifiedReport::Fixed(report) => {
                if hash(raw_report.as_bytes()) != descriptor.report_sha256
                    || artifacts.get(&descriptor.report_sha256).map(Vec::as_slice)
                        != Some(raw_report.as_bytes())
                    || report.campaign_id != descriptor.campaign_id
                    || report.baseline_sha256 != descriptor.binding.baseline_advisory_sha256
                    || report.candidate_sha256 != descriptor.binding.candidate_advisory_sha256
                    || report.suite_sha256 != descriptor.suite_sha256
                    || report.decision != StrategyDecision::ImprovedForFixtureSuite
                    || report.completed_lanes.len() != 2
                    || !report
                        .completed_lanes
                        .contains(&zero_protocol::campaign::CampaignLane::Development)
                    || !report
                        .completed_lanes
                        .contains(&zero_protocol::campaign::CampaignLane::Final)
                    || report.usage.model_reserved_micro_usd != 0
                    || report.usage.http_response_reserved_bytes != 0
                    || report.usage.active_runs != 0
                    || report.usage.unknown_runs != 0
                    || report.usage.model_charged_micro_usd
                        > authority.campaign_limits.model_micro_usd
                {
                    return Err(Error::Ineligible(
                        "strategy evidence is not fully measured improvement".into(),
                    ));
                }
                "measured_local_strategy_fixture"
            }
            VerifiedReport::Search(report) => {
                validate_search_report(
                    report,
                    search.ok_or_else(|| invalid("search descriptor absent"))?,
                    &authority,
                )?;
                "measured_adaptive_search_fixture"
            }
        };
        let evaluator = hash(&evaluator_descriptor());
        let renderer = hash(&renderer_descriptor());
        for (id, bytes) in [
            (&evaluator, evaluator_descriptor()),
            (&renderer, renderer_descriptor()),
        ] {
            tx.execute(
                "INSERT OR IGNORE INTO artifacts(digest,bytes) VALUES(?1,?2)",
                params![id, bytes],
            )?;
            if artifact(&tx, id)? != bytes {
                return Err(invalid("strategy descriptor collision"));
            }
        }
        let evaluation = EvaluationReceipt {
            candidate: descriptor.binding.candidate_generation.clone(),
            baseline: descriptor.binding.baseline_generation.clone(),
            evaluator_artifact: evaluator,
            policy_artifact: candidate.policy_artifact,
            evidence_artifacts: std::collections::BTreeMap::from([
                (
                    "strategy.evidence".into(),
                    request.expected_evidence_sha256.clone(),
                ),
                (
                    "strategy.snapshot".into(),
                    descriptor.snapshot_sha256.clone(),
                ),
                ("strategy.report".into(), descriptor.report_sha256.clone()),
                ("strategy.renderer".into(), renderer),
            ]),
            decision: EvaluationDecision::Eligible,
            observations: serde_json::json!({"qualification":qualification,"campaign_id":descriptor.campaign_id,"suite_sha256":descriptor.suite_sha256,"pair_sha256":descriptor.pair_sha256}),
        };
        for id in evaluation.evidence_artifacts.values() {
            bounded_artifact(&tx, id, 4 * 1024 * 1024)?;
        }
        let raw = encode(&evaluation)?;
        let receipt_id = hash(raw.as_bytes());
        insert_json(&tx, "receipts", &receipt_id, &raw)?;
        let eligible = Eligibility {
            generation: descriptor.binding.candidate_generation.clone(),
            receipt: Some(receipt_id.clone()),
            bootstrap_reason: None,
            strategy_scope: Some(Scope::Measured {
                binding: Box::new(descriptor.binding.clone()),
                evidence_sha256: request.expected_evidence_sha256.clone(),
                report_sha256: descriptor.report_sha256.clone(),
                canary_required: authority.canary_required,
                protected_suite_sha256: descriptor.suite_sha256.clone(),
                evaluation_pair_sha256: descriptor.pair_sha256.clone(),
                retained_artifacts: artifacts
                    .iter()
                    .map(|(id, bytes)| (id.clone(), bytes.len() as u64))
                    .collect(),
            }),
        };
        let raw = encode(&eligible)?;
        let eligibility_id = hash(raw.as_bytes());
        insert_json(&tx, "eligibilities", &eligibility_id, &raw)?;
        let receipt = StrategyImportReceipt {
            suite_sha256: descriptor.suite_sha256.clone(),
            pair_sha256: descriptor.pair_sha256.clone(),
            schema_version: 1,
            registry: identity(&tx)?,
            command_id: request.command_id.clone(),
            request_sha256: request_digest,
            campaign_id: request.campaign_id.clone(),
            evidence_sha256: request.expected_evidence_sha256.clone(),
            report_sha256: descriptor.report_sha256.clone(),
            evaluation_receipt_sha256: receipt_id,
            eligibility_sha256: eligibility_id,
            candidate_generation: descriptor.binding.candidate_generation.clone(),
            baseline_generation: descriptor.binding.baseline_generation.clone(),
            baseline_epoch: descriptor.binding.baseline_epoch,
            baseline_state_sha256: descriptor.binding.baseline_state_sha256.clone(),
            qualification: qualification.into(),
        };
        let raw = encode(&receipt)?;
        tx.execute(
            "INSERT INTO strategy_imports VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                receipt.command_id,
                receipt.request_sha256,
                receipt.evidence_sha256,
                receipt.evaluation_receipt_sha256,
                receipt.eligibility_sha256,
                hash(raw.as_bytes()),
                raw,
                receipt.suite_sha256,
                receipt.pair_sha256,
                receipt.campaign_id
            ],
        )?;
        let usability = usability(&tx, &receipt)?;
        tx.commit()?;
        Ok(StrategyImportResult {
            receipt_sha256: hash(encode(&receipt)?.as_bytes()),
            receipt,
            duplicate: false,
            usability,
        })
    }
}

fn validate_search_report(
    r: &StrategySearchReport,
    d: &StrategySearchEvidenceDescriptor,
    a: &StrategyHostAuthority,
) -> Result<()> {
    let s = r
        .selection
        .as_ref()
        .ok_or_else(|| invalid("search has no sealed Final selection"))?;
    let measured = r
        .final_measurement
        .as_ref()
        .ok_or_else(|| invalid("search has no Final measurement"))?;
    let dev = r
        .evaluations
        .iter()
        .find(|e| e.evaluation.id == s.evaluation_id)
        .ok_or_else(|| invalid("selected Development evaluation absent"))?;
    let u = &r.usage;
    let invalid_case = |r: &zero_protocol::strategy::StrategyCaseResult| {
        r.disposition != zero_protocol::strategy::StrategyCaseDisposition::Observed
            || r.model_reserved_micro_usd != 0
    };
    if r.schema_version != 2
        || r.qualification != "adaptive_search_fixture"
        || r.campaign_id != d.campaign_id
        || r.config_sha256 != d.config_sha256
        || s.config_sha256 != d.config_sha256
        || hash(encode(s)?.as_bytes()) != d.selection_sha256
        || s.binding != d.binding
        || s.suite_sha256 != d.suite_sha256
        || s.final_pair_sha256 != d.pair_sha256
        || !dev.improved
        || dev.cases.len() != dev.evaluation.run_count as usize
        || dev.cases.iter().any(invalid_case)
        || measured.decision != StrategyDecision::ImprovedForFixtureSuite
        || measured.cases.len() != s.run_count as usize
        || measured.cases.iter().any(invalid_case)
        || measured
            .matrix_sha256
            .as_ref()
            .is_none_or(|d| !zero_protocol::is_sha256(d))
        || r.proposals.iter().any(|p| {
            matches!(
                p.operation_status,
                zero_protocol::session::OperationStatus::Admitted
                    | zero_protocol::session::OperationStatus::Running
                    | zero_protocol::session::OperationStatus::Unknown
            )
        })
        || u.model_reserved_micro_usd != 0
        || u.http_response_reserved_bytes != 0
        || u.active_runs != 0
        || u.unknown_runs != 0
        || u.model_charged_micro_usd > a.campaign_limits.model_micro_usd
        || u.model_calls > u64::from(a.campaign_limits.model_calls)
        || u.http_requests > a.campaign_limits.http_requests
        || u.http_request_body_bytes > a.campaign_limits.http_request_body_bytes
        || u.http_response_charged_bytes > a.campaign_limits.http_response_decoded_bytes
        || u.experiments > u64::from(a.campaign_limits.experiments)
        || u.runs > u64::from(a.campaign_limits.runs)
    {
        return Err(Error::Ineligible(
            "complete adaptive search does not establish independently measured improvement".into(),
        ));
    }
    Ok(())
}
