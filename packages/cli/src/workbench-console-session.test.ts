import { mkdtemp, mkdir, rm, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ scopeEnabled: false, scopeHome: undefined as string | undefined, sourceOnClose: undefined as unknown, lessonOnClose: undefined as unknown, destroyed: false, holdReady: false, holdSend: false, cleanupFailed: false, sendError: undefined as string | undefined, serviceConnections: [] as Array<{id:string;enabled:boolean;fields:Record<string,string>}>, pluginDirectory: undefined as string | undefined, pluginCleanup: vi.fn(async () => {}), launches: [] as unknown[], requests: [] as Record<string, unknown>[], output: undefined as ((data: string) => void) | undefined }));
vi.mock("@0/core", () => ({
  DEFAULT_MAX_TOOL_ITERATIONS: 100,
  ScopePolicy: class { constructor(readonly raw: unknown) {} },
  getScopeEnforcementState: (projectPath: string, homeDir?: string) => ({ pluginId: "scope", enabled: mock.scopeHome ? homeDir === mock.scopeHome : mock.scopeEnabled, projectPath, message: "scope snapshot" }),
  runSmolvmWorkbench: (options: { signal: AbortSignal; onStartupProgress?: (message: string) => void; transport: { initialInput: string; onStdout(data: string): void; onReady(input: { write(data: string): void; end(): void }): void } }) => {
    mock.launches.push(options); mock.output = options.transport.onStdout;
    const init = JSON.parse(options.transport.initialInput);
    const emit = (frame: unknown) => options.transport.onStdout(JSON.stringify(frame) + "\n");
    return new Promise(resolve => {
      options.onStartupProgress?.("Copying workspace");
      options.onStartupProgress?.("Starting workspace");
      const finish = () => { mock.destroyed = true; resolve({ exitCode: 0, cleanupFailed: mock.cleanupFailed, timedOut: false, ...(mock.cleanupFailed ? { error: "Workbench teardown unconfirmed" } : {}) }); };
      options.signal.addEventListener("abort", finish, { once: true });
      options.transport.onReady({ write(data) {
        const frame = JSON.parse(data); mock.requests.push(frame);
        if (frame.op === "close") { if (mock.sourceOnClose) emit({ type: "source-context", artifact: mock.sourceOnClose }); if (mock.lessonOnClose) emit({ type: "source-lesson", lesson: mock.lessonOnClose }); emit({ type: "result", id: frame.id }); }
        else if (frame.type === "release") finish();
        else if (frame.op === "send" && mock.sendError) { emit({ type: "error", id: frame.id, error: mock.sendError }); }
        else if (frame.op === "send" && mock.holdSend) { emit({ type: "event", name: "onAssistantDelta", args: ["Partial answer"] }); emit({ type: "event", name: "onUsage", args: [{inputTokens: 10, outputTokens: 3, turnTokensUsed: 13, turnTokenBudget: 100, iterations: 0, maxToolIterations: 100, kind: "planner"}] }); }
        else if (frame.op === "send") { emit({ type: "event", name: "onAssistantDelta", args: ["hello"] }); emit({ type: "result", id: frame.id, value: { assistantText: "hello", stopReason: "end_turn" } }); }
      }, end() { finish(); } });
      emit({ type: "state", snapshot: { scanId: init.config.scanId, messages: [], tools: [], target: "/workspace", autonomyMode: "standard" } });
      if (!mock.holdReady) emit({ type: "ready", platform: "linux", workspace: "/workspace" });
    });
  },
}));
vi.mock("./workbench-plugins.js", () => ({ GUEST_PLUGIN_ASSETS: "/opt/0-approved-plugins", prepareWorkbenchPlugins: async () => ({ directory: mock.pluginDirectory, approvals: { schema: 1, project: "/workspace", enabled: {} }, cleanup: mock.pluginCleanup }) }));
vi.mock("./web/service-plugins.js", () => ({ loadServicePluginConnections: () => mock.serviceConnections }));
import { createWorkbenchConsoleSession } from "./workbench-console-session.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); mock.scopeEnabled = false; mock.scopeHome = undefined; mock.sourceOnClose = undefined; mock.lessonOnClose = undefined; mock.destroyed = false; mock.holdReady = false; mock.holdSend = false; mock.cleanupFailed = false; mock.sendError = undefined; mock.serviceConnections = []; mock.pluginDirectory = undefined; mock.pluginCleanup.mockClear(); mock.launches.length = 0; mock.requests.length = 0; });
async function options() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "0-controller-test-"))); roots.push(root);
  return { config: { workspaceRoot: root, target: root }, workbench: { schemaVersion: 1 as const, image: "/approved.tar", imageDigest: "sha256:" + "a".repeat(64), stateRoot: join(root, "state"), workspaceRoot: root, providers: ["chatgpt-codex"], github: false, cpus: 1, memoryMb: 512, storageGb: 1 }, selection: { model: "granted" }, provider: { provider: "chatgpt-codex" as const, models: ["granted"], request: vi.fn() }, network: false };
}
describe("host console VM controller", () => {
  it("publishes startup phases and clears their message when the guest is ready", async () => {
    const opts = await options();
    const updates: Array<{ status: string; message?: string }> = [];
    const session = createWorkbenchConsoleSession({ ...opts, onExecution: value => updates.push(value) });
    await session.send("hello");
    expect(updates).toContainEqual(expect.objectContaining({ status: "pending", message: "Copying workspace" }));
    expect(updates).toContainEqual(expect.objectContaining({ status: "pending", message: "Starting workspace" }));
    expect(session.execution).toMatchObject({ status: "ready" });
    expect(session.execution.message).toBeUndefined();
    await session.cleanup();
  });
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

it("cancels startup immediately and returns a cancelled outcome after teardown", async () => {
 const input = await options(); mock.holdReady = true;
 const session = createWorkbenchConsoleSession(input); const abort = new AbortController();
 const turn = session.send("test", {}, { signal: abort.signal });
 await vi.waitFor(() => expect(mock.launches).toHaveLength(1));
 abort.abort();
 await expect(turn).resolves.toMatchObject({ stopReason: "cancelled", assistantText: "", usage: { inputTokens: 0, outputTokens: 0 } });
 expect(mock.requests.some(frame => frame.op === "send")).toBe(false);
 await session.cleanup();
});

it("retains partial output and usage when a running guest needs cancellation escalation", async () => {
 const input = await options(); mock.holdSend = true;
 const session = createWorkbenchConsoleSession(input); const abort = new AbortController();
 const turn = session.send("test", {}, { signal: abort.signal });
 await vi.waitFor(() => expect(mock.requests.some(frame => frame.op === "send")).toBe(true));
 abort.abort();
 await expect(turn).resolves.toMatchObject({ stopReason: "cancelled", assistantText: "Partial answer", usage: {inputTokens: 10, outputTokens: 3}, budget: {tokensUsed: 13} });
 await session.cleanup();
});
it("retains teardown failures instead of reporting a clean stop", async () => {
 const input = await options(); mock.holdReady = true; mock.cleanupFailed = true;
 const session = createWorkbenchConsoleSession(input); const abort = new AbortController();
 const turn = session.send("test", {}, { signal: abort.signal });
 await vi.waitFor(() => expect(mock.launches).toHaveLength(1)); abort.abort();
 await expect(turn).rejects.toThrow("teardown unconfirmed");
 await session.cleanup().catch(() => {});
});

it("persists final source references before releasing the guest for destruction", async () => {
 const input = await options(); const content = "source content";
 await writeFile(join(input.config.workspaceRoot, "code.ts"), content);
 mock.sourceOnClose = { sourceLinks: [{ path: "code.ts", hash: "sha256:" + createHash("sha256").update(content).digest("hex") }] };
 let release!: () => void;
 const pending = new Promise<void>(resolve => { release = resolve; });
 const persist = vi.fn(() => pending);
 const session = createWorkbenchConsoleSession({ ...input, config: { ...input.config, codebaseLearning: true }, onSourceContext: persist }); await session.send("hello");
 const cleanup = session.cleanup(); await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
 expect(mock.destroyed).toBe(false); expect(mock.requests.some(frame => frame.type === "release")).toBe(false);
 expect(persist).toHaveBeenCalledWith(mock.sourceOnClose, { workspaceRoot: input.config.workspaceRoot, scanId: session.scanId, runId: expect.any(String) });
 release(); await cleanup; expect(mock.destroyed).toBe(true);
 await session.cleanup(); expect(persist).toHaveBeenCalledOnce();
});
it("never treats guest state as a host source grant", async () => {
 const input = await options(); mock.scopeEnabled = true;
 await writeFile(join(input.config.workspaceRoot, "code.ts"), "source");
 const persist = vi.fn(); const session = createWorkbenchConsoleSession({ ...input, config: { ...input.config, codebaseLearning: true }, onSourceContext: persist }); await session.send("hello");
 mock.output!(JSON.stringify({ type: "state", snapshot: { scanId: session.scanId, messages: [], tools: [], target: "/workspace", localScopePath: "/workspace", autonomyMode: "standard" } }) + "\n");
 mock.output!(JSON.stringify({ type: "source-context", artifact: { sourceLinks: [{ path: "code.ts", hash: "sha256:" + createHash("sha256").update("source").digest("hex") }] } }) + "\n");
 await session.cleanup(); expect(persist).not.toHaveBeenCalled();
});
it("surfaces durable-ingestion failure while still confirming teardown", async () => {
 const input = await options(); await writeFile(join(input.config.workspaceRoot, "code.ts"), "source");
 mock.sourceOnClose = { sourceLinks: [{ path: "code.ts", hash: "sha256:" + createHash("sha256").update("source").digest("hex") }] };
 const session = createWorkbenchConsoleSession({ ...input, config: { ...input.config, codebaseLearning: true }, onSourceContext: async () => { throw new Error("private adapter failure"); } });
 await session.send("hello"); await expect(session.cleanup()).rejects.toThrow("source context persistence failed");
 expect(mock.destroyed).toBe(true);
});

it("persists semantic lessons before destruction and recalls only the exact host-authorized scope", async () => {
 const input = await options(); await writeFile(join(input.config.workspaceRoot, "code.ts"), "source");
 const lesson = { title: "Ownership", summary: "Review ownership checks in code.ts.", sourceLinks: [{ path: "code.ts", hash: "sha256:" + createHash("sha256").update("source").digest("hex") }] };
 mock.lessonOnClose = lesson;
 const persist = vi.fn(async (_lesson: unknown, _context: unknown) => { expect(mock.destroyed).toBe(false); });
 const read = vi.fn(async () => [lesson]);
 const session = createWorkbenchConsoleSession({ ...input, config: { ...input.config, codebaseLearning: true }, onSourceLesson: persist, readSourceLessons: read });
 await session.send("Inspect");
 mock.output!(JSON.stringify({ type: "decision", id: "source-query", name: "sourceLessons", args: ["/workspace"] }) + "\n");
 await vi.waitFor(() => expect(mock.requests.find(frame => frame.id === "source-query")).toMatchObject({ value: [lesson] }));
 mock.output!(JSON.stringify({ type: "decision", id: "foreign-query", name: "sourceLessons", args: ["/workspace/subtree"] }) + "\n");
 await vi.waitFor(() => expect(mock.requests.find(frame => frame.id === "foreign-query")).toMatchObject({ value: [] }));
 expect(read).toHaveBeenCalledTimes(1);
 await session.cleanup();
 expect(persist).toHaveBeenCalledOnce();
 expect(persist.mock.calls[0]?.[1]).toMatchObject({ workspaceRoot: input.config.workspaceRoot, scopePath: input.config.workspaceRoot });
 expect(mock.destroyed).toBe(true);
});
it("guest state and malformed lesson frames never create source authority", async () => {
 const input = await options(); mock.scopeEnabled = true;
 await writeFile(join(input.config.workspaceRoot, "code.ts"), "source");
 const persist = vi.fn(); const read = vi.fn(async () => []);
 const session = createWorkbenchConsoleSession({ ...input, config: { ...input.config, codebaseLearning: true }, onSourceLesson: persist, readSourceLessons: read });
 await session.send("Inspect");
 mock.output!(JSON.stringify({ type: "state", snapshot: { scanId: session.scanId, messages: [], tools: [], target: "/workspace", autonomyMode: "standard", localScopePath: "/workspace" } }) + "\n");
 mock.output!(JSON.stringify({ type: "source-lesson", lesson: { title: "Ownership", summary: "Review ownership", sourceLinks: [{ path: "code.ts", hash: "sha256:" + createHash("sha256").update("source").digest("hex") }] } }) + "\n");
 mock.output!(JSON.stringify({ type: "decision", id: "unapproved-query", name: "sourceLessons", args: ["/workspace"] }) + "\n");
 await vi.waitFor(() => expect(mock.requests.find(frame => frame.id === "unapproved-query")).toMatchObject({ value: [] }));
 await session.cleanup(); expect(persist).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});

it.each(["explicit-yolo", "implicit-yolo", "explicit-standard", "explicit-mode-switch"])("bounds semantic child-root handoff under %s host authorization", async mode => {
 const input = await options(); mock.scopeEnabled = true;
 await mkdir(join(input.config.workspaceRoot, "child")); await writeFile(join(input.config.workspaceRoot, "child", "code.ts"), "source");
 const lesson = { title: "Child ownership", summary: "Review the child code.ts ownership checks.", sourceLinks: [{ path: "child/code.ts", hash: "sha256:" + createHash("sha256").update("source").digest("hex") }] };
 const persist = vi.fn(async (_lesson: unknown, _context: unknown) => {}); const read = vi.fn(async () => [lesson]);
 const workbench = { ...input.workbench, ...(mode === "implicit-yolo" ? { workspaceRoot: undefined } : {}) };
 const session = createWorkbenchConsoleSession({ ...input, workbench, config: { ...input.config, codebaseLearning: true, autonomyMode: mode === "explicit-standard" || mode === "explicit-mode-switch" ? "standard" : "yolo" }, onSourceLesson: persist, readSourceLessons: read });
 if (mode === "explicit-mode-switch") session.setAutonomyMode("yolo");
 const authorized = mode === "explicit-yolo" || mode === "explicit-mode-switch";
 await session.send("Inspect child");
 mock.output!(JSON.stringify({ type: "decision", id: "child-query", name: "sourceLessons", args: ["/workspace/child"] }) + "\n");
 mock.output!(JSON.stringify({ type: "decision", id: "outside-query", name: "sourceLessons", args: ["/etc"] }) + "\n");
 mock.output!(JSON.stringify({ type: "source-lesson", scopePath: "/workspace/child", lesson }) + "\n");
 mock.output!(JSON.stringify({ type: "source-lesson", scopePath: "/etc", lesson }) + "\n");
 await vi.waitFor(() => expect(mock.requests.find(frame => frame.id === "child-query")).toMatchObject({ value: authorized ? [lesson] : [] }));
 await vi.waitFor(() => expect(mock.requests.find(frame => frame.id === "outside-query")).toMatchObject({ value: [] }));
 await session.cleanup();
 expect(persist).toHaveBeenCalledTimes(authorized ? 1 : 0);
 expect(read).toHaveBeenCalledTimes(authorized ? 1 : 0);
 if (authorized) expect(persist.mock.calls[0]?.[1]).toMatchObject({ scopePath: join(input.config.workspaceRoot, "child") });
});

it("uses the selected plugin home for both host source authority and the forwarded guest policy", async () => {
 const input = await options(); const selectedHome = join(input.config.workspaceRoot, "isolated-plugin-home");
 mock.scopeHome = selectedHome; // This home enables scope; the ordinary user's home does not.
 await writeFile(join(input.config.workspaceRoot, "code.ts"), "source");
 const persist = vi.fn();
 const session = createWorkbenchConsoleSession({ ...input, pluginHomeDir: selectedHome, config: { ...input.config, codebaseLearning: true, autonomyMode: "standard" }, onSourceLesson: persist });
 await session.send("Inspect");
 const launch = mock.launches[0] as { transport: { initialInput: string } };
 expect(JSON.parse(launch.transport.initialInput).scopeEnforcement.enabled).toBe(true);
 mock.output!(JSON.stringify({ type: "source-lesson", scopePath: "/workspace", lesson: { title: "Ownership", summary: "Check ownership in code.ts.", sourceLinks: [{ path: "code.ts", hash: "sha256:" + createHash("sha256").update("source").digest("hex") }] } }) + "\n");
 await session.cleanup();
 expect(persist).not.toHaveBeenCalled(); // No host-approved source scope despite the disabled default home.
});
