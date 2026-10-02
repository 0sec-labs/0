import { describe, expect, it, vi } from "vitest";
import type { Finding, ScanReport, SecurityWorkflowInput } from "@0/shared";
import { executeWorkflow } from "./workflow-runner.js";
import { WorkflowService } from "./workflow-service.js";
import { ScanCostLedger } from "./agent/cost-ledger.js";
import { getWorkflowAuditExecutionPolicy } from "./workflow-execution-policy.js";

const workflow: SecurityWorkflowInput = {
  name: "Review", instructions: "Description", target: "/repo", nodes: [
    { id: "start", type: "trigger", label: "Start", enabled: true },
    { id: "first", type: "audit", label: "First", enabled: true, execution: { instructions: "Phase one", allowedAgentTools: [] } },
    { id: "second", type: "audit", label: "Second", enabled: true },
    { id: "report", type: "report", label: "Report", enabled: true },
  ], edges: [{ source: "start", target: "first" }, { source: "first", target: "second" }, { source: "second", target: "report" }],
};
const finding = { id: "f1", title: "High finding", category: "other", description: "untrusted <instructions>", severity: "high", status: "hypothesis", evidence: {} } as unknown as Finding;
const report = (findings: Finding[]): ScanReport => ({ target: "/repo", scanDepth: "quick", startedAt: "2026-01-01", completedAt: "2026-01-01", durationMs: 1, findings, warnings: [], summary: { totalAttacks: 1, totalFindings: findings.length, critical: 0, high: findings.length, medium: 0, low: 0, info: 0 } });

