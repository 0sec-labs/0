import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeRuntime, AssessmentOptions } from "@0/core";
import type { ScanReport, SecurityWorkflowExecution } from "@0/shared";
import { createCliWorkflowRuntime } from "./workflow-runtime.js";
import { WorkflowEngineService } from "./workflow-engine-service.js";
import { createRemoteWorkflowRuntime } from "./remote-workflow-runtime.js";
import { BackendConnectionRegistry, createBackendHandshake } from "./web/backend-connections.js";

const roots: string[] = [];
const engines: WorkflowEngineService[] = [];
const servers: Server[] = [];
const registries: BackendConnectionRegistry[] = [];
const releaseGates: Array<() => void> = [];
const token = "integration-server-secret".repeat(2);
function report(target: string): ScanReport {
  return { target, scanDepth: "quick", startedAt: "2026-01-01", completedAt: "2026-01-01", durationMs: 1,
    findings: [{ id: "same-finding", templateId: "fixture", status: "discovered", title: "Retained evidence", category: "other", severity: "high", description: "Engine-owned evidence", timestamp: Date.now(), evidence: { request: "fixture request", response: "fixture response" } }],
    warnings: [], summary: { totalAttacks: 1, totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 } } as ScanReport;
}
function location() {
  const root = mkdtempSync(join(tmpdir(), "0-backend-integration-")); roots.push(root);
  const workspace = join(root, "repo"); mkdirSync(workspace);
  return { workspace, dbPath: join(root, "history.db") };
}
async function engine(paths: ReturnType<typeof location>, assess: (options: AssessmentOptions) => Promise<{ report: ScanReport; rawReport: ScanReport }>) {
  let service = new WorkflowEngineService({ token, ...paths }, options => createCliWorkflowRuntime(options, {
    createRuntime: () => ({ type: "api", isAvailable: async () => true, executeNative: async () => ({ content: [] }) }) as unknown as NativeRuntime,
    assess,
  }));
  engines.push(service); await service.ready;
  const handshake = createBackendHandshake(paths.dbPath, ["workflow-engine"]);
  const server = createServer(async (req, res) => {
    res.setHeader("X-0-Engine-ID", handshake.engineId);
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); res.end(JSON.stringify({ error: "Unauthorized" })); return; }
    if (req.url === "/api/backend/handshake") { res.end(JSON.stringify(handshake)); return; }
    if (req.headers["x-0-expected-engine-id"] !== handshake.engineId) { res.writeHead(409); res.end(JSON.stringify({ error: "Wrong engine" })); return; }
    try {
      if (req.url !== "/api/workflow-engine/call" || req.method !== "POST") throw new Error("Unsupported route");
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { name, args } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.end(JSON.stringify(await service.invoke(name, args)));
    } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
  });
  servers.push(server); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No engine port");
  return { url: `http://127.0.0.1:${address.port}/`, engineId: handshake.engineId,
    restart: async () => { await service.dispose(); service = new WorkflowEngineService({ token, ...paths }, options => createCliWorkflowRuntime(options, {
      createRuntime: () => ({ type: "api", isAvailable: async () => true }) as unknown as NativeRuntime, assess,
    })); engines.push(service); await service.ready; },
  };
}
function registry(peers: Array<{ id: string; url: string; engineId: string }>) {
  const value = new BackendConnectionRegistry({ connections: peers.map(peer => ({ id: peer.id, name: peer.id, url: peer.url, expectedEngineId: peer.engineId, bearerTokenEnv: "ENGINE_TOKEN" })), env: { ENGINE_TOKEN: token } });
  registries.push(value); return value;
}
async function terminal(client: Awaited<ReturnType<typeof createRemoteWorkflowRuntime>>, id: string, status: string) {
  await vi.waitFor(async () => expect((await client.getRun(id))?.status).toBe(status), { timeout: 5000 });
}
const definition = (target: string) => ({ id: "same-workflow", name: "Engine-owned workflow", instructions: "", target,
  nodes: [{ id: "start", type: "trigger", label: "Start", enabled: true }, { id: "audit", type: "audit", label: "Audit", enabled: true }], edges: [{ source: "start", target: "audit" }] });

