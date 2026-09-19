//! One paid proposal, one immutable source change, one independently scored schedule.
mod read;
mod types;
use crate::{Evaluation, Result, digest, invalid};
use rusqlite::{Connection, params};
use serde_json::json;
use std::{
    fs::File,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;
use types::*;
pub use types::{
    PythonCandidateOutput, PythonEvolutionInspection, PythonEvolutionPlan, PythonProposalContext,
};
use zero_evolution::Registry;
use zero_harness::HostGrants;
use zero_plugin_runner::Runner;
use zero_protocol::{
    model::{Completion, CompletionStatus, Content, Rates, ResponsesRequest},
    session::{Operation, OperationStatus},
};
use zero_store::{PythonHoldoutClaim, VerifiedPythonHoldout};

pub struct PythonProposal {
    root: PathBuf,
    conn: Connection,
    _lock: File,
    intent: Intent,
    request: ResponsesRequest,
    source: Registry,
}
pub(super) fn now() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| invalid("clock before epoch"))?
        .as_millis()
        .try_into()
        .map_err(|_| invalid("clock overflow"))
}
fn parsed(
    intent: &Intent,
    request: &ResponsesRequest,
    op: &Operation,
) -> Result<PythonCandidateOutput> {
    if op.session_id != intent.context.session_id
        || op.command_id != intent.context.command_id
        || op.status != OperationStatus::Succeeded
        || op.payload["provider"] != intent.plan.provider
        || op.payload["reservation"] != intent.plan.reservation
        || digest(&serde_json::to_vec(&op.payload["request"])?) != request_sha(request)?
    {
        return Err(invalid(
            "retained Python inference differs from captured intent",
        ));
    }
    let completion: Completion = serde_json::from_value(
        op.outcome
            .clone()
            .ok_or_else(|| invalid("proposal outcome absent"))?,
    )?;
    let rates: Rates = serde_json::from_value(op.payload["rates"].clone())?;
    if completion.status != CompletionStatus::Completed
        || !completion.usage_is_final
        || completion.error.is_some()
        || completion
            .usage
            .as_ref()
            .and_then(|u| rates.charge(u))
            .is_none()
    {
        return Err(invalid(
            "Python proposal requires final usable usage and successful completion",
        ));
    }
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
    if calls.len() != 1 || calls[0].0 != "submit_python_candidate" {
        return Err(invalid(
            "Python proposal requires exactly one submit_python_candidate call",
        ));
    }
    let output: PythonCandidateOutput = serde_json::from_value(calls[0].1.clone())?;
    output.validate()?;
    Ok(output)
}
fn source_only(
    intent: &Intent,
    source: &str,
) -> Result<(zero_plugin::Manifest, zero_evolution::Manifest)> {
    let mut plugin = intent.plugin_manifest.clone();
    let id = zero_plugin::sha256(source.as_bytes());
    plugin.entrypoint.artifact = id.clone();
    plugin.artifacts = vec![zero_plugin::Artifact {
        sha256: id,
        size: source.len() as u64,
    }];
    plugin.validate()?;
    let mut manifest = intent.baseline_manifest.clone();
    manifest.components.insert(
        format!("plugin:{}", intent.plan.plugin),
        digest(&serde_json::to_vec(&plugin)?),
    );
    Ok((plugin, manifest))
}
impl PythonProposal {
    /// New private root only. An existing root is inspected, never resumed/replayed.
    pub fn create(
        root: &Path,
        source: &Registry,
        plan: PythonEvolutionPlan,
        grants: &HostGrants,
        context: PythonProposalContext,
    ) -> Result<Self> {
        plan.validate()?;
        context.validate()?;
        if now()? >= plan.expires_at_ms {
            return Err(invalid("Python proposal deadline expired"));
        }
        let manifest = source.generation(&plan.baseline)?;
        if manifest.configuration != json!({"native_plugin_graph":1})
            || manifest.components.len() != 1
            || manifest.engine_artifact != plan.engine_artifact
            || manifest.policy_artifact != plan.host_policy_artifact
            || source.artifact(&manifest.policy_artifact)? != grants.artifact_bytes()?
        {
            return Err(invalid(
                "Python proposal requires one frozen native plugin graph and exact host authority",
            ));
        }
        let component = manifest
            .components
            .get(&format!("plugin:{}", plan.plugin))
            .ok_or_else(|| invalid("selected Python plugin absent"))?;
        let plugin = zero_plugin::Manifest::parse(&source.artifact(component)?)?;
        if plugin.id != plan.plugin
            || plugin.artifacts.len() != 1
            || !plugin.dependencies.is_empty()
            || plugin.entrypoint.argv != ["{artifact}"]
            || plugin.capabilities()
                != std::collections::BTreeSet::from([zero_plugin::Capability::Compute])
            || !plugin.tools.iter().any(|t| t.name == plan.tool)
        {
            return Err(invalid(
                "Python proposal supports one Compute-only source artifact, fixed tools and no dependencies",
            ));
        }
        let source_bytes = source.artifact(&format!("sha256:{}", plugin.entrypoint.artifact))?;
        if source_bytes.len() > MAX_SOURCE || source_bytes.len() as u64 != plugin.artifacts[0].size
        {
            return Err(invalid("baseline Python source bound"));
        }
        let baseline_source = std::str::from_utf8(&source_bytes)
            .map_err(|_| invalid("baseline Python source must be UTF-8"))?;
        let controller_root = root
            .parent()
            .ok_or_else(|| invalid("proposal parent absent"))?
            .canonicalize()?
            .join(
                root.file_name()
                    .ok_or_else(|| invalid("proposal name absent"))?,
            );
        let intent = Intent {
            semantics: SEMANTICS.into(),
            controller_id: uuid::Uuid::new_v4().to_string(),
            controller_root,
            context,
            plan,
            baseline_manifest: manifest.clone(),
            plugin_manifest: plugin.clone(),
            source_state: source.current()?,
        };
        let request = render(&intent, baseline_source)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().mode(0o700).create(root)?;
        }
        #[cfg(not(unix))]
        {
            return Err(invalid("Python proposal requires Unix private ownership"));
        }
        let (conn, lock, root) = crate::ledger::open_named(root, true, "proposal.sqlite")?;
        conn.execute_batch("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA application_id=1514493520; PRAGMA user_version=1; CREATE TABLE proposal(singleton INTEGER PRIMARY KEY CHECK(singleton=1),intent TEXT NOT NULL,intent_sha TEXT NOT NULL,request TEXT NOT NULL,request_sha TEXT NOT NULL,phase TEXT NOT NULL,operation TEXT,candidate TEXT,source_sha TEXT,exposure TEXT);")?;
        conn.execute("INSERT INTO proposal(singleton,intent,intent_sha,request,request_sha,phase) VALUES(1,?1,?2,?3,?4,'ready')",params![serde_json::to_string(&intent)?,intent.sha()?,serde_json::to_string(&request)?,request_sha(&request)?])?;
        let mut private = Registry::open(
            root.join("candidate.sqlite"),
            &manifest.state_schema,
            &json!({"python_evolution_private":true}),
        )?;
        for id in [
            &manifest.engine_artifact,
            &manifest.policy_artifact,
            &intent.plan.evaluator_artifact,
            component,
        ] {
            if private.put_artifact(&source.artifact(id)?)? != *id {
                return Err(invalid("frozen artifact identity changed"));
            }
        }
        if private.put_artifact(&source_bytes)? != format!("sha256:{}", plugin.entrypoint.artifact)
            || private.register_generation(&manifest)? != intent.plan.baseline
        {
            return Err(invalid("frozen baseline identity changed"));
        }
        Ok(Self {
            root,
            conn,
            _lock: lock,
            intent,
            request,
            source: private,
        })
    }
    pub fn request(&self) -> ResponsesRequest {
        self.request.clone()
    }
    pub fn plan(&self) -> &PythonEvolutionPlan {
        &self.intent.plan
    }
    pub fn context(&self) -> &PythonProposalContext {
        &self.intent.context
    }
    pub fn begin_proposal(&self) -> Result<()> {
        if now()? >= self.intent.plan.expires_at_ms {
            return Err(invalid("Python proposal deadline expired"));
        }
        if self.conn.execute(
            "UPDATE proposal SET phase='proposal_running' WHERE singleton=1 AND phase='ready'",
            [],
        )? != 1
        {
            return Err(invalid("Python proposal already admitted; no replay"));
        }
        Ok(())
    }
    /// Retain paid output before parsing. Model code is stored as bytes, never compiled on the host.
    pub fn record_inference(
        &mut self,
        operation: &Operation,
    ) -> Result<Option<PythonHoldoutClaim>> {
        let raw = serde_json::to_string(operation)?;
        if raw.len() > 2 * 1024 * 1024 {
            return Err(invalid("proposal outcome exceeds bound"));
        }
        if self.conn.execute("UPDATE proposal SET operation=?1,phase='proposal_settled' WHERE singleton=1 AND phase='proposal_running'",[raw])?!=1 {return Err(invalid("proposal outcome cannot be replaced"))}
        let output = parsed(&self.intent, &self.request, operation)?;
        match output {
            PythonCandidateOutput::Stop { .. } => {
                self.finish("model_stop")?;
                Ok(None)
            }
            PythonCandidateOutput::Propose { source_utf8, .. } => {
                let (plugin, manifest) = source_only(&self.intent, &source_utf8)?;
                let source_sha = self.source.put_artifact(source_utf8.as_bytes())?;
                let component = self.source.put_artifact(&serde_json::to_vec(&plugin)?)?;
                if manifest.components.get(&format!("plugin:{}", plugin.id)) != Some(&component) {
                    return Err(invalid("candidate manifest identity differs"));
                }
                let candidate = self.source.register_generation(&manifest)?;
                if candidate == self.intent.plan.baseline {
                    return Err(invalid("proposal did not change the Python source"));
                }
                self.conn.execute("UPDATE proposal SET candidate=?1,source_sha=?2,phase='candidate_ready' WHERE singleton=1",params![candidate,source_sha])?;
                Ok(Some(PythonHoldoutClaim {
                    session_id: self.intent.context.session_id.clone(),
                    command_id: self.intent.context.command_id.clone(),
                    operation_id: operation.id.clone(),
                    request_sha256: request_sha(&self.request)?,
                    intent_sha256: self.intent.sha()?,
                    suite_sha256: self.intent.plan.suite_sha256()?,
                    candidate_sha256: candidate,
                    source_sha256: source_sha,
                }))
            }
        }
    }
    pub fn finish(&self, phase: &str) -> Result<()> {
        if !matches!(
            phase,
            "model_stop"
                | "proposal_rejected"
                | "inference_failed"
                | "cancelled"
                | "deadline"
                | "exposure_rejected"
                | "evaluation_failed"
                | "completed"
        ) {
            return Err(invalid("invalid Python proposal terminal phase"));
        }
        self.conn
            .execute("UPDATE proposal SET phase=?1 WHERE singleton=1", [phase])?;
        Ok(())
    }
    pub async fn evaluate(
        &mut self,
        exposure: VerifiedPythonHoldout,
        grants: &HostGrants,
        runner: &Runner,
        cancel: CancellationToken,
    ) -> Result<crate::Report> {
        if now()? >= self.intent.plan.expires_at_ms || cancel.is_cancelled() {
            return Err(invalid("Python evaluation cancelled or deadline expired"));
        }
        let receipt = exposure.receipt();
        let (candidate,source_sha):(String,String)=self.conn.query_row("SELECT candidate,source_sha FROM proposal WHERE singleton=1 AND phase='candidate_ready'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
        if receipt.claim.intent_sha256 != self.intent.sha()?
            || receipt.claim.candidate_sha256 != candidate
            || receipt.claim.source_sha256 != source_sha
            || receipt.claim.suite_sha256 != self.intent.plan.suite_sha256()?
            || receipt.claim.request_sha256 != request_sha(&self.request)?
            || receipt.claim.session_id != self.intent.context.session_id
            || receipt.claim.command_id != self.intent.context.command_id
        {
            return Err(invalid(
                "verified exposure differs from Python candidate intent",
            ));
        }
        self.conn.execute(
            "UPDATE proposal SET exposure=?1,phase='evaluation_starting' WHERE singleton=1",
            [serde_json::to_string(receipt)?],
        )?;
        let mut evaluation = Evaluation::create(
            &self.root.join("evaluation"),
            &self.source,
            self.intent.plan.evaluation(candidate),
            grants,
        )?;
        self.conn.execute(
            "UPDATE proposal SET phase='evaluation_running' WHERE singleton=1",
            [],
        )?;
        let child = cancel.child_token();
        let remaining = self.intent.plan.expires_at_ms.saturating_sub(now()?);
        let run = evaluation.run(runner, child.clone());
        tokio::pin!(run);
        let report = tokio::select! {
            result=&mut run=>result?,
            _=tokio::time::sleep(std::time::Duration::from_millis(remaining))=>{
                child.cancel();
                let result=run.await;
                self.finish("deadline")?;
                return result;
            }
        };
        self.finish("completed")?;
        Ok(report)
    }
    pub fn check_retry(
        root: &Path,
        plan: &PythonEvolutionPlan,
        context: &PythonProposalContext,
        grants: &HostGrants,
    ) -> Result<()> {
        read::check_retry(root, plan, context, grants)
    }
    pub fn inspect(root: &Path) -> Result<PythonEvolutionInspection> {
        read::inspect(root)
    }
}