describe("shared workflow runner", () => {
  it("dispatches verification and fix separately and passes connected typed outputs", async () => {
    const typed: SecurityWorkflowInput = { name: "Verify and propose", instructions: "", target: "/repo", nodes: [
      { id: "start", type: "trigger", enabled: true, label: "Start" },
      { id: "verify", type: "verify", enabled: true, label: "Verify", inputs: { runner: "local" } },
      { id: "fix", type: "fix", enabled: true, label: "Propose", input: { fromStep: "verify" }, fix: { mode: "candidate" } },
      { id: "report", type: "report", enabled: true, label: "Collect" },
    ], edges: [{ source: "start", target: "verify" }, { source: "verify", target: "fix" }, { source: "fix", target: "report" }] };
    const result = await executeWorkflow({ workflow: typed, inputs: { findingId: "f1", runner: "docker" }, executors: {
      verify: async context => {
        expect(context.inputs).toEqual({ findingId: "f1", runner: "local" });
        return { status: "completed", outputs: [{ kind: "verification", value: { verdict: "not-reproduced", findingId: "f1" } }] };
      },
      fix: async context => {
        expect(context.node.fix?.mode).toBe("candidate");
        expect(context.priorOutputs).toEqual([{ nodeId: "verify", outputs: [{ kind: "verification", value: { verdict: "not-reproduced", findingId: "f1" } }] }]);
        return { status: "completed", outputs: [{ kind: "fix-candidate", value: { status: "ineligible", applied: false } }] };
      },
    } });
    expect(result.status).toBe("completed");
    expect(result.outputs).toHaveLength(2);
    expect(result.inputs).toEqual({ findingId: "f1", runner: "docker" });
    expect(result.reports).toEqual([]);
    expect(result.findings).toEqual([]);
  });
  it("rejects missing typed executors before any assessment or effects run", async () => {
    const typed = structuredClone(workflow);
    typed.nodes[2]!.type = "verify";
    let calls = 0;
    await expect(executeWorkflow({ workflow: typed, executeAssessment: async () => { calls++; return { status: "completed" }; } })).rejects.toThrow("No executor");
    expect(calls).toBe(0);
  });
  it("keeps sibling outputs isolated while collecting every connected branch", async () => {
    const branched = structuredClone(workflow);
    branched.nodes[1]!.type = "research";
    branched.nodes[2]!.type = "deep-review";
    branched.edges = [{ source: "start", target: "first" }, { source: "start", target: "second" }, { source: "first", target: "report" }, { source: "second", target: "report" }];
    const result = await executeWorkflow({ workflow: branched, executors: {
      research: async () => ({ status: "completed", outputs: [{ kind: "research", value: "evidence" }] }),
      "deep-review": async context => { expect(context.priorOutputs).toEqual([]); return { status: "completed", outputs: [{ kind: "deep-review", value: "evidence" }] }; },
    } });
    expect(result.status).toBe("completed");
    expect(result.outputs.map(output => output.nodeId)).toEqual(["first", "second"]);
  });
  it("selects an explicit connected predecessor and rejects disabled bindings before dispatch", async () => {
    const selected = structuredClone(workflow);
    selected.nodes[2]!.input = { fromStep: "first" };
    const observed = await executeWorkflow({ workflow: selected, executeAssessment: async context => {
      if (context.node.id === "second") expect(context.priorOutputs).toEqual([{ nodeId: "first", outputs: [{ kind: "context", value: "first evidence" }] }]);
      return { status: "completed", outputs: [{ kind: "context", value: "first evidence" }] };
    } });
    expect(observed.status).toBe("completed");
    selected.nodes[1]!.enabled = false;
    let calls = 0;
    await expect(executeWorkflow({ workflow: selected, executeAssessment: async () => { calls++; return { status: "completed" }; } })).rejects.toThrow("disabled predecessor");
    expect(calls).toBe(0);
  });
  it("preserves explicit executor cancellation independently of signal ownership", async () => {
    const result = await executeWorkflow({ workflow, executeAssessment: async () => ({ status: "cancelled", reports: [report([finding])], error: "Executor cancelled" }) });
    expect(result.status).toBe("cancelled");
    expect(result.nodeResults.first?.status).toBe("cancelled");
    expect(result.nodeResults.second?.status).toBe("cancelled");
    expect(result.findings).toEqual([finding]);
  });
  it("restricts report evidence and outputs to the merged explicit predecessor binding", async () => {
    const joined: SecurityWorkflowInput = { name: "Join", instructions: "", target: "/repo", nodes: [
      { id: "start", type: "trigger", enabled: true, label: "Start" },
      { id: "left", type: "audit", enabled: true, label: "Left" },
      { id: "right", type: "audit", enabled: true, label: "Right" },
      { id: "verify", type: "verify", enabled: true, label: "Verify", inputs: { fromStep: "right" } },
    ], edges: [{ source: "start", target: "left" }, { source: "start", target: "right" }, { source: "left", target: "verify" }, { source: "right", target: "verify" }] };
    const selected = { ...finding, id: "right-finding" };
    const result = await executeWorkflow({ workflow: joined, executors: {
      audit: async context => ({ status: "completed", reports: [report([context.node.id === "right" ? selected : finding])], outputs: [{ kind: "evidence", value: context.node.id }] }),
      verify: async context => {
        expect(context.priorReports.flatMap(entry => entry.findings)).toEqual([selected]);
        expect(context.priorFindings.map(entry => entry.id)).toEqual(["right-finding"]);
        expect(context.priorOutputs.map(entry => entry.nodeId)).toEqual(["right"]);
        return { status: "completed" };
      },
    } });
    expect(result.status).toBe("completed");
    let calls = 0;
    joined.nodes[3]!.inputs = { fromStep: "start" };
    await expect(executeWorkflow({ workflow: joined, executors: {
      audit: async () => { calls++; return { status: "completed" }; },
      verify: async () => ({ status: "completed" }),
    } })).rejects.toThrow("connected executable predecessor");
    expect(calls).toBe(0);
  });
  it("validates runtime fromStep bindings before launching any effects", async () => {
    let calls = 0;
    const executor = async () => { calls++; return { status: "completed" as const }; };
    await expect(executeWorkflow({ workflow, inputs: { fromStep: "second" }, executeAssessment: executor })).rejects.toThrow("connected executable predecessor");
    await expect(executeWorkflow({ workflow, inputs: { fromStep: 42 }, executeAssessment: executor })).rejects.toThrow("fromStep");
    expect(calls).toBe(0);
  });
  it("hands connected evidence forward and completes despite high findings", async () => {
    const observed: string[] = [];
    const original = structuredClone(workflow);
    const result = await executeWorkflow({ workflow: original, executeAssessment: async context => {
      observed.push(context.node.id);
      if (context.node.id === "first") {
        expect(getWorkflowAuditExecutionPolicy()?.allowedAgentTools).toEqual([]);
        original.nodes[2]!.enabled = false;
        return { status: "completed", reports: [report([finding])] };
      }
      expect(context.priorFindings).toEqual([{ id: finding.id, title: finding.title, category: finding.category, description: finding.description }]);
      expect(getWorkflowAuditExecutionPolicy()).toBeUndefined();
      return { status: "completed", reports: [report([])] };
    } });
    expect(observed).toEqual(["first", "second"]);
    expect(result.status).toBe("completed");
    expect(result.findings).toEqual([finding]);
    expect(result.report?.summary.high).toBe(1);
    expect(result.report?.findings[0]?.status).toBe("hypothesis");
  });
  it("does not hand sibling branch evidence to an unrelated step", async () => {
    const branched = structuredClone(workflow);
    branched.edges = [{ source: "start", target: "first" }, { source: "start", target: "second" }, { source: "first", target: "report" }, { source: "second", target: "report" }];
    await executeWorkflow({ workflow: branched, executeAssessment: async context => {
      expect(context.priorFindings).toEqual([]);
      return { status: "completed", reports: [report([finding])] };
    } });
  });
  it("uses a shared ledger with absolute step ceiling and stops at root budget", async () => {
    const ledger = new ScanCostLedger();
    const calls: number[] = [];
    const result = await executeWorkflow({ workflow, costLedger: ledger, costCapUsd: 20, executeAssessment: async context => {
      calls.push(context.plan.costCapUsd);
      expect(context.costLedger).toBe(ledger);
      ledger.add({ inputTokens: 1_000_000, outputTokens: 0 }, "claude-sonnet-4-20250514");
      return { status: "completed", reports: [] };
    } });
    expect(result.status).toBe("completed");
    expect(calls[0]).toBe(5);
    expect(calls[1]).toBeCloseTo(5 + ledger.runCostUsd() / 2);
    const exhausted = await executeWorkflow({ workflow, costLedger: ledger, costCapUsd: 0.01, executeAssessment: async () => { throw new Error("Must not execute"); } });
    expect(exhausted.status).toBe("failed");
    expect(exhausted.error).toContain("cost ceiling");
  });
  it("enforces the step ceiling even when a generic executor returns success", async () => {
    const ledger = new ScanCostLedger();
    const result = await executeWorkflow({ workflow, costCapUsd: 20, costLedger: ledger, executeAssessment: async context => {
      context.costLedger.add({ inputTokens: 2_000_000, outputTokens: 0 }, "claude-sonnet-4-20250514");
      return { status: "completed", reports: [report([finding])] };
    } });
    expect(ledger.totalCostUsd()).toBeGreaterThan(5);
    expect(ledger.totalCostUsd()).toBeLessThan(20);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("step cost ceiling");
    expect(result.nodeResults.second?.status).toBe("blocked");
    expect(result.findings).toEqual([finding]);
  });
  it("fails unknown provider pricing without reporting zero spend", async () => {
    const result = await executeWorkflow({ workflow, executeAssessment: async context => {
      context.costLedger.markUnpricedUsage();
      return { status: "completed", reports: [report([finding])] };
    } });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("unpriced");
    expect(result.costUsd).toBeUndefined();
    expect(result.nodeResults.second?.status).toBe("blocked");
    expect(result.findings).toEqual([finding]);
  });
  it("marks undispatched downstream steps blocked after failure and preserves partial evidence", async () => {
    const result = await executeWorkflow({ workflow, executeAssessment: async () => ({ status: "failed", error: "Assessment failed", reports: [report([finding])] }) });
    expect(result.status).toBe("failed");
    expect(result.nodeResults.start?.status).toBe("completed");
    expect(result.nodeResults.first?.status).toBe("failed");
    expect(result.nodeResults.second?.status).toBe("blocked");
    expect(result.nodeResults.report?.status).toBe("blocked");
    expect(result.findings).toEqual([finding]);
  });
  it("marks every undispatched enabled step cancelled for cancellation before launch", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Cancelled before launch"));
    const result = await executeWorkflow({ workflow, signal: controller.signal, executeAssessment: async () => { throw new Error("Must not dispatch"); } });
    expect(result.status).toBe("cancelled");
    expect(Object.values(result.nodeResults).every(node => node.status === "cancelled")).toBe(true);
  });
  it("bounds authorization and assessment within each step deadline", async () => {
    const boundedWorkflow = structuredClone(workflow);
    boundedWorkflow.nodes[1]!.plan = { goal: "known-vulnerabilities", depth: "quick", runCount: 1, executionMode: "sequential", timeCapMs: 5, costCapUsd: 5 };
    const result = await executeWorkflow({ workflow: boundedWorkflow, timeCapMs: 1000, executeAssessment: async context => {
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "completed" };
    } });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("step deadline");
    expect(result.nodeResults.second?.status).toBe("blocked");
  });
  it("distinguishes cancellation and deadline exhaustion and preserves partial reports", async () => {
    const controller = new AbortController();
    const cancelled = await executeWorkflow({ workflow, signal: controller.signal, executeAssessment: async () => {
      controller.abort(new Error("Cancel"));
      return { status: "completed", reports: [report([finding])] };
    } });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.findings).toEqual([finding]);
    const timed = await executeWorkflow({ workflow, timeCapMs: 5, executeAssessment: async context => {
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "completed" };
    } });
    expect(timed.status).toBe("failed");
    expect(timed.error).toContain("deadline");
  });
});

