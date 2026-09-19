use crate::{
    Case, MAX_EVIDENCE_BYTES, MAX_PLAN_BYTES, Mode, ORACLE_VERSION, Plan, Result, hash, invalid,
};
use std::collections::BTreeSet;
use zero_protocol::{
    is_sha256,
    sandbox::{SandboxBackend, SandboxRequest},
};
#[derive(Debug, Clone)]
pub struct FrozenPlan {
    plan: Plan,
    digest: String,
}
impl FrozenPlan {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_PLAN_BYTES {
            return Err(invalid("plan byte bound"));
        }
        Self::new(serde_json::from_slice(bytes)?)
    }
    pub fn new(plan: Plan) -> Result<Self> {
        // Bound typed callers before cloning request/snapshot fields as well.
        let digest = hash(&plan, MAX_PLAN_BYTES)?;
        validate(&plan)?;
        Ok(Self { plan, digest })
    }
    pub fn plan(&self) -> &Plan {
        &self.plan
    }
    pub fn digest(&self) -> &str {
        &self.digest
    }
    /// Derive an execution plan at a new location without changing source or
    /// observation authority. This pure operation does not inspect filesystem
    /// contents: the caller must independently verify reconstructed source bytes
    /// and retain the original-to-execution plan binding before dispatch.
    pub fn reanchor_snapshot(&self, staged: &zero_protocol::SnapshotPin) -> Result<Self> {
        // Bound typed inputs before allocating comparison bytes or cloning paths.
        hash(staged, MAX_PLAN_BYTES)?;
        if staged.digest != self.plan.snapshot.digest
            || serde_json::to_vec(&staged.files)? != serde_json::to_vec(&self.plan.snapshot.files)?
        {
            return Err(invalid("reanchored snapshot content identity differs"));
        }
        let mut plan = self.plan.clone();
        // The staging pin's generated ID is not the original source identity.
        plan.snapshot.root = staged.root.clone();
        Self::new(plan)
    }

    /// Check a retained relocation without accessing either filesystem path.
    /// Every field except the snapshot root must remain exactly unchanged.
    pub fn validate_reanchored(&self, execution: &Self) -> Result<()> {
        let expected = self.reanchor_snapshot(&execution.plan.snapshot)?;
        if serde_json::to_vec(expected.plan())? != serde_json::to_vec(execution.plan())? {
            return Err(invalid("execution plan differs from the frozen relocation"));
        }
        Ok(())
    }

    pub fn request(
        &self,
        case_id: &str,
        repeat: usize,
        execution_id: &str,
    ) -> Result<SandboxRequest> {
        if repeat >= self.plan.repeats {
            return Err(invalid("repeat outside frozen plan"));
        }
        let case = self
            .plan
            .cases
            .iter()
            .find(|c| c.id == case_id)
            .ok_or_else(|| invalid("case outside frozen plan"))?;
        let request = request(&self.plan, case, execution_id);
        request.validate().map_err(|e| invalid(&e.to_string()))?;
        Ok(request)
    }
}
fn request(plan: &Plan, case: &Case, execution_id: &str) -> SandboxRequest {
    SandboxRequest {
        execution_id: execution_id.into(),
        backend: plan.backend.clone(),
        snapshot: plan.snapshot.clone(),
        argv: case.argv.clone(),
        build_argv: None,
        stdin: case.stdin.clone(),
        timeout_ms: plan.limits.timeout_ms,
        memory_mb: plan.limits.memory_mb,
        cpus: plan.limits.cpus,
        max_output_bytes: plan.limits.max_output_bytes,
    }
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
fn validate(plan: &Plan) -> Result<()> {
    if plan.snapshot.files.len() > 4096 {
        return Err(invalid("snapshot index bound"));
    }
    let manifest: Vec<_> = plan
        .snapshot
        .files
        .iter()
        .map(|f| serde_json::json!({"bytes":f.bytes,"digest":f.digest,"path":f.path}))
        .collect();
    if hash(&manifest, MAX_PLAN_BYTES)? != plan.snapshot.digest {
        return Err(invalid("snapshot manifest digest mismatch"));
    }

    if plan.schema_version != 1
        || plan.oracle_version != ORACLE_VERSION
        || !(id(&plan.hypothesis_id) || is_sha256(&plan.hypothesis_id))
        || !is_sha256(&plan.source_bundle_digest)
        || !(2..=8).contains(&plan.repeats)
        || !(2..=32).contains(&plan.cases.len())
        || plan.limits.timeout_ms > 60_000
        || !(256..=64 * 1024).contains(&plan.limits.max_output_bytes)
    {
        return Err(invalid("plan version, identities or limits"));
    }
    match &plan.backend {
        SandboxBackend::Docker { image } if is_sha256(image) => {}
        SandboxBackend::Smolvm { archive_digest, .. } if is_sha256(archive_digest) => {}
        _ => return Err(invalid("immutable local backend identity required")),
    }
    let mut ids = BTreeSet::new();
    let mut inputs = BTreeSet::new();
    let mut modes = [false; 2];
    let mut decoded = 0usize;
    let mut worst_evidence = 0usize;
    for case in &plan.cases {
        if !id(&case.id)
            || !ids.insert(&case.id)
            || !inputs.insert(serde_json::to_vec(&(&case.argv, &case.stdin))?)
        {
            return Err(invalid("case IDs and command/input pairs must be distinct"));
        }
        modes[if case.mode == Mode::Attack { 0 } else { 1 }] = true;
        if let Some(safe) = &case.safe_expected {
            if case.mode != Mode::Attack || safe == &case.expected {
                return Err(invalid("safe expectation is distinct and attack-only"));
            }
        }
        for output in std::iter::once(&case.expected).chain(case.safe_expected.as_ref()) {
            if !(0..=255).contains(&output.exit_code)
                || output.stdout.len() > plan.limits.max_output_bytes
                || output.stderr.len() > plan.limits.max_output_bytes
            {
                return Err(invalid(
                    "expected output exceeds observable exit/stream bounds",
                ));
            }
            decoded = decoded
                .saturating_add(output.stdout.len())
                .saturating_add(output.stderr.len());
        }
        decoded = decoded.saturating_add(case.stdin.as_ref().map_or(0, String::len));
        if decoded > MAX_PLAN_BYTES {
            return Err(invalid("decoded expected/stdin byte bound"));
        }
        let req = request(plan, case, &"e".repeat(128));
        req.validate().map_err(|e| invalid(&e.to_string()))?;
        // Base64 streams plus request repetitions and bounded result metadata.
        worst_evidence = worst_evidence.saturating_add(
            (serde_json::to_vec(&req)?.len() + plan.limits.max_output_bytes * 3 + 16 * 1024)
                * plan.repeats,
        );
    }
    if !modes.into_iter().all(|v| v) || worst_evidence > MAX_EVIDENCE_BYTES {
        return Err(invalid("attack/control matrix or aggregate evidence bound"));
    }
    Ok(())
}
