import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScanCostLedger, type NativeRuntime, type SourceFixResult, type WorkflowAssessmentContext } from "@0/core";
import type { Finding, SecurityWorkflowInput, VerificationResult } from "@0/shared";
import { createFindingCandidateStore, createFindingWorkflowExecutors, validateFindingWorkflowInputs, type FindingWorkflowDependencies } from "./finding-workflow-executors.js";

const finding: Finding = { id: "finding-one", templateId: "manual", title: "Input validation", description: "Missing input check", severity: "high", category: "missing-validation", status: "confirmed", timestamp: 1,
  evidence: { request: "src/a.js:1", response: "", analysis: "" } };
const runtime: NativeRuntime = { type: "api", isAvailable: async () => false, executeNative: async () => ({ content: [], stopReason: "end_turn", durationMs: 1 }) };
let workspace: string;
const plan = { goal: "unknown-vulnerabilities" as const, depth: "quick" as const, runCount: 1, executionMode: "sequential" as const, timeCapMs: 30_000, costCapUsd: 1 };
const candidate: SourceFixResult = { status: "validated_candidate", findingId: finding.id, attempts: [], applied: false, patch: "reviewable patch", diff: "reviewable diff" };
const verification = { status: "not_reproduced", finding_id: finding.id, evidence_artifacts: [], error_reason: null } as unknown as VerificationResult;
function deps(): FindingWorkflowDependencies {
  return { propose: vi.fn().mockResolvedValue(candidate), verifyCandidate: vi.fn().mockResolvedValue(candidate), applyCandidate: vi.fn().mockResolvedValue({ ...candidate, status: "applied_and_retested", applied: true }), replay: vi.fn().mockResolvedValue({ result: verification, exitCode: 1 }), finding: vi.fn().mockReturnValue({ finding, dbPath: "/db" }) };
}
function context(type: "fix" | "verify", inputs: Record<string, unknown> = {}): WorkflowAssessmentContext {
  return { node: { id: "step", type, label: "Step", enabled: true }, target: workspace, plan, signal: new AbortController().signal, deadline: Date.now() + 30_000, costLedger: new ScanCostLedger(), priorFindings: [], priorReports: [], inputs: { finding, ...inputs }, priorOutputs: [] };
}
function workflow(type: "fix" | "verify", inputs: Record<string, unknown> = {}): SecurityWorkflowInput {
  return { name: "Fixture", instructions: "", target: workspace, nodes: [{ id: "start", type: "trigger", enabled: true, label: "Start" }, { id: "step", type, enabled: true, label: "Step", inputs }], edges: [{ source: "start", target: "step" }] };
}
beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), "0-finding-executor-")); });
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