describe("owned workflow service", () => {
  it("acknowledges cancellation while executor cleanup is still pending", async () => {
    const snapshots: Array<{ status: string; cancellationRequestedAt?: string }> = [];
    const service = new WorkflowService({ onChange: run => { snapshots.push(run); } });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    service.start("owner", { workflow, executeAssessment: async () => { entered(); await cleanup; return { status: "cancelled" }; } }, { id: "pending" });
    await started;
    expect(() => service.cancel("other", "pending")).toThrow("not found");
    const acknowledged = service.cancel("owner", "pending");
    expect(acknowledged.status).toBe("running");
    expect(acknowledged.cancellationRequestedAt).toEqual(expect.any(String));
    expect(service.cancel("owner", "pending").cancellationRequestedAt).toBe(acknowledged.cancellationRequestedAt);
    await vi.waitFor(() => expect(snapshots.some(run => run.status === "running" && run.cancellationRequestedAt)).toBe(true));
    release();
    await service.wait("owner", "pending");
    expect(service.get("owner", "pending").status).toBe("cancelled");
    await service.dispose();
  });
  it("starts promptly, enforces ownership, deduplicates launches, and retains results", async () => {
    const service = new WorkflowService();
    let calls = 0;
    const options = { workflow, executeAssessment: async () => { calls++; return { status: "completed" as const, reports: [report([])] }; } };
    const launch = service.start("owner", options, { id: "run1", idempotencyKey: "retry" });
    expect(launch.status).toBe("queued");
    expect(service.start("owner", options, { idempotencyKey: "retry" }).id).toBe("run1");
    expect(() => service.get("another", "run1")).toThrow("not found");
    expect(() => service.start("owner", { ...options, target: "/other" }, { idempotencyKey: "retry" })).toThrow("different");
    await service.wait("owner", "run1");
    expect(calls).toBe(2);
    expect(service.getResults("owner", "run1")?.status).toBe("completed");
    expect(service.get("owner", "run1", 1).events.every(event => event.sequence > 1)).toBe(true);
    await service.dispose();
    expect(() => service.start("owner", options)).toThrow("shutting down");
  });
  it("cancels on host disposal and persists final owned status", async () => {
    const states: string[] = [];
    const service = new WorkflowService({ onChange: run => { states.push(run.status); } });
    service.start("owner", { workflow, executeAssessment: async context => {
      await new Promise<void>(resolve => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { status: "cancelled" };
    } }, { id: "run" });
    await service.dispose();
    expect(service.get("owner", "run").status).toBe("cancelled");
    expect(states.at(-1)).toBe("cancelled");
  });
  it("orders retained aggregate findings by evidenced business impact before technical CVSS", async () => {
    const customer = { ...finding, id: "customer", severity: "high", cvssScore: 7.2, impactAssessment: { reachability_tier: "remote-auth", weaponizability: "info-leak", blast_radius: "Production customer records across tenants", business_impact: "headline", rationale: "Replay demonstrates cross-tenant customer record access", assessment_source: "provided" } } as Finding;
    const offline = { ...finding, id: "offline", severity: "critical", cvssScore: 9.8, impactAssessment: { reachability_tier: "local-unpriv", weaponizability: "dos-crash", blast_radius: "Unused offline test utility", business_impact: "noise", rationale: "Deployment inventory confirms no operational or customer dependency", assessment_source: "provided" } } as Finding;
    const unknown = { ...finding, id: "unknown", severity: "critical", cvssScore: 10 } as Finding;
    const result = await executeWorkflow({ workflow, executeAssessment: async context => ({ status: "completed", reports: [report(context.node.id === "first" ? [offline, unknown] : [customer])] }) });
    expect(result.findings.map(item => item.id)).toEqual(["customer", "unknown", "offline"]);
    expect(result.report?.findings.map(item => item.id)).toEqual(["customer", "unknown", "offline"]);
    expect(result.findings.find(item => item.id === "offline")?.cvssScore).toBe(9.8);
    expect(result.findings.find(item => item.id === "customer")?.status).toBe("hypothesis");
    expect(result.reports[0]!.findings.map(item => item.id)).toEqual(["offline", "unknown"]);
  });

});
