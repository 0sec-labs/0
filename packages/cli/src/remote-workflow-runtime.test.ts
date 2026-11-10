import { describe, expect, it, vi } from "vitest";
import { createRemoteWorkflowRuntime } from "./remote-workflow-runtime.js";
import type { BackendDescriptor } from "@0/shared";
function fixture(capabilities = ["workflow-engine"]) {
  const backend: BackendDescriptor = { id: "remote", name: "Remote", transport: "http", status: "connected", protocolVersion: 1, capabilities };
  const handshake = vi.fn(async () => ({ backend }));
  const request = vi.fn(async (_id: string, _path: string, options: { body: unknown }) => {
    const call = options.body as { name: string; args: Record<string, unknown> };
    const value = call.name === "attach_session" ? { session: { id: call.args.sessionId, status: "ready" } } : call.name === "start_assessment" || call.name === "start_run" || call.name === "get_run" ? { id: "remote-run", status: "completed", nodeResults: {} } : { findings: [], nextCursor: null };
    return Response.json(value);
  });
  return { handshake, request };
}
describe("remote workflow client", () => {
  it("keeps backend targets and input references unchanged and never sends client ownership or model credentials", async () => {
    const registry = fixture();
    const client = await createRemoteWorkflowRuntime({ backendId: "remote" }, registry);
    const inputs = { findingPath: "D:\\evidence\\finding.json" };
    await client.startRun({ templateId: "repository-review", target: "D:\\engine\\repo", inputs, allowApply: true });
    expect(registry.request).toHaveBeenCalledWith("remote", "/api/workflow-engine/call", expect.objectContaining({ body: { name: "start_run", args: { templateId: "repository-review", target: "D:\\engine\\repo", inputs, allowApply: true } } }));
    await client.getRun("remote-run"); await client.getRunResults("remote-run", { cursor: 100, limit: 10 }); await client.cancelRun("remote-run");
    expect(registry.request.mock.calls.map(call => (call[2].body as { name: string }).name)).toEqual(["start_run", "get_run", "get_run_results", "cancel_run"]);
    const previous = registry.request.mock.calls.length;
    await client.dispose();
    expect(registry.request).toHaveBeenCalledTimes(previous);
    await expect(client.listTemplates()).rejects.toThrow("closed");
  });
  it("attaches existing web sessions and preserves lifecycle ownership when the client detaches", async () => {
    const registry = fixture();
    const client = await createRemoteWorkflowRuntime({ backendId: "remote", sessionId: "web-session" }, registry);
    await client.startRun({ templateId: "review", target: "/repo" });
    await client.continueSession("web-session", "continue");
    await client.resolveDecision("web-session", "decision-1", { approved: true });
    await client.dispose();
    expect(registry.request.mock.calls.map(call => call[2].body)).toEqual([
      { name: "attach_session", args: { sessionId: "web-session" } },
      { name: "start_run", args: { templateId: "review", target: "/repo", sessionId: "web-session" } },
      { name: "continue_session", args: { sessionId: "web-session", text: "continue" } },
      { name: "resolve_decision", args: { sessionId: "web-session", decisionId: "decision-1", response: { approved: true } } },
    ]);
  });
  it("does not recreate missing web sessions and rejects ambiguous direct attachment", async () => {
    const registry = fixture();
    registry.request.mockResolvedValueOnce(Response.json(null));
    await expect(createRemoteWorkflowRuntime({ backendId: "remote", sessionId: "gone" }, registry)).rejects.toThrow("no longer exists");
    expect(registry.request).toHaveBeenCalledTimes(1);
    await expect(createRemoteWorkflowRuntime({ backendId: "remote", engineUrl: "http://127.0.0.1:3000", engineTokenEnv: "TOKEN" }, registry)).rejects.toThrow("cannot be combined");
    await expect(createRemoteWorkflowRuntime({ engineUrl: "http://127.0.0.1:3000" }, registry)).rejects.toThrow("requires both");
  });
  it("sends structured plans to the web-owned engine session", async () => {
    const registry = fixture();
    const client = await createRemoteWorkflowRuntime({ backendId: "remote", sessionId: "web-session" }, registry);
    const plan = { goal: "unknown-vulnerabilities" as const, depth: "deep" as const, runCount: 2, executionMode: "parallel" as const, timeCapMs: 1000, costCapUsd: 1 };
    expect(await client.startAssessment({ target: "/engine/repo", plan })).toMatchObject({ id: "remote-run", status: "completed" });
    expect(registry.request).toHaveBeenLastCalledWith("remote", "/api/workflow-engine/call", expect.objectContaining({ body: { name: "start_assessment", args: { sessionId: "web-session", target: "/engine/repo", plan } } }));
    await client.dispose();
  });
  it("resolves stable saved aliases against existing live workers without restoring or creating sessions", async () => {
    const registry = fixture();
    let live = "live-one";
    registry.request.mockImplementation(async (_backend, path, options) => {
      const call = options.body as { name?: string; args?: Record<string, unknown> } | undefined;
      if (path === "/api/workflow-engine/call") {
        if (call?.name === "list_sessions") return Response.json([{ id: "saved-chat", status: "closed" }, { id: live, savedId: "saved-chat", status: "ready" }]);
        if (call?.name === "attach_session") return call.args?.sessionId === "saved-chat"
          ? Response.json({ session: { id: "saved-chat", status: "closed" } })
          : call.args?.sessionId === live
            ? Response.json({ session: { id: live, savedId: "saved-chat", status: "ready" } })
            : Response.json({ error: "Console session was not found." }, { status: 404 });
        throw new Error("Unexpected lifecycle mutation");
      }
      if (path === `/api/console/sessions/${live}/workers`) return Response.json({ workers: [{ id: "worker/one", status: "running" }] });
      return Response.json({ worker: { id: "worker/one", status: "stopped" } });
    });
    const client = await createRemoteWorkflowRuntime({ backendId: "remote", sessionId: "saved-chat" }, registry);
    expect(await client.listSessionWorkers("saved-chat")).toEqual({ workers: [{ id: "worker/one", status: "running" }] });
    expect(await client.getSessionWorker("saved-chat", "worker/one")).toMatchObject({ worker: { id: "worker/one" } });
    live = "live-two";
    await client.sendSessionWorkerMessage("saved-chat", "worker/one", "Summarize existing evidence only");
    await client.stopSessionWorker("live-two", "worker/one");
    expect(registry.request.mock.calls.filter(call => call[1] !== "/api/workflow-engine/call").map(call => [call[1], call[2]])).toEqual([
      ["/api/console/sessions/live-one/workers", expect.objectContaining({ method: "GET", body: undefined })],
      ["/api/console/sessions/live-one/workers", expect.objectContaining({ method: "GET", body: undefined })],
      ["/api/console/sessions/live-two/workers/worker%2Fone/messages", expect.objectContaining({ method: "POST", body: { text: "Summarize existing evidence only" } })],
      ["/api/console/sessions/live-two/workers/worker%2Fone/stop", expect.objectContaining({ method: "POST", body: {} })],
    ]);
    await expect(client.getSessionWorker("saved-chat", "foreign-worker")).rejects.toThrow("does not belong");
    await expect(client.listSessionWorkers("missing-session")).rejects.toThrow("not found");
    await client.sendSessionWorkerMessage("saved-chat", "worker/one", "x".repeat(8000));
    expect(registry.request).toHaveBeenLastCalledWith("remote", "/api/console/sessions/live-two/workers/worker%2Fone/messages", expect.objectContaining({ body: { text: "x".repeat(8000) } }));
    const calls = registry.request.mock.calls.length;
    await expect(client.sendSessionWorkerMessage("saved-chat", "worker/one", "x".repeat(8001))).rejects.toThrow();
    await expect(client.stopSessionWorker("saved-chat", "stop")).rejects.toThrow("Invalid worker");
    await expect(client.stopSessionWorker("saved-chat", " stop ")).rejects.toThrow("Invalid worker");
    await expect(client.stopSessionWorker("..", "worker-1")).rejects.toThrow("Invalid identifier");
    expect(registry.request).toHaveBeenCalledTimes(calls);
    await client.dispose();
    await expect(client.listSessionWorkers("saved-chat")).rejects.toThrow("closed");
  });
  it("does not mask authorization errors with alias discovery", async () => {
    const registry = fixture();
    registry.request.mockImplementation(async () => Response.json({ error: "Not authorized for this session" }, { status: 403 }));
    const client = await createRemoteWorkflowRuntime({ backendId: "remote" }, registry);
    await expect(client.listSessionWorkers("private-session")).rejects.toThrow("Not authorized for this session");
    expect(registry.request).toHaveBeenCalledTimes(1);
    await client.dispose();
  });

  it("requires engine capability and never falls back to a local runtime", async () => {
    const registry = fixture(["workflows"]);
    await expect(createRemoteWorkflowRuntime({ backendId: "remote" }, registry)).rejects.toThrow("does not support workflow-engine");
    expect(registry.request).not.toHaveBeenCalled();
  });
  it("rejects caller model overrides and reports backend admission errors", async () => {
    const registry = fixture();
    const client = await createRemoteWorkflowRuntime({ backendId: "remote" }, registry);
    await expect(client.startRun({ templateId: "review", target: "/remote", model: "local-provider-model" })).rejects.toThrow("owns its configured model");
    expect(registry.request).not.toHaveBeenCalled();
    registry.request.mockResolvedValueOnce(Response.json({ error: "Backend scope denied this target" }, { status: 403 }));
    await expect(client.startRun({ templateId: "review", target: "/remote" })).rejects.toThrow("scope denied");
    await client.dispose();
  });
});

