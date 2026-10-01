import { mkdtemp, rm, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ sendError: undefined as string | undefined, serviceConnections: [] as Array<{id:string;enabled:boolean;fields:Record<string,string>}>, pluginDirectory: undefined as string | undefined, pluginCleanup: vi.fn(async () => {}), launches: [] as unknown[], requests: [] as Record<string, unknown>[], output: undefined as ((data: string) => void) | undefined }));
vi.mock("@0/core", () => ({
  ScopePolicy: class { constructor(readonly raw: unknown) {} },
  getScopeEnforcementState: (projectPath: string) => ({ pluginId: "scope", enabled: false, projectPath, message: "disabled" }),
  runSmolvmWorkbench: (options: { signal: AbortSignal; transport: { initialInput: string; onStdout(data: string): void; onReady(input: { write(data: string): void; end(): void }): void } }) => {
    mock.launches.push(options); mock.output = options.transport.onStdout;
    const init = JSON.parse(options.transport.initialInput);
    const emit = (frame: unknown) => options.transport.onStdout(JSON.stringify(frame) + "\n");
    return new Promise(resolve => {
      const finish = () => resolve({ exitCode: 0, cleanupFailed: false, timedOut: false });
      options.signal.addEventListener("abort", finish, { once: true });
      options.transport.onReady({ write(data) {
        const frame = JSON.parse(data); mock.requests.push(frame);
        if (frame.op === "close") { emit({ type: "result", id: frame.id }); finish(); }
        else if (frame.op === "send" && mock.sendError) { emit({ type: "error", id: frame.id, error: mock.sendError }); }
        else if (frame.op === "send") { emit({ type: "event", name: "onAssistantDelta", args: ["hello"] }); emit({ type: "result", id: frame.id, value: { assistantText: "hello", stopReason: "end_turn" } }); }
      }, end() { finish(); } });
      emit({ type: "state", snapshot: { scanId: init.config.scanId, messages: [], tools: [], target: "/workspace", autonomyMode: "standard" } });
      emit({ type: "ready", platform: "linux", workspace: "/workspace" });
    });
  },
}));
vi.mock("./workbench-plugins.js", () => ({ GUEST_PLUGIN_ASSETS: "/opt/0-approved-plugins", prepareWorkbenchPlugins: async () => ({ directory: mock.pluginDirectory, approvals: { schema: 1, project: "/workspace", enabled: {} }, cleanup: mock.pluginCleanup }) }));
vi.mock("./web/service-plugins.js", () => ({ loadServicePluginConnections: () => mock.serviceConnections }));
import { createWorkbenchConsoleSession } from "./workbench-console-session.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); mock.sendError = undefined; mock.serviceConnections = []; mock.pluginDirectory = undefined; mock.pluginCleanup.mockClear(); mock.launches.length = 0; mock.requests.length = 0; });
async function options() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "0-controller-test-"))); roots.push(root);
  return { config: { workspaceRoot: root, target: root }, workbench: { schemaVersion: 1 as const, image: "/approved.tar", imageDigest: "sha256:" + "a".repeat(64), stateRoot: join(root, "state"), workspaceRoot: root, providers: ["chatgpt-codex"], github: false, cpus: 1, memoryMb: 512, storageGb: 1 }, selection: { model: "granted" }, provider: { provider: "chatgpt-codex" as const, models: ["granted"], request: vi.fn() }, network: false };
}
describe("host console VM controller", () => {
  it("starts lazily once, routes turns to guest, and uses snapshot isolation", async () => {
    const input = await options(); const session = createWorkbenchConsoleSession(input); const delta = vi.fn();
    await session.ready; session.setAutonomyMode("copilot"); expect(mock.launches).toHaveLength(0);
    expect((await session.send("message mentioning /private/host", { onAssistantDelta: delta })).assistantText).toBe("hello");
    expect(delta).toHaveBeenCalledWith("hello"); await session.send("second"); expect(mock.launches).toHaveLength(1);
    expect(mock.launches[0]).toMatchObject({ workspaceMode: "snapshot", environment: { ZERO_PROVIDER: "chatgpt-codex" }, tty: false, network: false });
    expect(mock.requests.filter(frame => frame.op === "send").map(frame => frame.text)).toEqual(["message mentioning /private/host", "second"]);
    await session.cleanup(); expect(session.execution.status).toBe("stopped");
  });
  it("mounts prepared plugin copies read-only and removes them after native cleanup", async () => {
    const input = await options(); mock.pluginDirectory = join(input.config.workspaceRoot, "plugin-assets");
    const session = createWorkbenchConsoleSession(input); await session.send("hello");
    const launch = mock.launches[0] as { readOnlyMounts: unknown; transport: { initialInput: string } };
    expect(launch.readOnlyMounts).toContainEqual({ source: mock.pluginDirectory, target: "/opt/0-approved-plugins" });
    expect(JSON.parse(launch.transport.initialInput).pluginApprovals).toEqual({ schema: 1, project: "/workspace", enabled: {} });
    expect(mock.pluginCleanup).not.toHaveBeenCalled();
    await session.cleanup(); expect(mock.pluginCleanup).toHaveBeenCalledOnce();
  });
  it("sends only explicitly enabled service credentials through stdin, outside mounts and execution snapshots", async () => {
    const input = await options(); input.network = true;
    mock.serviceConnections = [{ id: "github", enabled: true, fields: { token: "private-github-account-token" } }, { id: "slack", enabled: false, fields: { token: "disabled-slack-token" } }];
    const session = createWorkbenchConsoleSession(input); await session.send("hello");
    const launch = mock.launches[0] as Record<string, unknown> & { transport: { initialInput: string } };
    const init = JSON.parse(launch.transport.initialInput);
    expect(init.servicePluginConnections).toEqual([mock.serviceConnections[0]]);
    expect(init.servicePluginNetworkGranted).toBe(true);
    expect(JSON.stringify(init.config)).not.toContain("private-github-account-token");
    const { transport: _transport, ...publicLaunch } = launch;
    expect(JSON.stringify(publicLaunch)).not.toContain("private-github-account-token");
    expect(JSON.stringify(session.execution)).not.toContain("private-github-account-token");
    const resultRoot = join(input.workbench.stateRoot, "controller-results");
    for (const directory of await readdir(resultRoot)) expect(await readdir(join(resultRoot, directory))).toEqual([]);
    await session.cleanup();
  });
  it("refuses configured service plugins without networking before any guest launch", async () => {
    const input = await options(); mock.serviceConnections = [{ id: "github", enabled: true, fields: { token: "private-token" } }];
    const close = vi.fn(async () => {});
    const session = createWorkbenchConsoleSession({ ...input, provider: { ...input.provider, close } });
    await expect(session.send("hello")).rejects.toThrow("network grant");
    expect(close).toHaveBeenCalledOnce();
    expect(mock.launches).toHaveLength(0);
    expect(session.execution.status).toBe("failed");
    expect(JSON.stringify(session.execution)).not.toContain("private-token");
  });
  it("redacts service credentials from guest errors before exposing them to the operator", async () => {
    const input = await options(); input.network = true;
    mock.serviceConnections = [{ id: "github", enabled: true, fields: { token: "private-account-token" } }];
    const session = createWorkbenchConsoleSession(input); await session.send("hello");
    mock.sendError = "Failed token private-account-token";
    await expect(session.send("second")).rejects.toThrow("Failed token [redacted]");
    expect(JSON.stringify(session.execution)).not.toContain("private-account-token");
    await session.cleanup();
  });
  it("forwards serialized provider bodies through the exact model grant", async () => {
    const input = await options(); input.provider.request.mockResolvedValue(new Response("data: done\n\n", { headers: { "content-type": "text/event-stream" } }));
    const session = createWorkbenchConsoleSession(input); await session.send("hello");
    const body = JSON.stringify({ model: "granted", input: [] });
    mock.output!(JSON.stringify({ type: "provider", id: "provider_request_1", envelope: { provider: "chatgpt-codex", model: "granted", body } }) + "\n");
    await vi.waitFor(() => expect(input.provider.request).toHaveBeenCalledWith({ provider: "chatgpt-codex", model: "granted", body }, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(mock.requests.some(frame => frame.type === "provider-end")).toBe(true));
    await session.cleanup();
  });
  it("never imports blank chats and imports real guest results only once", async () => {
    const input = await options(); const onFindings = vi.fn();
    const blank = createWorkbenchConsoleSession({ ...input, selection: { model: "granted", agentModels: { audit: "auto" }, autoRoute: true }, onFindings });
    await blank.cleanup(); await blank.cleanup(); expect(onFindings).not.toHaveBeenCalled();
    const active = createWorkbenchConsoleSession({ ...input, onFindings }); await active.send("hello");
    await active.cleanup(); await active.cleanup(); expect(onFindings).toHaveBeenCalledTimes(1);
  });
  it("rejects host executable resources and ungranted providers before launch", async () => {
    const input = await options(); expect(() => createWorkbenchConsoleSession({ ...input, config: { ...input.config, mcpHost: {} } as never })).toThrow("cannot execute");
    expect(() => createWorkbenchConsoleSession({ ...input, selection: { model: "ungranted" } })).toThrow("grant");
    const session = createWorkbenchConsoleSession(input); expect(() => session.reconfigureRuntime({ env: { SECRET: "host-secret" } })).toThrow("grant");
    expect(mock.launches).toHaveLength(0); await session.cleanup();
  });
});
