import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeRuntime } from "@0/core";
import { SecurityWorkflowStore } from "@0/db";
import type { ScanReport } from "@0/shared";
import type { RunOptions, RunOutcome } from "./commands/run.js";
import { createRemoteWorkflowRuntime } from "./remote-workflow-runtime.js";
import { WorkflowEngineService } from "./workflow-engine-service.js";
import { BackendConnectionRegistry, createBackendHandshake } from "./web/backend-connections.js";
import { ConsoleGateway, type ConsoleExecutionContext } from "./web/console-gateway.js";
import { WebWorkflowService } from "./web/workflows.js";

// End-to-end transport/persistence fixture: only the assessment/model boundary is
// synthetic. Session admission, engine RPC, HTTP, browser projection and SQLite
// retention use their production implementations.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function continuityHost() {
  const root = mkdtempSync(join(tmpdir(), "0-interface-continuity-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "repo"); mkdirSync(workspace);
  const dbPath = join(root, "history.db");
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const gateway = new ConsoleGateway({ projectPath: workspace, dbPath, homeDir: root });
  const context = {
    runtime: { type: "api", isAvailable: async () => true, executeNative: vi.fn() } as unknown as NativeRuntime,
    model: "fixture", providerId: "fixture", target: workspace, status: "ready", autonomyMode: "standard", role: "audit",
    scopeEnforcement: { pluginId: "scope", enabled: false, projectPath: workspace, message: "Fixture" },
  } as ConsoleExecutionContext;
  vi.spyOn(gateway, "getExecutionContext").mockResolvedValue(context);
  vi.spyOn(gateway, "authorizeWorkflowTarget").mockResolvedValue(context);
  const evidence: ScanReport = {
    target: workspace, scanDepth: "quick", startedAt: "2026-01-01", completedAt: "2026-01-01", durationMs: 1,
    findings: [{ id: "continuity-finding", templateId: "fixture", status: "discovered", title: "Retained finding", category: "other", severity: "high", description: "Fixture evidence", timestamp: Date.now(), evidence: { request: "fixture request", response: "fixture response" } }],
    warnings: [], summary: { totalAttacks: 1, totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 },
  } as ScanReport;
  const assessment = vi.fn(async (request: RunOptions) => {
    request.onEvent?.({ type: "scan_started", data: { scanId: "continuity-scan", persisted: true } });
    entered.resolve(); await finish.promise;
    expect(request.signal?.aborted).toBe(false);
    request.onReport?.(evidence);
    request.onOutcome?.({ attempts: [{ status: "completed" }], exit_reason: "completed" } as unknown as RunOutcome);
  });
  const workflows = new WebWorkflowService({ gateway, dbPath, runAssessment: assessment });
  gateway.attachWorkflowLifecycle({ invoke: (sessionId, name, args, capabilities) => workflows.invokeLifecycle(sessionId, name, args, capabilities) });
  const token = "continuity-engine-secret".repeat(2);
  const engine = new WorkflowEngineService({ token, workspace, dbPath }, { gateway, workflows });
  await engine.ready;
  const handshake = createBackendHandshake(dbPath, ["workflow-engine", "workflows"]);
  const server: Server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("X-0-Engine-ID", handshake.engineId);
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403); response.end(JSON.stringify({ error: "Unauthorized" })); return; }
    if (request.url === "/api/backend/handshake") { response.end(JSON.stringify(handshake)); return; }
    if (request.headers["x-0-expected-engine-id"] !== handshake.engineId) { response.writeHead(409); response.end(JSON.stringify({ error: "Wrong engine" })); return; }
    try {
      const url = new URL(request.url!, "http://engine.test");
      if (url.pathname === "/api/workflow-engine/call" && request.method === "POST") {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name: string; args: Record<string, unknown> };
        response.end(JSON.stringify(await engine.invoke(input.name, input.args))); return;
      }
      const work = url.pathname.match(/^\/api\/work\/([^/]+)$/);
      if (url.pathname === "/api/work" || work) {
        if (request.method !== "GET") { response.writeHead(405); response.end(JSON.stringify({ error: "Use GET to inspect work history." })); return; }
        response.end(JSON.stringify(await engine.invoke(work ? "get_work" : "list_work", work ? { workId: decodeURIComponent(work[1]!) } : {}))); return;
      }
      const result = await workflows.handle(url.pathname, request.method ?? "GET", undefined, url.searchParams);
      response.writeHead(result?.status ?? 404); response.end(JSON.stringify(result?.data ?? { error: "Not found" }));
    } catch (error) { response.writeHead(error && typeof error === "object" && "status" in error ? Number(error.status) : 400); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port.");
  cleanups.push(async () => { finish.resolve(); await workflows.dispose(); await gateway.closeAll(); await engine.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const registry = new BackendConnectionRegistry({
    connections: [{ id: "continuity", name: "Continuity engine", url: `http://127.0.0.1:${address.port}/`, expectedEngineId: handshake.engineId, bearerTokenEnv: "CONTINUITY_TOKEN" }],
    env: { CONTINUITY_TOKEN: token }, localHandshake: createBackendHandshake(":memory:"),
  });
  cleanups.push(() => registry.dispose());
  return { gateway, workflows, engine, registry, workspace, dbPath, entered, finish, evidence, assessment };
}

describe("chat, CLI and web interface continuity over real HTTP", () => {
  it("keeps browser session, CLI execution, native scan evidence and retained results linked after detaching", async () => {
    const host = await continuityHost();
    const conversation = host.gateway.create({ target: host.workspace, title: "Browser investigation" });
    const cli = await createRemoteWorkflowRuntime({ backendId: "continuity", sessionId: conversation.id }, host.registry);
    cleanups.push(() => cli.dispose());
    const definition = await cli.saveWorkflow({
      name: "Continuity assessment", instructions: "", target: host.workspace,
      nodes: [{ id: "start", type: "trigger", label: "Start", enabled: true }, { id: "audit", type: "audit", label: "Audit", enabled: true }],
      edges: [{ source: "start", target: "audit" }],
    }) as { id: string; revision: number };
    const execution = await cli.startRun({ workflowId: definition.id, revision: definition.revision, target: host.workspace });
    await host.entered.promise;
    expect(execution.sessionId).toBe(conversation.id);
    const browserRead = () => host.registry.request("continuity", `/api/console/workflow-executions/${execution.id}?sessionId=${encodeURIComponent(conversation.id)}`, { method: "GET" });
    expect(await (await browserRead()).json()).toMatchObject({ execution: { id: execution.id, sessionId: conversation.id, status: "running" } });
    expect(await cli.getRun(execution.id)).toMatchObject({ id: execution.id, sessionId: conversation.id, status: "running" });
    const workId = `workflow:${execution.id}`;
    expect(await cli.getWork(workId)).toMatchObject({ id: workId, kind: "workflow", conversation: { sessionId: conversation.id }, native: { workflowExecutionId: execution.id }, status: "running" });
    expect(await cli.listWork()).toEqual(expect.arrayContaining([expect.objectContaining({ id: workId })]));
    const browserList = await host.registry.request("continuity", "/api/work", { method: "GET" });
    expect(browserList.status).toBe(200);
    expect(await browserList.json()).toEqual(await cli.listWork());
    const browserDetailPath = `/api/work/${encodeURIComponent(workId)}`;
    const browserDetail = await host.registry.request("continuity", browserDetailPath, { method: "GET" });
    expect(browserDetail.status).toBe(200);
    expect(await browserDetail.json()).toEqual(await cli.getWork(workId));
    await cli.dispose();
    expect(host.workflows.getExecution(execution.id)?.status).toBe("running");
    expect(host.gateway.get(conversation.id).session.id).toBe(conversation.id);
    const reattached = await createRemoteWorkflowRuntime({ backendId: "continuity", sessionId: conversation.id }, host.registry);
    cleanups.push(() => reattached.dispose());
    host.finish.resolve();
    await vi.waitFor(async () => expect((await reattached.getRun(execution.id))?.status).toBe("completed"));
    const completed = (await reattached.getRun(execution.id))!;
    expect(Object.values(completed.nodeResults).flatMap(node => node.scanIds ?? [])).toContain("continuity-scan");
    expect(await reattached.getRunResults(execution.id)).toMatchObject({ retained: true, findings: [{ id: "continuity-finding" }], totalFindings: 1 });
    expect(await (await browserRead()).json()).toMatchObject({ execution: { id: execution.id, sessionId: conversation.id, status: "completed" } });
    const unified = await reattached.getWork(workId);
    expect(unified).toMatchObject({ id: workId, kind: "workflow", status: "completed", conversation: { sessionId: conversation.id }, native: { workflowExecutionId: execution.id, scanIds: ["continuity-scan"] } });
    const browserWork = await host.registry.request("continuity", "/api/workflow-engine/call", { method: "POST", body: { name: "get_work", args: { workId } } });
    expect(await browserWork.json()).toEqual(unified);
    const completedBrowserDetail = await host.registry.request("continuity", browserDetailPath, { method: "GET" });
    expect(await completedBrowserDetail.json()).toEqual(unified);
    const store = new SecurityWorkflowStore(host.dbPath);
    try {
      expect(store.getExecution(execution.id)).toMatchObject({ id: execution.id, sessionId: conversation.id, status: "completed" });
      expect(JSON.stringify(store.getExecutionResults(execution.id))).toContain("continuity-finding");
    } finally { store.close(); }
    expect(host.assessment).toHaveBeenCalledTimes(1);
    await expect(reattached.getRun("missing-execution")).rejects.toThrow("not found");
    const foreign = host.gateway.create({ target: host.workspace });
    const denied = await host.registry.request("continuity", `/api/console/workflow-executions/${execution.id}?sessionId=${encodeURIComponent(foreign.id)}`, { method: "GET" });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ error: expect.stringContaining("not found") });
  });
});
