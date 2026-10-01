import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  runSourceFix, verifySourceFixCandidate, applySourceFixCandidate,
  workflowPolicyRuntime, budgetNativeRuntime,
  type NativeRuntime, type SourceFixResult, type WorkflowAssessmentContext,
  type WorkflowStepExecutor,
} from "@0/core";
import { findingSchema, type Finding, type SecurityWorkflowInput } from "@0/shared";
import { loadFindingFocus } from "./finding-focus.js";
import { runDeterministicReplayCli } from "./commands/verify.js";

export interface FindingWorkflowOptions {
  runtime: NativeRuntime;
  workspace: string;
  dbPath?: string;
  scopeFile?: string;
  runner?: "local" | "smolvm" | "docker" | "qemu";
  /** Host authorization, separate from every portable definition and template. */
  allowApply: boolean;
  onProgress?: (event: unknown) => void;
  candidateStore?: FindingCandidateStore;
}
export interface FindingWorkflowDependencies {
  propose: typeof runSourceFix;
  verifyCandidate: typeof verifySourceFixCandidate;
  applyCandidate: typeof applySourceFixCandidate;
  replay: typeof runDeterministicReplayCli;
  finding: typeof loadFindingFocus;
}
const defaults: FindingWorkflowDependencies = {
  propose: runSourceFix, verifyCandidate: verifySourceFixCandidate,
  applyCandidate: applySourceFixCandidate, replay: runDeterministicReplayCli, finding: loadFindingFocus,
};
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
function positive(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}
function runner(inputs: Readonly<Record<string, unknown>>, options: FindingWorkflowOptions) {
  const selected = text(inputs.runner) ?? options.runner;
  if (selected !== "local" && selected !== "smolvm" && selected !== "docker" && selected !== "qemu") throw new Error("Verification requires an explicit local, smolvm, docker, or qemu runner.");
  return selected;
}
async function authorizedPath(path: string, options: FindingWorkflowOptions, explicitlyAllowed?: string): Promise<string> {
  const resolved = await realpath(resolve(path));
  if (explicitlyAllowed && resolved === await realpath(resolve(explicitlyAllowed))) return resolved;
  const root = await realpath(options.workspace);
  const suffix = relative(root, resolved);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) throw new Error("Workflow input is outside the authorized workspace.");
  return resolved;
}
function hasFindingInput(inputs: Readonly<Record<string, unknown>>) {
  return !!(inputs.finding || text(inputs.findingPath) || text(inputs.findingId) || text(inputs.fromStep));
}

/** Validate portable prerequisites and canonical path boundaries before allocating a run. */
export async function validateFindingWorkflowInputs(
  workflow: SecurityWorkflowInput,
  runInputs: Readonly<Record<string, unknown>>,
  options: FindingWorkflowOptions,
): Promise<void> {
  for (const node of workflow.nodes.filter(node => node.enabled && (node.type === "fix" || node.type === "verify"))) {
    const inputs: Record<string, unknown> = { ...runInputs, ...node.inputs, ...node.input };
    if (node.inputs?.applyApproval !== undefined || node.inputs?.allowApply === true) throw new Error("Application approval must be supplied by the host and current run, never stored in a workflow.");
    if (node.type === "fix") {
      await authorizedPath(workflow.target, options);
      if (node.fix?.mode === "apply") {
        if (!options.allowApply) throw new Error("This host has not authorized repository application.");
        const approval = runInputs.applyApproval as { candidateId?: unknown; approval?: unknown } | undefined;
        if (!text(approval?.candidateId) || approval?.approval !== "apply-to-repository") throw new Error("Repository application requires approval of an exact live candidate.");
      } else if (!text(inputs.testCommand)) throw new Error("Source fix requires an explicit regression testCommand.");
    }
    if (!hasFindingInput(inputs) && !text(inputs.candidateId) && !text(inputs.artifactId)) throw new Error("A finding input or connected candidate artifact is required.");
    const sourceStep = workflow.nodes.find(step => step.id === text(inputs.fromStep));
    if (node.type === "verify" && !text(inputs.candidateId) && !text(inputs.artifactId) && sourceStep?.type !== "fix") runner(inputs, options);
    if (text(inputs.findingId) && !inputs.finding && !text(inputs.findingPath) && !text(inputs.fromStep) && !text(inputs.dbPath) && !options.dbPath) throw new Error("Persisted finding lookup requires an explicitly admitted database path.");
    if (inputs.finding) findingSchema.parse(inputs.finding);
    if (text(inputs.findingPath)) findingSchema.parse(JSON.parse(await readFile(await authorizedPath(text(inputs.findingPath)!, options), "utf8")));
    if (text(inputs.dbPath)) await authorizedPath(text(inputs.dbPath)!, options, options.dbPath);
    if (text(inputs.scopeFile)) await authorizedPath(text(inputs.scopeFile)!, options, options.scopeFile);
    positive(inputs.testTimeoutMs, 300_000, "testTimeoutMs");
    positive(inputs.maxAttempts, 3, "maxAttempts");
    for (const key of ["qemuBinary", "qemuKernel", "qemuBusybox"]) if (text(inputs[key])) await authorizedPath(text(inputs[key])!, options);
  }
}

