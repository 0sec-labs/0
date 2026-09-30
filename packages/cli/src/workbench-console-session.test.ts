import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ launches: [] as unknown[], requests: [] as Record<string, unknown>[], output: undefined as ((data: string) => void) | undefined }));
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
        else if (frame.op === "send") { emit({ type: "event", name: "onAssistantDelta", args: ["hello"] }); emit({ type: "result", id: frame.id, value: { assistantText: "hello", stopReason: "end_turn" } }); }
      }, end() { finish(); } });
      emit({ type: "state", snapshot: { scanId: init.config.scanId, messages: [], tools: [], target: "/workspace", autonomyMode: "standard" } });
      emit({ type: "ready", platform: "linux", workspace: "/workspace" });
    });
  },
}));
import { createWorkbenchConsoleSession } from "./workbench-console-session.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); mock.launches.length = 0; mock.requests.length = 0; });
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
  it("rejects host executable resources and ungranted providers before launch", async () => {
    const input = await options(); expect(() => createWorkbenchConsoleSession({ ...input, config: { ...input.config, mcpHost: {} } as never })).toThrow("cannot execute");
    expect(() => createWorkbenchConsoleSession({ ...input, selection: { model: "ungranted" } })).toThrow("grant");
    const session = createWorkbenchConsoleSession(input); expect(() => session.reconfigureRuntime({ env: { SECRET: "host-secret" } })).toThrow("grant");
    expect(mock.launches).toHaveLength(0); await session.cleanup();
  });
});
