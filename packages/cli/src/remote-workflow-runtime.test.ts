import { describe, expect, it, vi } from "vitest";
import { createRemoteWorkflowRuntime } from "./remote-workflow-runtime.js";
import type { BackendDescriptor } from "@0/shared";
function fixture(capabilities = ["workflow-engine"]) {
  const backend: BackendDescriptor = { id: "remote", name: "Remote", transport: "http", status: "connected", protocolVersion: 1, capabilities };
  const handshake = vi.fn(async () => ({ backend }));
  const request = vi.fn(async (_id: string, _path: string, options: { body: unknown }) => {
    const call = options.body as { name: string; args: Record<string, unknown> };
    const value = call.name === "start_run" || call.name === "get_run" ? { id: "remote-run", status: "completed", nodeResults: {} } : { findings: [], nextCursor: null };
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