afterEach(async () => {
  for (const release of releaseGates.splice(0)) release();
  for (const registry of registries.splice(0)) registry.dispose();
  for (const service of engines.splice(0)) await service.dispose();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("real HTTP workflow engines and retained lifecycle", () => {
  it("detaches clients without cancellation, isolates equal workflow IDs, and reads retained results after restart", async () => {
    const pathsA = location(); const pathsB = location();
    const gate = Promise.withResolvers<void>(); releaseGates.push(gate.resolve);
    const entered = Promise.withResolvers<void>();
    const a = await engine(pathsA, async options => { entered.resolve(); await gate.promise; return { report: report(options.target), rawReport: report(options.target) }; });
    const b = await engine(pathsB, async options => ({ report: report(options.target), rawReport: report(options.target) }));
    const peers = [{ id: "a", ...a }, { id: "b", ...b }];
    const connection = registry(peers);
    const clientA = await createRemoteWorkflowRuntime({ backendId: "a" }, connection);
    const clientB = await createRemoteWorkflowRuntime({ backendId: "b" }, connection);
    const workflowA = await clientA.saveWorkflow(definition(pathsA.workspace)) as { id: string; revision: number };
    const workflowB = await clientB.saveWorkflow(definition(pathsB.workspace)) as { id: string; revision: number };
    expect(workflowA.id).toBe(workflowB.id);
    const runA = await clientA.startRun({ workflowId: workflowA.id, revision: workflowA.revision, target: pathsA.workspace });
    await entered.promise; expect((await clientA.getRun(runA.id))?.status).toBe("running");
    await clientA.dispose(); connection.dispose();
    const reconnected = registry(peers);
    const again = await createRemoteWorkflowRuntime({ backendId: "a" }, reconnected);
    const other = await createRemoteWorkflowRuntime({ backendId: "b" }, reconnected);
    expect((await again.getRun(runA.id))?.status).toBe("running");
    await expect(other.getRun(runA.id)).rejects.toThrow("not found");
    await expect(other.getRunResults(runA.id)).rejects.toThrow("not found");
    await expect(other.cancelRun(runA.id)).rejects.toThrow("not found");
    const runB = await other.startRun({ workflowId: workflowB.id, revision: workflowB.revision, target: pathsB.workspace });
    await terminal(other, runB.id, "completed");
    gate.resolve(); await terminal(again, runA.id, "completed");
    const results = await again.getRunResults(runA.id) as { retained: boolean; findings: Array<{ id: string }>; totalFindings: number };
    expect(results).toMatchObject({ retained: true, totalFindings: 1, findings: [{ id: "same-finding" }] });
    await a.restart();
    expect((await again.getRun(runA.id))?.status).toBe("completed");
    expect(await again.getRunResults(runA.id)).toMatchObject({ retained: true, totalFindings: 1 });
    expect(await again.listRuns()).toEqual(expect.arrayContaining([expect.objectContaining({ id: runA.id })]));
    await Promise.all([clientB.dispose(), again.dispose(), other.dispose()]);
  });

  it("acknowledges cancellation while running and becomes terminal only after assessment cleanup", async () => {
    const paths = location(); const cleanup = Promise.withResolvers<void>(); releaseGates.push(cleanup.resolve);
    const entered = Promise.withResolvers<void>(); const aborted = Promise.withResolvers<void>();
    const peer = await engine(paths, async options => {
      entered.resolve();
      await new Promise<void>(resolve => { if (options.signal?.aborted) resolve(); else options.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      aborted.resolve(); await cleanup.promise;
      return { report: { ...report(options.target), exitReason: "cancelled" }, rawReport: report(options.target) };
    });
    const connection = registry([{ id: "engine", ...peer }]);
    const client = await createRemoteWorkflowRuntime({ backendId: "engine" }, connection);
    const workflow = await client.saveWorkflow(definition(paths.workspace)) as { id: string; revision: number };
    const run = await client.startRun({ workflowId: workflow.id, revision: workflow.revision, target: paths.workspace });
    await entered.promise;
    const ack = await client.cancelRun(run.id) as SecurityWorkflowExecution;
    await aborted.promise;
    expect(ack).toMatchObject({ status: "running", cancellationRequested: true, cancellationAcknowledged: true, cancellationRequestedAt: expect.any(String) });
    expect(Number.isFinite(Date.parse(ack.cancellationRequestedAt!))).toBe(true);
    expect(await client.getRun(run.id)).toMatchObject({ status: "running", cancellationRequested: true, cancellationAcknowledged: true, cancellationRequestedAt: ack.cancellationRequestedAt });
    expect(await client.listRuns()).toEqual(expect.arrayContaining([expect.objectContaining({ id: run.id, status: "running", cancellationAcknowledged: true })]));
    cleanup.resolve(); await terminal(client, run.id, "cancelled");
    expect(await client.getRunResults(run.id)).toMatchObject({ retained: true, totalFindings: 1 });
    await client.dispose();
  });
});