describe("operator-only force stop", () => {
  it("uses the existing owner route for an exact live session and preserves its result", async () => {
    const registry = fixture();
    const result = { session: { id: "live-session", status: "ready", messageCount: 7 } };
    registry.request.mockImplementation(async (_id, path, options) => path === "/api/workflow-engine/call"
      ? Response.json({ session: { id: "live-session", status: "cancelling" } }) : Response.json(result));
    const client = await createRemoteWorkflowRuntime({ backendId: "remote" }, registry);
    expect(await client.forceStopSession("live-session")).toEqual(result);
    expect(registry.request.mock.calls.map(call => [call[1], call[2].body])).toEqual([
      ["/api/workflow-engine/call", { name: "attach_session", args: { sessionId: "live-session" } }],
      ["/api/console/sessions/live-session/force-stop", {}],
    ]);
    await client.dispose();
  });
  it.each([403, 404, 409])("propagates owner route HTTP %s without retry, cooperative fallback, or replay", async status => {
    const registry = fixture();
    registry.request.mockImplementation(async (_id, path) => path === "/api/workflow-engine/call"
      ? Response.json({ session: { id: "live-session", status: "working" } }) : Response.json({ error: "Owned force stop unavailable or unconfirmed" }, { status }));
    const client = await createRemoteWorkflowRuntime({ backendId: "remote" }, registry);
    await expect(client.forceStopSession("live-session")).rejects.toMatchObject({ status, message: "Owned force stop unavailable or unconfirmed" });
    expect(registry.request).toHaveBeenCalledTimes(2);
    await client.dispose();
  });
  it.each([403, 404])("does not recover saved aliases or mask preflight HTTP %s", async status => {
    const registry = fixture(); registry.request.mockResolvedValue(Response.json({ error: "Exact session unavailable" }, { status }));
    const client = await createRemoteWorkflowRuntime({ backendId: "remote" }, registry);
    await expect(client.forceStopSession("saved-chat")).rejects.toMatchObject({ status });
    expect(registry.request).toHaveBeenCalledOnce(); await client.dispose();
  });
  it.each([{ id: "other-live", status: "working" }, { id: "selected", status: "closed" }])("refuses a changed or closed identity before mutation: %j", async session => {
    const registry = fixture(); registry.request.mockResolvedValue(Response.json({ session }));
    const client = await createRemoteWorkflowRuntime({ backendId: "remote" }, registry);
    await expect(client.forceStopSession("selected")).rejects.toThrow("exact open live session");
    expect(registry.request).toHaveBeenCalledOnce(); await client.dispose();
  });
  it("validates IDs and does not retry an ambiguous transport failure", async () => {
    const registry = fixture();
    const client = await createRemoteWorkflowRuntime({ backendId: "remote" }, registry);
    for (const id of ["", "..", " live ", "live/other", "live\\other", "live\nother"]) await expect(client.forceStopSession(id)).rejects.toThrow();
    expect(registry.request).not.toHaveBeenCalled();
    registry.request.mockImplementation(async (_id, path) => {
      if (path === "/api/workflow-engine/call") return Response.json({ session: { id: "live", status: "working" } });
      throw new Error("Connection interrupted after request dispatch");
    });
    await expect(client.forceStopSession("live")).rejects.toThrow("Connection interrupted");
    expect(registry.request).toHaveBeenCalledTimes(2); await client.dispose();
  });
  it.each([true, false])("retains registry bearer/identity and gates sessions capability (%s)", async sessions => {
    const { BackendConnectionRegistry } = await import("./web/backend-connections.js");
    const token = "a".repeat(32);
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
      expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${token}`);
      const path = new URL(String(url)).pathname;
      if (path === "/api/backend/handshake") return Response.json({ protocolVersion: 1, engineId: "engine-operator", capabilities: ["workflow-engine", ...(sessions ? ["sessions"] : [])], platform: { os: "linux", pathStyle: "posix" } });
      expect(new Headers(options?.headers).get("x-0-expected-engine-id")).toBe("engine-operator");
      expect(options?.redirect).toBe("error");
      return Response.json({ session: { id: "live", status: path.endsWith("force-stop") ? "ready" : "working" } }, { headers: { "X-0-Engine-ID": "engine-operator" } });
    });
    const registry = new BackendConnectionRegistry({ connections: [{ id: "remote", name: "Remote", url: "http://127.0.0.1:12345/", bearerTokenEnv: "OPERATOR_TOKEN" }], env: { OPERATOR_TOKEN: token }, fetch });
    try {
      const client = await createRemoteWorkflowRuntime({ backendId: "remote" }, registry);
      if (sessions) {
        expect(await client.forceStopSession("live")).toMatchObject({ session: { id: "live", status: "ready" } });
        expect(fetch).toHaveBeenCalledTimes(3); expect(String(fetch.mock.calls[2]![1]?.body)).toBe("{}");
      } else {
        await expect(client.forceStopSession("live")).rejects.toThrow("does not support sessions");
        expect(fetch).toHaveBeenCalledTimes(2);
      }
      await client.dispose();
    } finally { registry.dispose(); }
  });
});
