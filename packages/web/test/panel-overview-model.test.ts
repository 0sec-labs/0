import { describe, expect, it } from "vitest";
import { costBreakdown, newestFindings, planSummary, scopeSummary, severityCounts, statusSummary, workerCounts, workerCountsLine, contextUsage, formatCost } from "../src/console/panel/views/overview-model";

const worker = (id: string, status: string, extra: object = {}) => ({ id, parentId: "p", name: `Agent ${id}`, status, task: "t", transcript: [], ...extra });
const snap = (over: Record<string, unknown> = {}) => ({
  session: { id: "s", status: "ready", target: "https://x.test" },
  pendingDecisions: [], workers: [], scope: null, scopeEnforcement: { enabled: false, message: "", pluginId: "", projectPath: "" },
  usage: { inputTokens: 1000, outputTokens: 50, costUsd: 1, costKind: "estimated" }, runtime: null, queuedMessages: [], tools: [], ...over,
}) as never;
const group = (fingerprint: string, severity: string, timestamp: number) => ({ fingerprint, latest: { severity, timestamp, title: fingerprint } }) as never;

describe("overview model", () => {
  it("maps status", () => {
    expect(statusSummary(snap()).label).toBe("Ready");
    expect(statusSummary(snap({ session: { id: "s", status: "working" } })).tone).toBe("active");
    expect(statusSummary(snap({ session: { id: "s", status: "working" }, pendingDecisions: [{}] })).label).toBe("Waiting for you");
    expect(statusSummary(snap({ session: { id: "s", status: "cancelling" } })).label).toBe("Stopping");
    expect(statusSummary(snap({ session: { id: "s", status: "failed" } })).tone).toBe("danger");
  });
  it("computes context and cost formatting", () => {
    expect(contextUsage(snap({ contextInputTokens: 250, contextWindowTokens: 1000 })).percent).toBe(25);
    expect(contextUsage(snap()).percent).toBeUndefined();
    expect(formatCost(0.456)).toBe("$0.46");
    expect(formatCost(undefined)).toBeUndefined();
  });
  it("summarises scope", () => {
    const summary = scopeSummary(snap({ scope: { in_scope: ["a", "b"], out_of_scope: ["c"] }, scopeEnforcement: { enabled: true, message: "m", pluginId: "", projectPath: "" } }));
    expect(summary).toMatchObject({ inCount: 2, outCount: 1, enforcement: "enforced", enforcementMessage: "m", target: "https://x.test" });
  });
  it("counts severities and orders newest", () => {
    const groups = [group("a", "High", 1), group("b", "critical", 3), group("c", "weird", 2), group("d", "high", 4)];
    expect(severityCounts(groups)).toEqual({ critical: 1, high: 2, medium: 0, low: 0, info: 1 });
    expect(newestFindings(groups, 2).map(g => g.fingerprint)).toEqual(["d", "b"]);
  });
  it("counts workers", () => {
    const counts = workerCounts([worker("1", "running"), worker("2", "queued"), worker("3", "completed"), worker("4", "failed"), worker("5", "failed", { error: "Turn cancelled by operator" })] as never);
    expect(counts).toEqual({ total: 5, running: 1, waiting: 1, completed: 1, failed: 1, stopped: 1 });
    expect(workerCountsLine(counts)).toBe("1 running, 1 waiting, 1 complete, 1 need attention, 1 stopped");
  });
  it("summarises plan", () => {
    expect(planSummary(snap())).toBeUndefined();
    const todos = { todos: [{ id: "1", content: "x", status: "pending" }], done: 0, total: 1, line: "", revision: 1 };
    expect(planSummary(snap({ todos }))).toEqual({ done: 0, total: 1, active: false, stale: true });
  });
  it("builds a cost breakdown only from real fields", () => {
    expect(costBreakdown(snap({ usage: { inputTokens: 0, outputTokens: 0 } }))).toBeUndefined();
    const plain = costBreakdown(snap({ workers: [worker("1", "running")] }))!;
    expect(plain.rows).toHaveLength(1);
    expect(plain.workersUnattributed).toBe(1);
    const split = costBreakdown(snap({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 1 }, workers: [worker("1", "running", { telemetry: { costUsd: 0.25 } }), worker("2", "running", { telemetry: { costUsd: "x" } })] }))!;
    expect(split.rows.map(r => [r.id, r.costUsd])).toEqual([["chat", 0.75], ["1", 0.25]]);
    expect(split.rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1);
    expect(split.workersUnattributed).toBe(1);
  });
});
