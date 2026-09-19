//! Bounded model-directed Development experiments; private evaluation is terminal.
mod development;
mod read;
mod types;
use crate::code_proposal::now;
use crate::{PythonCandidateOutput, PythonProposalContext, Result, digest, invalid};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    fs::File,
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;
use types::*;
pub use types::{DevelopmentFeedback, PythonSearchInspection, PythonSearchPlan, SearchStep};
use zero_evolution::Registry;
use zero_harness::HostGrants;
use zero_protocol::{
    model::{Completion, Content, ResponsesRequest, ToolDefinition},
    session::Operation,
};
use zero_store::{PythonHoldoutClaim, VerifiedPythonHoldout, VerifiedPythonSearchInference};

pub struct PythonSearch {
    root: PathBuf,
    conn: Connection,
    _lock: File,
    intent: Intent,
    source: Registry,
}
impl PythonSearch {
    pub fn create(
        root: &Path,
        source: &Registry,
        plan: PythonSearchPlan,
        grants: &HostGrants,
        context: PythonProposalContext,
    ) -> Result<Self> {
        plan.validate()?;
        context.validate()?;
        if now()? >= plan.proposal.expires_at_ms {
            return Err(invalid("Python search deadline expired"));
        }
        let baseline = source.generation(&plan.proposal.baseline)?;
        if baseline.configuration != json!({"native_plugin_graph":1})
            || baseline.components.len() != 1
            || baseline.engine_artifact != plan.proposal.engine_artifact
            || baseline.policy_artifact != plan.proposal.host_policy_artifact
            || source.artifact(&baseline.policy_artifact)? != grants.artifact_bytes()?
        {
            return Err(invalid("Python search frozen graph/authority differs"));
        }
        let component = baseline
            .components
            .get(&format!("plugin:{}", plan.proposal.plugin))
            .ok_or_else(|| invalid("Python search plugin absent"))?;
        let plugin = zero_plugin::Manifest::parse(&source.artifact(component)?)?;
        if plugin.id != plan.proposal.plugin
            || plugin.artifacts.len() != 1
            || !plugin.dependencies.is_empty()
            || plugin.entrypoint.argv != ["{artifact}"]
            || plugin.capabilities()
                != std::collections::BTreeSet::from([zero_plugin::Capability::Compute])
            || !plugin.tools.iter().any(|t| t.name == plan.proposal.tool)
        {
            return Err(invalid(
                "Python search requires frozen Compute-only single-source contract",
            ));
        }
        let bytes = source.artifact(&format!("sha256:{}", plugin.entrypoint.artifact))?;
        if bytes.len() > 32768
            || bytes.len() as u64 != plugin.artifacts[0].size
            || std::str::from_utf8(&bytes).is_err()
        {
            return Err(invalid("Python search baseline source bound"));
        }
        let root = root
            .parent()
            .ok_or_else(|| invalid("search parent absent"))?
            .canonicalize()?
            .join(
                root.file_name()
                    .ok_or_else(|| invalid("search root absent"))?,
            );
        let intent = Intent {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            root: root.clone(),
            context,
            plan,
            baseline,
            plugin,
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().mode(0o700).create(&root)?;
        }
        #[cfg(not(unix))]
        {
            return Err(invalid("Python search requires Unix"));
        }
        let (conn, lock, root) = crate::ledger::open_named(&root, true, "search.sqlite")?;
        conn.execute_batch("PRAGMA synchronous=FULL;PRAGMA journal_mode=DELETE;PRAGMA application_id=1514493521;PRAGMA user_version=1;
CREATE TABLE search(singleton INTEGER PRIMARY KEY CHECK(singleton=1),intent TEXT NOT NULL,intent_sha TEXT NOT NULL,phase TEXT NOT NULL,charged INTEGER NOT NULL,slots INTEGER NOT NULL,selection INTEGER,exposure TEXT);
CREATE TABLE rounds(idx INTEGER PRIMARY KEY,command TEXT NOT NULL UNIQUE,request TEXT NOT NULL,request_sha TEXT NOT NULL,operation TEXT,kind TEXT,source_sha TEXT,candidate TEXT,feedback TEXT);
CREATE TABLE development_attempts(round INTEGER NOT NULL,idx INTEGER NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(round,idx));")?;
        conn.execute("INSERT INTO search(singleton,intent,intent_sha,phase,charged,slots) VALUES(1,?1,?2,'ready',0,0)",params![serde_json::to_string(&intent)?,intent.sha()?])?;
        let mut private = Registry::open(
            root.join("candidate.sqlite"),
            &intent.baseline.state_schema,
            &json!({"python_search_private":true}),
        )?;
        for id in [
            &intent.baseline.engine_artifact,
            &intent.baseline.policy_artifact,
            &intent.plan.proposal.evaluator_artifact,
            intent
                .baseline
                .components
                .values()
                .next()
                .ok_or_else(|| invalid("component absent"))?,
        ] {
            if private.put_artifact(&source.artifact(id)?)? != *id {
                return Err(invalid("search artifact identity drift"));
            }
        }
        if private.put_artifact(&bytes)? != format!("sha256:{}", intent.plugin.entrypoint.artifact)
            || private.register_generation(&intent.baseline)? != intent.plan.proposal.baseline
        {
            return Err(invalid("search baseline identity drift"));
        }
        Ok(Self {
            root,
            conn,
            _lock: lock,
            intent,
            source: private,
        })
    }
    pub fn plan(&self) -> &PythonSearchPlan {
        &self.intent.plan
    }
    pub fn context(&self) -> &PythonProposalContext {
        &self.intent.context
    }
    pub fn phase(&self) -> Result<String> {
        Ok(self
            .conn
            .query_row("SELECT phase FROM search WHERE singleton=1", [], |r| {
                r.get(0)
            })?)
    }
    pub fn inspect(root: &Path) -> Result<PythonSearchInspection> {
        read::inspect(root)
    }
    pub fn check_retry(
        root: &Path,
        plan: &PythonSearchPlan,
        context: &PythonProposalContext,
        grants: &HostGrants,
    ) -> Result<()> {
        Self::inspect(root)?;
        let conn = Connection::open_with_flags(
            root.join("search.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        let raw: String = conn.query_row(
            "SELECT CASE WHEN length(CAST(intent AS BLOB))<=2097152 THEN intent END FROM search",
            [],
            |r| r.get(0),
        )?;
        let intent: Intent = serde_json::from_str(&raw)?;
        if serde_json::to_vec(plan)? != serde_json::to_vec(&intent.plan)?
            || *context != intent.context
            || digest(&grants.artifact_bytes()?) != intent.plan.proposal.host_policy_artifact
        {
            return Err(invalid("search retry differs from frozen authority"));
        }
        Ok(())
    }
    pub fn finish(&self, phase: &str) -> Result<()> {
        if !matches!(
            phase,
            "stopped"
                | "cancelled"
                | "deadline"
                | "budget_limit"
                | "round_limit"
                | "attempt_limit"
                | "inference_failed"
                | "proposal_rejected"
                | "unknown_cleanup"
                | "evaluation_failed"
                | "completed"
                | "context_limit"
        ) {
            return Err(invalid("invalid search terminal phase"));
        }
        self.conn
            .execute("UPDATE search SET phase=?1 WHERE singleton=1", [phase])?;
        Ok(())
    }
    /// Durable admission precedes provider work. Existing rounds never replay.
    pub fn next_request(&mut self) -> Result<Option<(String, ResponsesRequest)>> {
        let (phase, charged): (String, u64) = self.conn.query_row(
            "SELECT phase,charged FROM search WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if phase != "ready" {
            return Err(invalid("Python search is not ready for inference"));
        }
        if now()? >= self.intent.plan.proposal.expires_at_ms {
            self.finish("deadline")?;
            return Ok(None);
        }
        let idx: usize = self
            .conn
            .query_row("SELECT count(*) FROM rounds", [], |r| r.get(0))?;
        if idx >= self.intent.plan.max_rounds {
            self.finish("round_limit")?;
            return Ok(None);
        }
        if charged
            .checked_add(self.intent.plan.proposal.reservation)
            .is_none_or(|v| v > self.intent.plan.max_proposal_spend)
        {
            self.finish("budget_limit")?;
            return Ok(None);
        }
        let request = match self.render(idx) {
            Ok(request) => request,
            Err(e) => {
                self.finish("context_limit")?;
                return Err(e);
            }
        };
        let command = format!("{}:search:{idx}", self.intent.context.command_id);
        if command.len() > 256 {
            return Err(invalid("search command identifier bound"));
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO rounds(idx,command,request,request_sha) VALUES(?1,?2,?3,?4)",
            params![
                idx,
                command,
                serde_json::to_string(&request)?,
                request_sha(&request)?
            ],
        )?;
        tx.execute(
            "UPDATE search SET phase='inference_running' WHERE singleton=1",
            [],
        )?;
        tx.commit()?;
        Ok(Some((command, request)))
    }
    fn render(&self, idx: usize) -> Result<ResponsesRequest> {
        render(&self.intent, &self.source, idx, &self.feedback()?)
    }
    fn feedback(&self) -> Result<Vec<DevelopmentFeedback>> {
        let mut q = self
            .conn
            .prepare("SELECT feedback FROM rounds WHERE feedback IS NOT NULL ORDER BY idx")?;
        q.query_map([], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect()
    }
    /// Retain a failed/uncertain original Engine reply for inspection; never grants execution.
    pub fn record_failed_inference(&self, operation: &Operation, cancelled: bool) -> Result<()> {
        let (idx,command,request_hash):(usize,String,String)=self.conn.query_row("SELECT idx,command,request_sha FROM rounds WHERE operation IS NULL ORDER BY idx LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        if self.phase()? != "inference_running"
            || operation.session_id != self.intent.context.session_id
            || operation.command_id != command
            || digest(&serde_json::to_vec(&operation.payload["request"])?) != request_hash
        {
            return Err(invalid("failed search inference identity differs"));
        }
        let raw = serde_json::to_string(operation)?;
        if raw.len() > 2097152 {
            return Err(invalid("failed search operation bound"));
        }
        let charge = if operation.status == zero_protocol::session::OperationStatus::Succeeded {
            let completion: Completion = serde_json::from_value(
                operation
                    .outcome
                    .clone()
                    .ok_or_else(|| invalid("failed accounting outcome absent"))?,
            )?;
            let rates: zero_protocol::model::Rates =
                serde_json::from_value(operation.payload["rates"].clone())?;
            completion
                .usage
                .as_ref()
                .and_then(|u| rates.charge(u))
                .ok_or_else(|| invalid("failed accounting charge absent"))?
        } else {
            0
        };
        self.conn.execute(
            "UPDATE rounds SET operation=?1 WHERE idx=?2",
            params![raw, idx],
        )?;
        let charged: u64 = self
            .conn
            .query_row("SELECT charged FROM search", [], |r| r.get(0))?;
        self.conn.execute(
            "UPDATE search SET charged=?1,phase=?2 WHERE singleton=1",
            params![
                charged
                    .checked_add(charge)
                    .ok_or_else(|| invalid("search charge overflow"))?,
                if cancelled {
                    "cancelled"
                } else {
                    "inference_failed"
                }
            ],
        )?;
        Ok(())
    }
    pub fn record_inference(
        &mut self,
        witness: VerifiedPythonSearchInference,
    ) -> Result<SearchStep> {
        let op = witness.operation();
        let (idx,command,request,sha):(usize,String,String,String)=self.conn.query_row("SELECT idx,command,request,request_sha FROM rounds WHERE operation IS NULL ORDER BY idx LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        let phase: String =
            self.conn
                .query_row("SELECT phase FROM search WHERE singleton=1", [], |r| {
                    r.get(0)
                })?;
        let request: ResponsesRequest = serde_json::from_str(&request)?;
        if phase != "inference_running"
            || op.session_id != self.intent.context.session_id
            || op.command_id != command
            || op.payload["provider"] != self.intent.plan.proposal.provider
            || op.payload["reservation"] != self.intent.plan.proposal.reservation
            || digest(&serde_json::to_vec(&op.payload["request"])?) != sha
            || request_sha(&request)? != sha
        {
            return Err(invalid(
                "search inference differs from retained host request",
            ));
        }
        let raw = serde_json::to_string(op)?;
        if raw.len() > 2 * 1024 * 1024 {
            return Err(invalid("search operation bound"));
        }
        let charged: u64 =
            self.conn
                .query_row("SELECT charged FROM search WHERE singleton=1", [], |r| {
                    r.get(0)
                })?;
        let charged = charged
            .checked_add(witness.charge())
            .ok_or_else(|| invalid("search charge overflow"))?;
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE rounds SET operation=?1 WHERE idx=?2",
            params![raw, idx],
        )?;
        tx.execute(
            "UPDATE search SET charged=?1,phase='proposal_settled' WHERE singleton=1",
            [charged],
        )?;
        tx.commit()?;
        if charged > self.intent.plan.max_proposal_spend {
            self.finish("budget_limit")?;
            return Err(invalid("actual proposal charges exceeded search cap"));
        }
        if now()? >= self.intent.plan.proposal.expires_at_ms {
            self.finish("deadline")?;
            return Err(invalid("search deadline expired"));
        }
        let completion: Completion = serde_json::from_value(
            op.outcome
                .clone()
                .ok_or_else(|| invalid("search outcome absent"))?,
        )?;
        let calls: Vec<_> = completion
            .content
            .iter()
            .filter_map(|c| match c {
                Content::ToolCall {
                    name, arguments, ..
                } => Some((name, arguments)),
                _ => None,
            })
            .collect();
        if calls.len() != 1 {
            return Err(invalid("search requires one tool call"));
        }
        let (name, args) = calls[0];
        let (source, rationale, experiment) = if name == "experiment_python_candidate" {
            let out: Experiment = serde_json::from_value(args.clone())?;
            (out.source_utf8, out.rationale, true)
        } else if name == "submit_python_candidate" {
            let output: PythonCandidateOutput = serde_json::from_value(args.clone())?;
            output.validate()?;
            match output {
                PythonCandidateOutput::Stop { .. } => {
                    self.conn
                        .execute("UPDATE rounds SET kind='stop' WHERE idx=?1", [idx])?;
                    self.finish("stopped")?;
                    return Ok(SearchStep::Stop);
                }
                PythonCandidateOutput::Propose {
                    source_utf8,
                    rationale,
                } => (source_utf8, rationale, false),
            }
        } else {
            return Err(invalid("unsupported search tool"));
        };
        PythonCandidateOutput::Propose {
            source_utf8: source.clone(),
            rationale,
        }
        .validate()?;
        let source_sha = digest(source.as_bytes());
        if !experiment {
            let completed = self.feedback()?.iter().any(|f| {
                f.source_sha256 == source_sha
                    && f.completed
                    && f.attempted == f.settled
                    && f.attempted > 0
            });
            if !completed {
                return Err(invalid(
                    "selection lacks completed measured Development evidence",
                ));
            }
        }
        let (candidate, source_sha) = self.materialize(&source)?;
        self.conn.execute(
            "UPDATE rounds SET source_sha=?1,candidate=?2,kind=?3 WHERE idx=?4",
            params![
                source_sha,
                candidate,
                if experiment {
                    "experiment"
                } else {
                    "selection"
                },
                idx
            ],
        )?;
        if experiment {
            self.conn.execute(
                "UPDATE search SET phase='experiment_ready' WHERE singleton=1",
                [],
            )?;
            Ok(SearchStep::Experiment { round: idx })
        } else {
            self.conn.execute(
                "UPDATE search SET phase='selected',selection=?1 WHERE singleton=1",
                [idx],
            )?;
            Ok(SearchStep::Selected {
                claim: PythonHoldoutClaim {
                    session_id: op.session_id.clone(),
                    command_id: command,
                    operation_id: op.id.clone(),
                    request_sha256: sha,
                    intent_sha256: self.intent.sha()?,
                    suite_sha256: self.intent.plan.proposal.suite_sha256()?,
                    candidate_sha256: candidate,
                    source_sha256: source_sha,
                },
            })
        }
    }
    fn materialize(&mut self, source: &str) -> Result<(String, String)> {
        let mut plugin = self.intent.plugin.clone();
        let source_sha = self.source.put_artifact(source.as_bytes())?;
        plugin.entrypoint.artifact = zero_plugin::sha256(source.as_bytes());
        plugin.artifacts = vec![zero_plugin::Artifact {
            sha256: plugin.entrypoint.artifact.clone(),
            size: source.len() as u64,
        }];
        plugin.validate()?;
        let component = self.source.put_artifact(&serde_json::to_vec(&plugin)?)?;
        let mut manifest = self.intent.baseline.clone();
        manifest
            .components
            .insert(format!("plugin:{}", plugin.id), component);
        let candidate = self.source.register_generation(&manifest)?;
        if candidate == self.intent.plan.proposal.baseline {
            return Err(invalid("experiment must change baseline source"));
        }
        Ok((candidate, source_sha))
    }
    pub async fn evaluate(
        &mut self,
        witness: VerifiedPythonHoldout,
        grants: &HostGrants,
        runner: &zero_plugin_runner::Runner,
        cancel: CancellationToken,
    ) -> Result<crate::Report> {
        let receipt = witness.receipt();
        let (phase, idx): (String, usize) = self.conn.query_row(
            "SELECT phase,selection FROM search WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let (candidate, source_sha, request_sha, command, operation): (
            String,
            String,
            String,
            String,
            String,
        ) = self.conn.query_row(
            "SELECT candidate,source_sha,request_sha,command,operation FROM rounds WHERE idx=?1",
            [idx],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
        let operation: Operation = serde_json::from_str(&operation)?;
        let expected = PythonHoldoutClaim {
            session_id: self.intent.context.session_id.clone(),
            command_id: command,
            operation_id: operation.id,
            request_sha256: request_sha,
            intent_sha256: self.intent.sha()?,
            suite_sha256: self.intent.plan.proposal.suite_sha256()?,
            candidate_sha256: candidate.clone(),
            source_sha256: source_sha,
        };
        if phase != "selected"
            || receipt.claim != expected
            || cancel.is_cancelled()
            || now()? >= self.intent.plan.proposal.expires_at_ms
        {
            return Err(invalid("search finalization authority/deadline differs"));
        }
        self.conn.execute(
            "UPDATE search SET phase='evaluation_running',exposure=?1 WHERE singleton=1",
            [serde_json::to_string(receipt)?],
        )?;
        let mut evaluation = crate::Evaluation::create(
            &self.root.join("evaluation"),
            &self.source,
            self.intent.plan.proposal.evaluation(candidate),
            grants,
        )?;
        let child = cancel.child_token();
        if now()? >= self.intent.plan.proposal.expires_at_ms {
            child.cancel();
        }
        let run = evaluation.run(runner, child.clone());
        tokio::pin!(run);
        let remaining = self
            .intent
            .plan
            .proposal
            .expires_at_ms
            .saturating_sub(now()?);
        let result = tokio::select! {result=&mut run=>result,_=tokio::time::sleep(std::time::Duration::from_millis(remaining))=>{child.cancel();let result=run.await;self.finish("deadline")?;return result}};
        self.finish(if cancel.is_cancelled() {
            "cancelled"
        } else if now()? >= self.intent.plan.proposal.expires_at_ms {
            "deadline"
        } else if result.is_ok() {
            "completed"
        } else {
            "evaluation_failed"
        })?;
        result
    }
}

fn render(
    intent: &Intent,
    source: &Registry,
    idx: usize,
    feedback: &[DevelopmentFeedback],
) -> Result<ResponsesRequest> {
    let baseline = source.artifact(&format!("sha256:{}", intent.plugin.entrypoint.artifact))?;
    let public: Vec<_> = intent
        .plan
        .proposal
        .cases
        .iter()
        .filter(|c| c.lane == crate::Lane::Development)
        .map(|c| json!({"id":c.id,"input":c.input,"expected":c.expected}))
        .collect();
    let sources:Vec<_>=feedback.iter().map(|f|Ok(json!({"source_sha256":f.source_sha256,"source_utf8":String::from_utf8(source.artifact(&f.source_sha256)?).map_err(|_|invalid("measured Python source UTF-8"))?}))).collect::<Result<_>>()?;
    let p = &intent.plan.proposal;
    let submit=ToolDefinition{name:"submit_python_candidate".into(),description:"Select exact source already measured in a completed Development experiment, or stop. Private evaluation is terminal and never feeds another model turn.".into(),parameters:json!({"type":"object","oneOf":[{"type":"object","additionalProperties":false,"required":["action","source_utf8","rationale"],"properties":{"action":{"const":"propose"},"source_utf8":{"type":"string","maxLength":32768},"rationale":{"type":"string","maxLength":4096}}},{"type":"object","additionalProperties":false,"required":["action","reason"],"properties":{"action":{"const":"stop"},"reason":{"type":"string","maxLength":4096}}}]})};
    let experiment=ToolDefinition{name:"experiment_python_candidate".into(),description:"Measure source against public Development cases in fresh offline Python guests; measurements do not certify eligibility.".into(),parameters:json!({"type":"object","additionalProperties":false,"required":["source_utf8","rationale"],"properties":{"source_utf8":{"type":"string","minLength":1,"maxLength":32768},"rationale":{"type":"string","minLength":1,"maxLength":4096}}})};
    let input = json!({"intent_sha256":intent.sha()?,"round":idx,"round_limit":intent.plan.max_rounds,"objective":p.objective,"baseline_source_utf8":std::str::from_utf8(&baseline).map_err(|_|invalid("baseline UTF-8"))?,"plugin_contract":intent.plugin,"development_examples":public,"measured_development_feedback":feedback,"measured_candidate_sources":sources});
    let request=ResponsesRequest{model:p.model.clone(),instructions:"Choose an experiment hypothesis and Python JSON-RPC plugin source, select a previously measured source, or stop. Call exactly one offered tool. Code reads one newline JSON-RPC2.0 tool.invoke and writes one matching result/error frame under Python3 -I offline. Host owns limits, contract, oracles and eligibility. Development measurements are public feedback, not independent success. Private results never return to you.".into(),input:vec![json!({"role":"user","content":[{"type":"input_text","text":serde_json::to_string(&input)?}]})],tools:vec![experiment,submit],max_output_tokens:p.max_output_tokens};
    if serde_json::to_vec(&request)?.len() > 256 * 1024 {
        return Err(invalid("search prompt bound"));
    }
    Ok(request)
}
