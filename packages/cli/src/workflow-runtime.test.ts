import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecurityWorkflowStore } from "@0/db";
import type { Finding, ScanReport } from "@0/shared";
import { withScopeEnforcement, type NativeRuntime, type AssessmentOptions } from "@0/core";
import { createCliWorkflowRuntime, parseWorkflowRunInputs, type CliWorkflowDependencies } from "./workflow-runtime.js";

const dirs: string[] = [];
const hosts: Awaited<ReturnType<typeof createCliWorkflowRuntime>>[] = [];
const finding = { id: "f1", title: "Supported finding", category: "other", description: "Prior evidence", severity: "high", status: "hypothesis", evidence: {} } as unknown as Finding;
function report(): ScanReport {
  return { target: "/fixture", scanDepth: "quick", startedAt: "2026-01-01", completedAt: "2026-01-01", durationMs: 1, findings: [finding], warnings: [], summary: { totalAttacks: 1, totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 } };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workflow-runtime-"));
  dirs.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return { root, workspace, dbPath: join(root, "history.db") };
}
function deps(overrides: Partial<CliWorkflowDependencies> = {}): CliWorkflowDependencies {
  return { createRuntime: vi.fn(() => ({ type: "api", isAvailable: async () => true, executeNative: async () => ({ content: [] }) }) as unknown as NativeRuntime),
    assess: vi.fn(async () => ({ report: report(), rawReport: report() })), ...overrides };
}
async function host(options: Parameters<typeof createCliWorkflowRuntime>[0], dependencies = deps()) {
  const runtime = await createCliWorkflowRuntime(options, dependencies);
  hosts.push(runtime);
  return runtime;
}
async function settled(runtime: Awaited<ReturnType<typeof createCliWorkflowRuntime>>, id: string) {
  await vi.waitFor(() => expect(["completed", "failed", "cancelled"]).toContain(runtime.getRun(id).status));
  // Persistence callbacks follow in-memory completion; dispose waits for them.
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of hosts.splice(0)) await runtime.dispose();
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("CLI and MCP shared workflow runtime", () => {
  it("projects acknowledged cancellation before cleanup completes", async () => {
    const paths = fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const runtime = await host({ ...paths, ownerId: "owner" }, deps({ assess: async () => {
      entered(); await cleanup;
      return { report: { ...report(), exitReason: "cancelled" }, rawReport: report() };
    } }));
    const run = await runtime.startRun({ templateId: "repository-review", target: paths.workspace });
    await started;
    const acknowledged = runtime.cancelRun(run.id);
    expect(acknowledged).toMatchObject({ status: "running", cancellationRequested: true, cancellationAcknowledged: true, cancellationRequestedAt: expect.any(String) });
    expect(runtime.getRun(run.id)).toMatchObject({ status: "running", cancellationAcknowledged: true });
    expect(runtime.listRuns()[0]).toMatchObject({ status: "running", cancellationAcknowledged: true });
    release();
    await settled(runtime, run.id);
    expect(runtime.getRun(run.id).status).toBe("cancelled");
  });
  it("lets requests narrow server ceilings without increasing them", async () => {
    const paths = fixture();
    const dependencies = deps();
    const runtime = await host({ ...paths, ownerId: "engine-owner", timeCapMs: 2000, costCapUsd: 2 }, dependencies);
    const first = await runtime.startRun({ templateId: "repository-review", target: paths.workspace, timeCapMs: 9000, costCapUsd: 9 });
    await settled(runtime, first.id);
    for (const [options] of vi.mocked(dependencies.assess).mock.calls) {
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(2000);
      expect(options.costCeilingUsd).toBe(2);
    }
    vi.mocked(dependencies.assess).mockClear();
    const second = await runtime.startRun({ templateId: "repository-review", target: paths.workspace, timeCapMs: 1000, costCapUsd: 1 });
    await settled(runtime, second.id);
    for (const [options] of vi.mocked(dependencies.assess).mock.calls) {
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(1000);
      expect(options.costCeilingUsd).toBe(1);
    }
    expect(dependencies.assess).toHaveBeenCalled();
  });
  it("hosted initialization skips shared recovery and keeps browser-owned active history", async () => {
    const paths = fixture();
    const store = new SecurityWorkflowStore(paths.dbPath);
    const definition = store.save({ name: "Browser run", instructions: "", target: paths.workspace,
      nodes: [{ id: "start", type: "trigger", label: "Start", enabled: true }, { id: "audit", type: "audit", label: "Audit", enabled: true }, { id: "report", type: "report", label: "Report", enabled: true }], edges: [{ source: "start", target: "audit" }, { source: "audit", target: "report" }] });
    const browser = store.createExecution(definition.id, "browser-owner", definition.revision);
    store.updateExecution(browser.id, { status: "running" });
    const recovery = vi.spyOn(SecurityWorkflowStore.prototype, "interruptActiveExecutions");
    const runtime = await host({ ...paths, ownerId: "engine-owner", recoverInterrupted: false });
    expect(recovery).not.toHaveBeenCalled();
    expect(store.getExecution(browser.id)?.status).toBe("running");
    expect(runtime.listRuns()).toEqual([]);
    store.close();
  });
  it("validates bounded JSON bindings and keeps application permission at the host boundary", async () => {
    expect(() => parseWorkflowRunInputs({ value: undefined })).toThrow();
    expect(() => parseWorkflowRunInputs({ note: "x".repeat(33_000) })).toThrow();
    expect(() => parseWorkflowRunInputs(JSON.parse('{"__proto__":{}}'))).toThrow();
    const paths = fixture();
    const dependencies = deps();
    const runtime = await host({ ...paths, ownerId: "owner" }, dependencies);
    await expect(runtime.startRun({ templateId: "repository-review", target: paths.workspace, allowApply: true })).rejects.toThrow("does not authorize");
    expect(dependencies.createRuntime).not.toHaveBeenCalled();
    const store = new SecurityWorkflowStore(paths.dbPath);
    expect(store.listExecutions()).toHaveLength(0);
    store.close();
  });

  it("checks verification inputs before allocation without requiring an available model", async () => {
    const paths = fixture();
    const available = vi.fn(async () => false);
    const runtime = await host({ ...paths, ownerId: "owner" }, deps({ createRuntime: () => ({ type: "api", isAvailable: available }) as unknown as NativeRuntime }));
    await expect(runtime.startRun({ templateId: "finding-verification", target: paths.workspace, inputs: { findingId: "f1" } })).rejects.toThrow("explicit");
    expect(available).not.toHaveBeenCalled();
    const store = new SecurityWorkflowStore(paths.dbPath);
    expect(store.listExecutions()).toHaveLength(0);
    store.close();
  });
  it("rejects unbounded research engines and escaped artifacts before allocating history", async () => {
    const paths = fixture();
    const dependencies = deps();
    const runtime = await host({ ...paths, ownerId: "owner" }, dependencies);
    const template = runtime.getTemplate("security-research").definition;
    const saved = runtime.saveWorkflow({ ...template, nodes: template.nodes.map(node => ({ ...node, inputs: undefined })), target: paths.workspace });
    await expect(runtime.startRun({ workflowId: saved.id, target: paths.workspace, inputs: { engine: "linux" } })).rejects.toThrow("cancellation");
    await expect(runtime.startRun({ templateId: "security-research", target: paths.workspace, inputs: { artifactRoot: paths.root } })).rejects.toThrow("outside");
    expect(dependencies.createRuntime).not.toHaveBeenCalled();
    const store = new SecurityWorkflowStore(paths.dbPath);
    expect(store.listExecutions()).toHaveLength(0);
    store.close();
  });
  it("rejects forged candidate IDs and retains verification output without inventing a scan report", async () => {
    const paths = fixture();
    const available = vi.fn(async () => false);
    const runtime = await host({ ...paths, ownerId: "owner" }, deps({ createRuntime: () => ({ type: "api", isAvailable: available }) as unknown as NativeRuntime }));
    const run = await runtime.startRun({ templateId: "finding-verification", target: paths.workspace, inputs: { candidateId: "forged-candidate" } });
    await settled(runtime, run.id);
    expect(runtime.getRun(run.id).status).toBe("failed");
    expect(runtime.getRunResults(run.id).report).toBeUndefined();
    expect(runtime.getRunResults(run.id).findings).toEqual([]);
    expect(available).not.toHaveBeenCalled();
  });
  it("runs a pinned template without saving a clone and shares evidence and ledger", async () => {
    const paths = fixture();
    const calls: AssessmentOptions[] = [];
    const runtime = await host({ ...paths, ownerId: "owner" }, deps({ assess: vi.fn(async options => {
      calls.push(options);
      return { report: report(), rawReport: report() };
    }) }));
    const run = await runtime.startRun({ templateId: "repository-review", revision: 1, target: paths.workspace });
    await settled(runtime, run.id);
    expect(runtime.listWorkflows()).toHaveLength(0);
    expect(run.workflow.template).toEqual({ id: "repository-review", revision: 1 });
    expect(runtime.getRun(run.id).status).toBe("completed");
    expect(calls).toHaveLength(3);
    expect(calls.every(call => call.costLedger === calls[0]!.costLedger)).toBe(true);
    expect(calls[0]!.priorFindings).toEqual([]);
    expect(calls[1]!.priorFindings?.[0]?.id).toBe("f1");
    expect(runtime.getRunResults(run.id).totalFindings).toBe(3);
  });
  it("rejects outside roots, symlink escapes, incompatible templates, and live targets without scope before allocation", async () => {
    const paths = fixture();
    const outside = join(paths.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(paths.workspace, "escape"));
    const dependencies = deps();
    const runtime = await host({ ...paths, ownerId: "owner" }, dependencies);
    await expect(runtime.startRun({ templateId: "repository-review", target: outside })).rejects.toThrow("outside");
    await expect(runtime.startRun({ templateId: "repository-review", target: join(paths.workspace, "escape") })).rejects.toThrow("outside");
    await expect(runtime.startRun({ templateId: "api-security", target: paths.workspace })).rejects.toThrow();
    await expect(runtime.startRun({ templateId: "api-security", target: "https://example.test" })).rejects.toThrow("scope");
    expect(dependencies.createRuntime).not.toHaveBeenCalled();
    const store = new SecurityWorkflowStore(paths.dbPath);
    expect(store.listExecutions()).toHaveLength(0);
    store.close();
  });
  it("requires active scope enforcement and rejects denied live hosts", async () => {
    const paths = fixture();
    const scopePath = join(paths.root, "scope.json");
    writeFileSync(scopePath, JSON.stringify({ in_scope: ["example.test"], out_of_scope: ["denied.example.test"] }));
    const disabled = await withScopeEnforcement({ pluginId: "scope", enabled: false, projectPath: paths.root, message: "Fixture disabled" }, () => host({ ownerId: "owner", dbPath: paths.dbPath, scopePath }));
    await expect(disabled.startRun({ templateId: "api-security", target: "https://example.test" })).rejects.toThrow("scope enforcement");
    const enabled = await withScopeEnforcement({ pluginId: "scope", enabled: true, projectPath: paths.root, message: "Fixture authorization" }, () => host({ ownerId: "enabled", dbPath: paths.dbPath, scopePath }));
    await expect(enabled.startRun({ templateId: "api-security", target: "https://denied.example.test" })).rejects.toThrow("out of scope");
    const run = await enabled.startRun({ templateId: "api-security", target: "https://example.test" });
    await settled(enabled, run.id);
    expect(enabled.getRun(run.id).status).toBe("completed");
  });
  it("rejects missing provider without allocating an execution", async () => {
    const paths = fixture();
    const runtime = await host({ ...paths, ownerId: "owner" }, deps({ createRuntime: () => ({ type: "api", isAvailable: async () => false }) as unknown as NativeRuntime }));
    await expect(runtime.startRun({ templateId: "repository-review", target: paths.workspace })).rejects.toThrow("provider");
    const store = new SecurityWorkflowStore(paths.dbPath);
    expect(store.listExecutions()).toHaveLength(0);
    store.close();
  });
  it("runs saved definitions and rejects stale revisions", async () => {
    const paths = fixture();
    const runtime = await host({ ...paths, ownerId: "owner" });
    const saved = runtime.saveWorkflow({ ...runtime.getTemplate("repository-review").definition, target: paths.workspace });
    await expect(runtime.startRun({ workflowId: saved.id, revision: 2, target: paths.workspace })).rejects.toThrow("revision");
    const run = await runtime.startRun({ workflowId: saved.id, revision: saved.revision, target: paths.workspace });
    await settled(runtime, run.id);
    expect(runtime.getRun(run.id).status).toBe("completed");
  });
  it("coalesces concurrent retries and refuses conflicting concurrent requests for the same key", async () => {
    const paths = fixture();
    let available!: () => void;
    const availability = new Promise<void>(resolve => { available = resolve; });
    const dependencies = deps({ createRuntime: vi.fn(() => ({ type: "api", executeNative: async () => ({}), isAvailable: async () => { await availability; return true; } }) as unknown as NativeRuntime) });
    const runtime = await host({ ...paths, ownerId: "owner" }, dependencies);
    const request = { templateId: "repository-review", target: paths.workspace, idempotencyKey: "retry" };
    const first = runtime.startRun(request);
    const duplicate = runtime.startRun({ ...request });
    const conflicting = runtime.startRun({ ...request, model: "another-model" });
    const conflictObserved = conflicting.then(() => false, () => true);
    available();
    const [a, b] = await Promise.all([first, duplicate]);
    expect(a.id).toBe(b.id);
    expect(await conflictObserved).toBe(true);
    await settled(runtime, a.id);
    const store = new SecurityWorkflowStore(paths.dbPath);
    expect(store.listExecutions()).toHaveLength(1);
    store.close();
  });
  it("persists results across reopening and enforces owner visibility", async () => {
    const paths = fixture();
    const runtime = await host({ ...paths, ownerId: "owner" });
    const run = await runtime.startRun({ templateId: "repository-review", target: paths.workspace });
    await settled(runtime, run.id);
    await runtime.dispose();
    const reopened = await host({ ...paths, ownerId: "owner" });
    expect(reopened.getRun(run.id).status).toBe("completed");
    expect(reopened.getRunResults(run.id, { limit: 1 }).findings).toEqual([finding]);
    expect(reopened.getRunResults(run.id, { limit: 1 }).nextCursor).toBe(1);
    const another = await host({ ...paths, ownerId: "another" });
    expect(() => another.getRun(run.id)).toThrow("owner");
    expect(() => another.cancelRun(run.id)).toThrow("owner");
    const operator = await host({ ...paths, ownerId: "cli" });
    expect(operator.getRun(run.id).status).toBe("completed");
    expect(operator.getRunResults(run.id, { limit: 1 }).findings).toEqual([finding]);
    expect(() => operator.cancelRun(run.id)).toThrow("owner");
  });
  it("finishes durable history when result retention fails and reports unavailable reopened results", async () => {
    const paths = fixture();
    const save = vi.spyOn(SecurityWorkflowStore.prototype, "saveExecutionResults").mockImplementation(() => { throw new Error("Workflow results must be valid JSON of at most 16 MiB."); });
    const runtime = await host({ ...paths, ownerId: "owner" });
    const run = await runtime.startRun({ templateId: "repository-review", target: paths.workspace });
    await settled(runtime, run.id);
    expect(runtime.getRunResults(run.id).findings).toHaveLength(3);
    await runtime.dispose();
    save.mockRestore();
    const reopened = await host({ ...paths, ownerId: "owner" });
    expect(reopened.getRun(run.id).status).toBe("completed");
    expect(reopened.getRun(run.id).error).toContain("retention failed");
    expect(reopened.getRunResults(run.id)).toMatchObject({ retained: false, pending: false, findings: [] });
    expect(reopened.getRunResults(run.id).error).toContain("16 MiB");
  });
  it("validates pagination while results are pending", async () => {
    const paths = fixture();
    const runtime = await host({ ...paths, ownerId: "owner" }, deps({ assess: async options => {
      await new Promise<void>(resolve => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { report: { ...report(), exitReason: "cancelled" }, rawReport: report() };
    } }));
    const run = await runtime.startRun({ templateId: "repository-review", target: paths.workspace });
    expect(() => runtime.getRunResults(run.id, { limit: 101 })).toThrow("Invalid result page");
    expect(() => runtime.getRunResults(run.id, { cursor: -1 })).toThrow("Invalid result page");
    expect(runtime.getRunResults(run.id).pending).toBe(true);
    runtime.cancelRun(run.id);
    await settled(runtime, run.id);
  });
  it("cancels active assessments and preserves cancelled history", async () => {
    const paths = fixture();
    const runtime = await host({ ...paths, ownerId: "owner" }, deps({ assess: async options => {
      await new Promise<void>(resolve => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { report: { ...report(), exitReason: "cancelled" }, rawReport: report() };
    } }));
    const run = await runtime.startRun({ templateId: "repository-review", target: paths.workspace });
    runtime.cancelRun(run.id);
    await settled(runtime, run.id);
    expect(runtime.getRun(run.id).status).toBe("cancelled");
    await runtime.dispose();
    const reopened = await host({ ...paths, ownerId: "owner" });
    expect(reopened.getRun(run.id).status).toBe("cancelled");
  });
});
