import { describe, expect, it, vi } from "vitest";
import type { ScanReport } from "@0/shared";
import { executeAssessment, executeAssessmentRun, type AssessmentDependencies, type AssessmentOptions } from "./assessment.js";

vi.mock("./agentic-scanner.js", () => ({ agenticScan: vi.fn() }));
vi.mock("./unified-pipeline.js", () => ({ runPipeline: vi.fn() }));
vi.mock("./agent/journal/index.js", () => ({ branchJournal: vi.fn() }));

const report: ScanReport = {
  target: "https://example.com", scanDepth: "quick", startedAt: "2026-09-30", completedAt: "2026-09-30",
  durationMs: 1, warnings: [], findings: [],
  summary: { totalAttacks: 0, totalFindings: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
};
function dependencies(): AssessmentDependencies {
  return {
    agenticScan: vi.fn().mockResolvedValue(report),
    runPipeline: vi.fn().mockResolvedValue({ ...report, targetType: "source-code", repo: "/repo" }),
    branchJournal: vi.fn().mockReturnValue({ newRunId: "branch" }),
  };
}
const options: AssessmentOptions = {
  target: "/repo", targetType: "source-code", depth: "quick", format: "json", runtime: "api", timeout: 10_000,
};

describe("executeAssessment", () => {
  it("runs source assessment and returns both canonical and target-specific reports", async () => {
    const deps = dependencies();
    const result = await executeAssessment({ ...options, hypothesis: "authorization", reviewProfile: "linux-kernel" }, deps);
    expect(deps.runPipeline).toHaveBeenCalledWith(expect.objectContaining({ hypothesis: "authorization", reviewProfile: "linux-kernel" }));
    expect(deps.agenticScan).not.toHaveBeenCalled();
    expect(result.report.target).toBe("/repo");
    expect(result.rawReport).toHaveProperty("targetType", "source-code");
  });

  it("preserves live-target controls and run identity in scanner dispatch", async () => {
    const deps = dependencies();
    const signal = new AbortController().signal;
    const onEvent = vi.fn();
    await executeAssessment({ ...options, target: report.target, targetType: "url", runId: "step-1", signal, onEvent,
      rateLimit: "5", httpAuditAllowedHosts: ["example.com"], attributionHeaders: ["X-Research=0"] }, deps);
    expect(deps.agenticScan).toHaveBeenCalledWith(expect.objectContaining({
      runId: "step-1", onEvent,
      config: expect.objectContaining({ mode: "deep", signal, rateLimit: "5", httpAuditAllowedHosts: ["example.com"], attributionHeaders: ["X-Research=0"] }),
    }));
  });

  it("narrows execution limits to the plan and preserves the shared ledger", async () => {
    const deps = dependencies();
    const plan: NonNullable<AssessmentOptions["plan"]> = {
      goal: "unknown-vulnerabilities", depth: "quick", runCount: 1,
      executionMode: "sequential", costCapUsd: 2, timeCapMs: 5_000,
    };
    await executeAssessment({ ...options, plan, costCeilingUsd: 1 }, deps);
    expect(deps.runPipeline).toHaveBeenCalledWith(expect.objectContaining({ timeout: 5_000, costCeilingUsd: 1, depth: "quick" }));
  });

  it("rejects cancelled work before dispatch and requires a journal to branch", async () => {
    const deps = dependencies();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(executeAssessment({ ...options, signal: controller.signal }, deps)).rejects.toThrow("cancelled");
    await expect(executeAssessment({ ...options, branchFromEntry: 1 }, deps)).rejects.toThrow("requires --resume");
    expect(deps.runPipeline).not.toHaveBeenCalled();
  });

  it("branches before dispatch without printing or exiting the host", async () => {
    const deps = dependencies();
    await executeAssessment({ ...options, resumeScanId: "original", branchFromEntry: 3 }, deps);
    expect(deps.branchJournal).toHaveBeenCalledWith({ runId: "original", fromEntry: 3 });
    expect(deps.runPipeline).toHaveBeenCalledWith(expect.objectContaining({ resumeScanId: "branch" }));
  });

  it("manages a CLI shortcut as one workflow step without forcing guided-plan dispatch", async () => {
    const deps = dependencies();
    vi.mocked(deps.runPipeline).mockResolvedValue({ ...report, targetType: "source-code", repo: "/repo",
      summary: { ...report.summary, high: 1, totalFindings: 1 } });
    const result = await executeAssessmentRun(options, deps);
    expect(deps.runPipeline).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.runPipeline).mock.calls[0]![0].plan).toBeUndefined();
    expect(result.report.summary.high).toBe(1);
    expect(result.report.executionSuccessful).not.toBe(false);
  });

  it("returns partial reports when execution failed, preserving the execution verdict", async () => {
    const deps = dependencies();
    vi.mocked(deps.runPipeline).mockResolvedValue({ ...report, targetType: "source-code", repo: "/repo",
      researchFailed: true, error: "provider unavailable" });
    const result = await executeAssessmentRun(options, deps);
    expect(result.report.executionSuccessful).toBe(false);
    expect(result.report.error).toBe("provider unavailable");
  });


  it("preserves a legacy assessment timeout longer than the default workflow step", async () => {
    const deps = dependencies();
    await executeAssessmentRun({ ...options, timeout: 1_800_000 }, deps);
    const dispatched = vi.mocked(deps.runPipeline).mock.calls[0]![0];
    expect(dispatched.timeout).toBeGreaterThan(1_700_000);
    expect(dispatched.timeout).toBeLessThanOrEqual(1_800_000);
    expect(dispatched.plan).toBeUndefined();
  });

});