describe("finding workflow executors", () => {
  it("proposes a tested candidate without applying it, then re-verifies the original live proof", async () => {
    const dependencies = deps();
    const store = createFindingCandidateStore(vi.fn());
    const executors = createFindingWorkflowExecutors({ runtime, workspace, allowApply: false, candidateStore: store }, dependencies);
    const result = await executors.fix(context("fix", { testCommand: "npm test" }));
    expect(dependencies.propose).toHaveBeenCalledWith(expect.objectContaining({ finding, apply: false, keepWorktree: true, testCommand: "npm test" }));
    const id = (result.outputs![0]!.value as { candidateId: string }).candidateId;
    const verified = await executors.verify(context("verify", { candidateId: id }));
    expect(verified.outputs![0]!.kind).toBe("source-fix-verification");
    expect(dependencies.verifyCandidate).toHaveBeenCalledWith(candidate, expect.anything());
    await store.dispose();
  });

  it("does not treat a serialized candidate-shaped artifact as live proof", async () => {
    const dependencies = deps();
    const executors = createFindingWorkflowExecutors({ runtime, workspace, allowApply: true }, dependencies);
    const input = context("fix", { candidateId: "invented", applyApproval: { candidateId: "invented", approval: "apply-to-repository" } });
    input.node.fix = { mode: "apply" };
    input.priorOutputs = [{ nodeId: "earlier", outputs: [{ kind: "source-fix-candidate", value: { candidateId: "invented", ...candidate } }] }];
    await expect(executors.fix(input)).rejects.toThrow("exact process-owned live candidate");
    expect(dependencies.applyCandidate).not.toHaveBeenCalled();
  });

  it("shares live candidate proof across runs but requires exact separate application approval", async () => {
    const dependencies = deps();
    const store = createFindingCandidateStore(vi.fn());
    const first = createFindingWorkflowExecutors({ runtime, workspace, allowApply: false, candidateStore: store }, dependencies);
    const result = await first.fix(context("fix", { testCommand: "npm test" }));
    const id = (result.outputs![0]!.value as { candidateId: string }).candidateId;
    const second = createFindingWorkflowExecutors({ runtime, workspace, allowApply: true, candidateStore: store }, dependencies);
    const input = context("fix", { candidateId: id });
    input.node.fix = { mode: "apply" };
    await expect(second.fix(input)).rejects.toThrow("approval");
    input.inputs = { ...input.inputs, applyApproval: { candidateId: id, approval: "apply-to-repository" } };
    await second.fix(input);
    expect(dependencies.applyCandidate).toHaveBeenCalledWith(candidate, expect.objectContaining({ approval: "apply-to-repository" }));
    await store.dispose();
  });

  it("replays a finding using an explicit runner without requiring a model provider", async () => {
    const dependencies = deps();
    const executors = createFindingWorkflowExecutors({ runtime, workspace, allowApply: false }, dependencies);
    const result = await executors.verify(context("verify", { runner: "docker" }));
    expect(dependencies.replay).toHaveBeenCalledWith(expect.objectContaining({ runner: "docker", signal: expect.any(AbortSignal) }));
    expect(result.status).toBe("completed");
    expect(result.outputs![0]!.value).toBe(verification);
    expect(dependencies.propose).not.toHaveBeenCalled();
  });

  it("rejects missing commands, implicit runners, portable approvals, and outside-workspace files before execution", async () => {
    const options = { runtime, workspace, allowApply: false };
    await expect(validateFindingWorkflowInputs(workflow("fix"), { finding }, options)).rejects.toThrow("testCommand");
    await expect(validateFindingWorkflowInputs(workflow("verify"), { finding }, options)).rejects.toThrow("explicit");
    await expect(validateFindingWorkflowInputs(workflow("fix", { testCommand: "npm test", applyApproval: {} }), { finding }, options)).rejects.toThrow("never stored");
    const outside = await mkdtemp(join(tmpdir(), "0-outside-executor-"));
    try {
      const path = join(outside, "finding.json");
      await writeFile(path, JSON.stringify(finding));
      await expect(validateFindingWorkflowInputs(workflow("verify"), { findingPath: path, runner: "local" }, options)).rejects.toThrow("outside");
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("rejects portable database paths outside the workspace unless the host admitted that exact path", async () => {
    const outside = await mkdtemp(join(tmpdir(), "0-outside-db-"));
    const path = join(outside, "db.sqlite");
    await writeFile(path, "fixture");
    try {
      await expect(validateFindingWorkflowInputs(workflow("verify"), { findingId: finding.id, dbPath: path, runner: "local" }, { runtime, workspace, allowApply: false })).rejects.toThrow("outside");
      await validateFindingWorkflowInputs(workflow("verify"), { findingId: finding.id, dbPath: path, runner: "local" }, { runtime, workspace, dbPath: path, allowApply: false });
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("cleans a rejected newly generated candidate when the owning store is full", async () => {
    const cleanup = vi.fn(async () => {});
    const store = createFindingCandidateStore(cleanup);
    for (let index = 0; index < 32; index++) await store.put(`candidate-${index}`, {
      ...candidate, candidate: { repoRoot: workspace, worktree: `/tmp/candidate-${index}`, baseCommit: "head", recordPath: "record" },
    }, workspace);
    await expect(store.put("overflow", { ...candidate,
      candidate: { repoRoot: workspace, worktree: "/tmp/rejected-candidate", baseCommit: "head", recordPath: "record" },
    }, workspace)).rejects.toThrow("retention");
    expect(cleanup).toHaveBeenCalledWith(workspace, "/tmp/rejected-candidate");
    await store.dispose();
    expect(cleanup).toHaveBeenCalledTimes(33);
    expect(store.get("candidate-0")).toBeUndefined();
  });

});