export interface FindingCandidateStore {
  get(id: string): { result: SourceFixResult; repoRoot: string } | undefined;
  put(id: string, result: SourceFixResult, repoRoot: string): Promise<void>;
  dispose(): Promise<void>;
}
/** Share within one owning host; closing it removes only its generated candidate worktrees. */
export function createFindingCandidateStore(
  cleanup: (repoRoot: string, worktree: string) => Promise<void> = async (repoRoot, worktree) => {
    await promisify(execFile)("git", ["-C", repoRoot, "worktree", "remove", "--force", worktree]);
  },
): FindingCandidateStore {
  const live = new Map<string, { result: SourceFixResult; repoRoot: string; worktree?: string }>();
  let disposed = false;
  return {
    get: id => disposed ? undefined : live.get(id),
    async put(id, result, repoRoot) {
      if (disposed || live.size >= 32) {
        if (result.candidate?.worktree) await cleanup(repoRoot, result.candidate.worktree);
        throw new Error("Live candidate retention is unavailable; dispose completed candidate worktrees first.");
      }
      live.set(id, { result, repoRoot, worktree: result.candidate?.worktree });
    },
    async dispose() {
      disposed = true;
      const errors: string[] = [];
      for (const [id, candidate] of live) {
        if (candidate.worktree) {
          try { await cleanup(candidate.repoRoot, candidate.worktree); }
          catch (error) { errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
        }
      }
      live.clear();
      if (errors.length) throw new Error(`Candidate cleanup failed: ${errors.join("; ")}`);
    },
  };
}

/** Live candidates remain process-owned; serialized output IDs cannot reconstruct engine proof. */
export function createFindingWorkflowExecutors(options: FindingWorkflowOptions, dependencies: FindingWorkflowDependencies = defaults): { fix: WorkflowStepExecutor; verify: WorkflowStepExecutor } {
  const candidates = options.candidateStore ?? createFindingCandidateStore();
  const connectedCandidate = (context: WorkflowAssessmentContext): string | undefined => {
    const explicit = text(context.inputs.candidateId) ?? text(context.inputs.artifactId);
    const refs = context.priorOutputs.flatMap(output => output.outputs).filter(output => (output.kind === "source-fix-candidate" || output.kind === "source-fix-verification"))
      .map(output => text((output.value as { candidateId?: unknown })?.candidateId)).filter((id): id is string => !!id);
    if (explicit) {
      if (!refs.includes(explicit) && !candidates.get(explicit)) throw new Error("Candidate must belong to a connected predecessor or this owning live host.");
      return explicit;
    }
    return refs.length === 1 ? refs[0] : undefined;
  };
  const finding = async (context: WorkflowAssessmentContext): Promise<Finding> => {
    const inputs = context.inputs;
    const findingId = text(inputs.findingId);
    let result: Finding;
    if (inputs.finding) result = findingSchema.parse(inputs.finding) as Finding;
    else if (text(inputs.findingPath)) result = findingSchema.parse(JSON.parse(await readFile(await authorizedPath(text(inputs.findingPath)!, options), "utf8"))) as Finding;
    else {
      const prior = context.priorReports.flatMap(report => report.findings).filter(value => !findingId || value.id === findingId);
      if (prior.length === 1) result = findingSchema.parse(prior[0]) as Finding;
      else if (findingId && !text(inputs.fromStep)) {
        const path = text(inputs.dbPath);
        const dbPath = path ? await authorizedPath(path, options, options.dbPath) : options.dbPath;
        if (!dbPath) throw new Error("Persisted finding lookup requires an explicitly admitted database path.");
        result = dependencies.finding(findingId, { dbPath }).finding;
      } else throw new Error("Select exactly one finding from connected assessment results.");
    }
    if (findingId && result.id !== findingId) throw new Error("Finding input identity does not match the selected finding.");
    const verification = context.priorOutputs.flatMap(output => output.outputs).find(output => output.kind === "verification-result" && (output.value as { finding_id?: unknown })?.finding_id === result.id);
    return verification ? { ...result, verification_result: verification.value } as Finding : result;
  };
  const candidateOutput = (id: string, result: SourceFixResult) => ({ kind: "source-fix-candidate", value: {
    candidateId: id, findingId: result.findingId, status: result.status, patch: result.patch, diff: result.diff,
    sourceFile: result.sourceFile, test: result.test, applied: result.applied,
  }, artifactRefs: [id] });
  return {
    fix: async context => {
      context.signal.throwIfAborted();
      const repoRoot = await authorizedPath(context.target, options);
      if (context.node.fix?.mode === "apply") {
        if (!options.allowApply || context.node.inputs?.applyApproval !== undefined) throw new Error("Repository application is not authorized by this host.");
        const id = connectedCandidate(context);
        const live = id ? candidates.get(id) : undefined;
        const approval = context.inputs.applyApproval as { candidateId?: unknown; approval?: unknown } | undefined;
        if (!live || live.repoRoot !== repoRoot || approval?.candidateId !== id || approval?.approval !== "apply-to-repository") throw new Error("Application requires approval of the exact process-owned live candidate.");
        const result = await dependencies.applyCandidate(live.result, { approval: "apply-to-repository", signal: context.signal });
        return { status: result.status === "applied_and_retested" ? "completed" : "failed", outputs: [candidateOutput(id!, result)], ...(result.error ? { error: result.error } : {}) };
      }
      const testCommand = text(context.inputs.testCommand);
      if (!testCommand) throw new Error("Source fix requires an explicit regression testCommand.");
      const runtime = workflowPolicyRuntime(budgetNativeRuntime(options.runtime, context.costLedger, context.signal, context.plan.costCapUsd, context.plan));
      const result = await dependencies.propose({ repoRoot, finding: await finding(context), runtime, testCommand,
        apply: false, keepWorktree: true, signal: context.signal, onProgress: options.onProgress,
        maxAttempts: positive(context.inputs.maxAttempts, 3, "maxAttempts"),
        testTimeoutMs: Math.min(positive(context.inputs.testTimeoutMs, 300_000, "testTimeoutMs"), Math.max(1, context.deadline - Date.now())),
      });
      const id = randomUUID();
      if (result.status === "validated_candidate") await candidates.put(id, result, repoRoot);
      return { status: result.status === "error" || result.status === "precondition_failed" ? "failed" : "completed",
        outputs: [{ ...candidateOutput(id, result), kind: result.status === "validated_candidate" ? "source-fix-candidate" : "source-fix-result" }], ...(result.error ? { error: result.error } : {}) };
    },
    verify: async context => {
      context.signal.throwIfAborted();
      const id = connectedCandidate(context);
      if (id) {
        const live = candidates.get(id);
        if (!live || live.repoRoot !== await authorizedPath(context.target, options)) throw new Error("Verification requires a process-owned live candidate in this repository.");
        const result = await dependencies.verifyCandidate(live.result, { signal: context.signal,
          testTimeoutMs: Math.min(positive(context.inputs.testTimeoutMs, 300_000, "testTimeoutMs"), Math.max(1, context.deadline - Date.now())) });
        return { status: "completed", outputs: [{ kind: "source-fix-verification", value: { ...candidateOutput(id, result).value, error: result.error, precondition: result.precondition, postcondition: result.postcondition } }] };
      }
      if (context.priorOutputs.some(output => output.outputs.some(value => value.kind === "source-fix-result"))) throw new Error("The connected source-fix step did not produce a validated live candidate.");
      const selected = await finding(context);
      const directory = await mkdtemp(join(tmpdir(), "0-workflow-finding-"));
      try {
        const findingPath = join(directory, "finding.json");
        await writeFile(findingPath, JSON.stringify(selected));
        const scopeFile = text(context.inputs.scopeFile);
        const replay = await dependencies.replay({ findingPath, runner: runner(context.inputs, options), signal: context.signal,
          scopeFile: scopeFile ? await authorizedPath(scopeFile, options, options.scopeFile) : options.scopeFile,
          dockerNetwork: text(context.inputs.dockerNetwork),
          qemuBinary: text(context.inputs.qemuBinary) ? await authorizedPath(text(context.inputs.qemuBinary)!, options) : undefined,
          qemuKernel: text(context.inputs.qemuKernel) ? await authorizedPath(text(context.inputs.qemuKernel)!, options) : undefined,
          qemuBusybox: text(context.inputs.qemuBusybox) ? await authorizedPath(text(context.inputs.qemuBusybox)!, options) : undefined,
        });
        return { status: replay.result.status === "error" ? "failed" : "completed",
          outputs: [{ kind: "verification-result", value: replay.result,
            artifactRefs: replay.result.evidence_artifacts.map(artifact => artifact.path) }],
          ...(replay.result.error_reason ? { error: replay.result.error_reason } : {}) };
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}
