import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SECURITY_WORKFLOW_PLAN } from "@0/shared";
import { ScanCostLedger, type NativeRuntime, type WorkflowAssessmentContext } from "@0/core";
const mocks = vi.hoisted(() => ({ research: vi.fn(), deep: vi.fn() }));
vi.mock("@0/core", async importOriginal => ({ ...await importOriginal<typeof import("@0/core")>(), runResearch: mocks.research }));
vi.mock("./commands/deep-review.js", () => ({ runDeepReview: mocks.deep }));
import { createResearchWorkflowExecutors, validateResearchWorkflowInputs } from "./workflow-research-executors.js";
const roots: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), "zero-research-workflow-")); roots.push(root); return root; }
const runtime: NativeRuntime = { type: "api", executeNative: vi.fn(), isAvailable: async () => true, resolvedModel: () => "bound-model" };
function context(target: string, inputs: Record<string, unknown> = {}, type: "research" | "deep-review" = "research"): WorkflowAssessmentContext {
  return { node: { id: "research", type, label: "Research", enabled: true }, target, inputs, signal: new AbortController().signal, deadline: Date.now() + 60_000,
    costLedger: new ScanCostLedger(), plan: { ...DEFAULT_SECURITY_WORKFLOW_PLAN }, priorReports: [], priorFindings: [], priorOutputs: [] };
}
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe("research workflow executors", () => {
  it("keeps mobile hypotheses as outputs without fabricating findings", async () => {
    const root = await fixture();
    mocks.research.mockResolvedValue({ completed: true, findings: [], candidates: [{ id: "passive-indicator" }], warnings: [], envelopePath: join(root, "envelopes.json") });
    const ctx = context(root, { engine: "mobile" });
    const result = await createResearchWorkflowExecutors({ runtime, workspace: root }).research!(ctx);
    expect(result.status).toBe("completed");
    expect(result.reports?.[0].findings).toEqual([]);
    expect(result.outputs?.[0].value).toMatchObject({ candidates: [{ id: "passive-indicator" }] });
    expect(mocks.research.mock.calls[0][2]).toMatchObject({ signal: ctx.signal, artifactRoot: join(await realpath(root), ".0/workflow-artifacts") });
  });
  it("rejects escaping and symlinked artifact roots before engine execution", async () => {
    const root = await fixture(); const outside = await fixture();
    await symlink(outside, join(root, "escape"));
    await expect(validateResearchWorkflowInputs("research", { artifactRoot: "../outside" }, { workspace: root })).rejects.toThrow("outside");
    await expect(createResearchWorkflowExecutors({ runtime, workspace: root }).research!(context(root, { engine: "mobile", artifactRoot: "escape/new" }))).rejects.toThrow("outside");
    expect(mocks.research).not.toHaveBeenCalled();
  });
  it("fails closed for live kernel research whose VM cannot cancel", async () => {
    await expect(validateResearchWorkflowInputs("research", { engine: "linux" })).rejects.toThrow("cancellation");
  });
  it("threads bound runtime, cancellation and shared ledger into deep review without promoting leads", async () => {
    const root = await fixture();
    const ctx = context(root, { models: ["bound-model"] }, "deep-review");
    const result = { exitCode: 0, result: { leads: [{ status: "discovered" }] } };
    mocks.deep.mockResolvedValue(result);
    const executed = await createResearchWorkflowExecutors({ runtime, workspace: root })["deep-review"];
    const outcome = await executed!(ctx);
    expect(outcome).toMatchObject({ status: "completed", outputs: [{ kind: "deep-review", value: result }] });
    expect(mocks.deep.mock.calls[0][0]).toMatchObject({ nativeRuntime: expect.any(Object), signal: ctx.signal, costLedger: ctx.costLedger, costCeilingUsd: ctx.plan.costCapUsd });
    await expect(executed!(context(root, { models: ["different-account-model"] }, "deep-review"))).rejects.toThrow("bound model");
  });
  it("records a billed deep-review response once when the engine attributes spend to a child ledger", async () => {
    const root = await fixture(); const ctx = context(root, {}, "deep-review");
    const usage = { inputTokens: 1000, outputTokens: 100 };
    const bound: NativeRuntime = { type: "api", isAvailable: async () => true, resolvedModel: () => "gpt-6.1-sol", executeNative: async () => ({ content: [{ type: "text", text: "result" }], stopReason: "end_turn", durationMs: 1, usage }) };
    mocks.deep.mockImplementation(async (options: { nativeRuntime: NativeRuntime; costLedger: ScanCostLedger }) => {
      const child = options.costLedger.fork();
      const response = await options.nativeRuntime.executeNative("", [], []);
      child.add(response.usage!, "gpt-6.1-sol");
      return { exitCode: 0, result: {} };
    });
    await createResearchWorkflowExecutors({ runtime: bound, workspace: root })["deep-review"]!(ctx);
    const expected = new ScanCostLedger(); expected.add(usage, "gpt-6.1-sol");
    expect(ctx.costLedger.totalCostUsd()).toBe(expected.totalCostUsd());
  });

  it("honors cancellation before creating artifacts or invoking an engine", async () => {
    const root = await fixture(); const abort = new AbortController(); abort.abort(new Error("stop"));
    const ctx = { ...context(root), signal: abort.signal };
    await expect(createResearchWorkflowExecutors({ runtime, workspace: root }).research!(ctx)).rejects.toThrow("stop");
    expect(mocks.research).not.toHaveBeenCalled();
  });
});
