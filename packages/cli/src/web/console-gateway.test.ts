import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsoleSession, eventBus, type ConsoleSession, type ConsoleTurnOutcome, type NativeMessage, type ToolCall } from "@0/engine";
import { LearningStore, SecurityWorkflowStore } from "@0/engine/storage";
import { estimateCost } from "@0/engine/shared";
import { ConsoleGateway, ConsoleGatewayError, CONSOLE_CANCELLATION_TIMEOUT_MS, type ConsoleGatewaySessionFactoryInput, type ConsoleExecutionContext } from "./console-gateway.js";
import { SkillsStore } from "./skills.js";
import { loadSession, saveSession } from "../state/session-store.js";

const isolated = vi.hoisted(() => ({
  inbox: [] as Array<{ id: string; from: string }>,
  profile: "local" as "local" | "smolvm",
  localFactory: vi.fn(),
  runtimeFactory: vi.fn(),
  applyRuntime: vi.fn(),
  reloadConnection: vi.fn(),
  pluginManager: vi.fn(),
  flushPlugins: vi.fn(),
}));
vi.mock("@0/engine", async (importOriginal) => ({ ...await importOriginal<typeof import("@0/engine")>(), peekInbox: () => isolated.inbox }));
vi.mock("../console-mcp.js", () => ({ connectConsoleMcp: async () => undefined }));
vi.mock("../console-execution.js", () => ({ consoleExecutionProfile: () => isolated.profile }));
vi.mock("../console-session.js", () => ({ createLocalConsoleSession: (...args: unknown[]) => isolated.localFactory(...args) }));
vi.mock("./operator-services.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./operator-services.js")>(),
  createWebConsoleRuntime: (...args: unknown[]) => isolated.runtimeFactory(...args),
  applyWebConsoleRuntimeSelection: (...args: unknown[]) => isolated.applyRuntime(...args),
  reloadWebConsoleRuntimeConnection: (...args: unknown[]) => isolated.reloadConnection(...args),
  getWebConsolePluginHostManager: (...args: unknown[]) => isolated.pluginManager(...args),
  flushWebConsolePlugins: (...args: unknown[]) => isolated.flushPlugins(...args),
}));
beforeEach(() => {
  isolated.inbox = [];
  isolated.profile = "local";
  isolated.localFactory.mockReset(); isolated.runtimeFactory.mockReset();
  isolated.applyRuntime.mockReset(); isolated.reloadConnection.mockReset(); isolated.pluginManager.mockReset();
  isolated.flushPlugins.mockReset().mockResolvedValue([]);
});

const gateways: ConsoleGateway[] = [];
const homes: string[] = [];
function outcome(text = "Finished."): ConsoleTurnOutcome {
  return { assistantText: text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, budget: { tokensUsed: 15, tokenBudget: Infinity, iterations: 1, maxToolIterations: 100 }, stopReason: "end_turn" };
}
function engine(input: ConsoleGatewaySessionFactoryInput): ConsoleSession {
  const messages: NativeMessage[] = structuredClone(input.initialMessages ?? []);
  let currentMode = input.autonomyMode;
  let currentSearch = input.webSearchEnabled;
  let currentWorkerPolicy = input.workerPolicy;
  let currentTarget = input.target;
  let currentScope = input.scope;
  let currentFolder: string | undefined;
  return {
    get workerPolicy() { return currentWorkerPolicy; },
    setWorkerPolicy: policy => { currentWorkerPolicy = structuredClone(policy); },
    scanId: input.scanId, ready: Promise.resolve(), systemPrompt: "Fixture", tools: [], messages,
    get autonomyMode() { return currentMode; }, get target() { return currentTarget; }, get scope() { return currentScope; },
    scopeEnforcement: { pluginId: "scope", enabled: true, projectPath: "/fixture", message: "Scope authorization enabled" }, get localScopePath() { return currentFolder; },
    configureWorkspace: path => { currentFolder = path; },
    get webSearchEnabled() { return currentSearch; },
    setWebSearchEnabled: (enabled) => { currentSearch = enabled; },
    setAutonomyMode: (mode) => { currentMode = mode; }, reconfigureRuntime: () => undefined,
    configureEngagement: (selection) => {
      if (selection.target !== undefined) currentTarget = selection.target;
      if (selection.scope !== undefined) currentScope = selection.scope ?? undefined;
    },
    clearConversation: () => { messages.splice(0); }, stopPersistentAgent: async () => true, stopPersistentAgents: async () => undefined,
    exportCheckpoint: () => { throw new Error("Fixture has no executable checkpoint"); }, prepareHandoff: async () => ({}), cleanup: async () => undefined,
    async send(text, callbacks, options) {
      messages.push({ role: "user", content: [{ type: "text", text }, ...(options?.images ?? []).map(image => ({ type: "image" as const, ...image }))] });
      callbacks?.onAssistantDelta?.("Partial.");
      messages.push({ role: "assistant", content: [{ type: "text", text: "Complete final text." }] });
      return outcome("Complete final text.");
    },
  };
}
function gateway(createSession: (input: ConsoleGatewaySessionFactoryInput) => ConsoleSession | Promise<ConsoleSession> = engine): ConsoleGateway {
  const home = mkdtempSync(join(tmpdir(), "0-web-gateway-test-")); homes.push(home);
  let id = 0;
  const instance = new ConsoleGateway({ homeDir: home, projectPath: "/fixture", createSession, createId: () => `session-${homes.length}-${++id}`, now: () => new Date("2026-09-30T00:00:00Z") });
  gateways.push(instance); return instance;
}
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((instance) => instance.closeAll()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function idle(instance: ConsoleGateway, id: string): Promise<void> {
  await vi.waitFor(() => expect(instance.get(id).session.status).toBe("ready"));
}

describe("ConsoleGateway", () => {
  it("forwards operator worker ceilings, reads them back, and retains restrictions on resume", async () => {
    const factory = vi.fn(engine);
    const instance = gateway(factory);
    const policy = { allowedTools: ["http_request"], allowedHttpMethods: ["GET" as const], maxTurns: 12 };
    const chat = instance.create({ workerPolicy: policy });
    await instance.send(chat.id, "Inspect only."); await idle(instance, chat.id);
    expect(factory.mock.calls[0]![0].workerPolicy).toEqual(policy);
    expect(instance.get(chat.id).session.workerPolicy).toEqual(policy);
    eventBus.emit("subagent_lifecycle", { agent_id: `${chat.id}-policy-worker`, parent_scan_id: chat.id, status: "running", task: "Inspect", max_turns: 3 });
    await expect(instance.configure(chat.id, { workerPolicy: { maxTurns: 1 } })).rejects.toThrow("Finish active agents");
    eventBus.emit("subagent_lifecycle", { agent_id: `${chat.id}-policy-worker`, parent_scan_id: chat.id, status: "completed", task: "Inspect", max_turns: 3 });
    const saved = instance.save(chat.id);
    expect(loadSession(saved.id, homes.at(-1))?.consoleState?.configuration?.workerPolicy).toEqual(policy);
    await instance.close(chat.id);
    const resumed = await instance.resume(saved.id, { workerPolicy: { allowedTools: ["http_request", "run_command"], allowedHttpMethods: ["GET", "POST"], maxTurns: 30 } });
    expect(factory.mock.calls.at(-1)![0].workerPolicy).toEqual(policy);
    expect(resumed).toMatchObject({ workerPolicy: policy, scopeConfigured: false, autonomyMode: "standard" });
    const tighter = { allowedTools: [], allowedHttpMethods: [], maxTurns: 2 };
    await instance.configure(resumed.id, { workerPolicy: tighter });
    expect(instance.get(resumed.id).session.workerPolicy).toEqual(tighter);
    expect((await instance.resume(saved.id, { workerPolicy: policy })).workerPolicy).toEqual(tighter);
  });

  it("rejects malformed worker ceilings and changes during execution", async () => {
    const instance = gateway();
    for (const policy of [null, { maxTurns: 0 }, { maxTurns: 1.5 }, { maxTurns: 10001 }, { allowedTools: [""] }, { allowedTools: ["http_request", "http_request"] }, { allowedHttpMethods: ["get"] }, { allowedHttpMethods: ["GET", "GET"] }, { arbitrary: true }]) {
      expect(() => instance.create({ workerPolicy: policy })).toThrow(ConsoleGatewayError);
    }
    let release!: () => void;
    const busy = gateway(input => ({ ...engine(input), send: async () => { await new Promise<void>(resolve => { release = resolve; }); return outcome(); } }));
    const chat = busy.create({});
    await busy.send(chat.id, "Wait");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(busy.configure(chat.id, { workerPolicy: { maxTurns: 2 } })).rejects.toThrow(/current turn/);
    release(); await idle(busy, chat.id);
    await expect(busy.configure(chat.id, { workerPolicy: { unknown: true } })).rejects.toThrow("Invalid worker policy");
  });

  it("prices worker deltas using their actual model and cache receipt", async () => {
    const child = { inputTokens: 10_000, outputTokens: 100, cachedInputTokens: 9_000, cacheWriteTokens: 500 };
    const parent = { inputTokens: 200, outputTokens: 20 };
    const instance = gateway(input => {
      const base = engine(input);
      return { ...base, async send(text, callbacks, options) {
        callbacks?.onUsage?.({ ...child, kind: "worker", model: "gpt-4.1", turnTokensUsed: 10_100, turnTokenBudget: Infinity, iterations: 1, maxToolIterations: 100 });
        callbacks?.onUsage?.({ ...parent, kind: "planner", model: "gpt-4o", turnTokensUsed: 10_320, turnTokenBudget: Infinity, iterations: 1, maxToolIterations: 100 });
        return base.send(text, callbacks, options);
      } };
    });
    const chat = instance.create({});
    await instance.send(chat.id, "Review with one worker."); await idle(instance, chat.id);
    expect(instance.get(chat.id).usage).toMatchObject({
      inputTokens: 10_200, outputTokens: 120, costUnavailable: false, costKind: "estimated",
    });
    expect(instance.get(chat.id).usage.costUsd).toBeCloseTo(estimateCost(child, "gpt-4.1") + estimateCost(parent, "gpt-4o"), 12);
  });

  it("retains unknown worker cost after later priced parent usage", async () => {
    const instance = gateway(input => {
      const base = engine(input);
      return { ...base, async send(text, callbacks, options) {
        callbacks?.onUsage?.({ inputTokens: 0, outputTokens: 0, kind: "worker", model: "gpt-4.1", usageUnavailable: true, turnTokensUsed: 0, turnTokenBudget: Infinity, iterations: 0, maxToolIterations: 100 });
        callbacks?.onUsage?.({ inputTokens: 200, outputTokens: 20, kind: "planner", model: "gpt-4o", turnTokensUsed: 220, turnTokenBudget: Infinity, iterations: 1, maxToolIterations: 100 });
        return base.send(text, callbacks, options);
      } };
    });
    const chat = instance.create({});
    await instance.send(chat.id, "Review with one worker."); await idle(instance, chat.id);
    expect(instance.get(chat.id).usage.costUnavailable).toBe(true);
  });

  it("persists per-chat web search, passes it to the engine and changes it independently", async () => {
    const createSession = vi.fn(engine);
    const instance = gateway(createSession);
    const enabled = instance.create({ webSearchEnabled: true });
    const disabled = instance.create({ webSearchEnabled: false });
    expect(instance.get(enabled.id).session.webSearchEnabled).toBe(true);
    expect(instance.get(disabled.id).session.webSearchEnabled).toBe(false);
    await instance.send(enabled.id, "Hello"); await idle(instance, enabled.id);
    expect(createSession.mock.calls[0]![0].webSearchEnabled).toBe(true);
    await instance.configure(enabled.id, { webSearchEnabled: false });
    expect(instance.get(enabled.id).session.webSearchEnabled).toBe(false);
    await instance.close(enabled.id);
    const resumed = await instance.resume(enabled.id, {});
    expect(resumed.webSearchEnabled).toBe(false);
    await expect(instance.configure(resumed.id, { webSearchEnabled: "false" })).rejects.toThrow();
  });
  it("links a child session to its parent and hard-restricts skills, surviving a resume", async () => {
    const createSession = vi.fn(engine);
    const instance = gateway(createSession);
    const home = instance.create({ title: "Standing" });
    const child = instance.create({ parentSessionId: home.id, skillAllowList: ["pr-diff-review", "mount/w/x"] });
    expect(child).toMatchObject({ parentSessionId: home.id, skillAllowList: ["pr-diff-review", "mount/w/x"] });
    expect(() => instance.create({ parentSessionId: "session-0-999" })).toThrow("Parent session was not found");
    expect(() => instance.create({ skillAllowList: ["../escape"] })).toThrow("allow-list");
    expect(() => instance.create({ skillAllowList: "all" })).toThrow("allow-list");
    await instance.send(child.id, "Hello"); await idle(instance, child.id);
    const options = createSession.mock.calls[0]![0].skillDiscoveryOptions;
    expect(typeof options === "function" ? options() : options).toMatchObject({ allowedSkillIds: ["pr-diff-review", "mount/w/x"] });
    await instance.close(child.id);
    const resumed = await instance.resume(child.id, {});
    expect(resumed).toMatchObject({ parentSessionId: home.id, skillAllowList: ["pr-diff-review", "mount/w/x"] });
    const unrestricted = instance.create({});
    expect(unrestricted.skillAllowList).toBeUndefined();
  });
  it("refuses unsupported engine toggles instead of reporting fake search control", async () => {
    const instance = gateway(input => { const session = engine(input); delete session.setWebSearchEnabled; return session; });
    const created = instance.create({ webSearchEnabled: true });
    await instance.send(created.id, "Hello"); await idle(instance, created.id);
    await expect(instance.configure(created.id, { webSearchEnabled: false })).rejects.toThrow("does not support changing web search");
    expect(instance.get(created.id).session.webSearchEnabled).toBe(true);
  });
  it("binds skill edits, follows a preserved workspace copy, and restores that binding", async () => {
    const home = mkdtempSync(join(tmpdir(), "0-skill-chat-test-")); homes.push(home);
    const skills = new SkillsStore({ workspace: home, stateDir: join(home, "state") });
    const source = skills.list().skills.find(skill => skill.scope === "builtin")!;
    const original = skills.get(source.id);
    let factoryInput: ConsoleGatewaySessionFactoryInput | undefined;
    const instance = new ConsoleGateway({ homeDir: home, projectPath: home, skillAuthoring: () => skills.authoring(), createSession: input => { factoryInput = input; return engine(input); } }); gateways.push(instance);
    const chat = instance.create({ skillId: source.id, title: "Customize skill" });
    expect(chat.skillId).toBe(source.id);
    expect(factoryInput).toBeUndefined();
    expect(instance.get(chat.id).messages).toEqual([]);
    await instance.send(chat.id, "Customize this skill"); await idle(instance, chat.id);
    const adapter = typeof factoryInput!.skillAuthoring === "function" ? factoryInput!.skillAuthoring()! : factoryInput!.skillAuthoring!;
    expect(await factoryInput!.skillEditor!.read()).toMatchObject({ id: source.id, revision: source.revision, writable: false });
    expect(() => adapter.read("builtin/unrelated")).toThrow("bound skill ID");
    expect(() => adapter.create(original.content)).toThrow("copy_skill");
    expect(() => adapter.update(source.id, { content: original.content, expectedRevision: source.revision })).toThrow("workspace copy");
    const copy = await adapter.copy(source.id, { content: original.content.replace(/^name:.*$/m, "name: chat-customized-skill"), expectedRevision: source.revision }) as { id: string; revision: string; content: string };
    expect(instance.get(chat.id).session.skillId).toBe(copy.id);
    expect(skills.get(source.id).content).toBe(original.content);
    expect(skills.get(copy.id).files).toEqual(original.files.map(file => file.path === "SKILL.md" ? { ...file, size: Buffer.byteLength(copy.content) } : file));
    expect(await factoryInput!.skillEditor!.read()).toMatchObject({ id: copy.id, writable: true });
    expect(() => adapter.read(source.id)).toThrow("bound skill ID");
    const updated = await adapter.update(copy.id, { content: copy.content + "\nPreserve evidence.\n", expectedRevision: copy.revision }) as { revision: string };
    expect(updated.revision).not.toBe(copy.revision);
    expect(() => adapter.update(copy.id, { content: copy.content, expectedRevision: copy.revision })).toThrow("changed");
    await instance.close(chat.id);
    expect(loadSession(chat.id, home)?.consoleState?.configuration?.skillId).toBe(copy.id);
    const resumed = await instance.resume(chat.id);
    expect(resumed.skillId).toBe(copy.id);
    expect(() => instance.create({ skillId: "missing-skill" })).toThrow("Skill not found");
    expect(() => instance.create({ skillId: "../escape" })).toThrow("Invalid skill ID");
  });

  it("scopes workflow editing and restores its binding without starting execution", async () => {
    const home = mkdtempSync(join(tmpdir(), "0-workflow-chat-test-")); homes.push(home);
    const dbPath = join(home, "workflow.db");
    const store = new SecurityWorkflowStore(dbPath);
    const workflow = store.save({ name: "Chat edited review", instructions: "", target: "", nodes: [
      { id: "start", type: "trigger", label: "Start", enabled: true },
      { id: "audit", type: "audit", label: "Review", enabled: true },
      { id: "report", type: "report", label: "Report", enabled: true },
    ], edges: [{ source: "start", target: "audit" }, { source: "audit", target: "report" }] });
    let factoryInput: ConsoleGatewaySessionFactoryInput | undefined;
    const instance = new ConsoleGateway({ homeDir: home, dbPath, createSession: input => { factoryInput = input; return engine(input); } }); gateways.push(instance);
    const lifecycleInvoke = vi.fn(async () => ({}));
    instance.attachWorkflowLifecycle({ invoke: lifecycleInvoke });
    try {
      const chat = instance.create({ workflowId: workflow.id, title: "Edit review" });
      expect(chat.workflowId).toBe(workflow.id);
      expect(factoryInput).toBeUndefined();
      expect(instance.get(chat.id).messages).toEqual([]);
      await instance.send(chat.id, "Rename the review step"); await idle(instance, chat.id);
      expect((await factoryInput?.workflowAuthoring?.editor?.read())?.revision).toBe(1);
      const { createdAt: _created, updatedAt: _updated, ...editable } = workflow;
      const { id: _id, revision: _revision, ...newDefinition } = editable;
      const unrelated = store.save({ ...newDefinition, name: "Unrelated workflow" });
      const bound = factoryInput!.workflowAuthoring!;
      expect((await bound.list()).map(item => item.id)).toEqual([workflow.id]);
      expect(() => bound.save(newDefinition)).toThrow("bound workflow ID");
      expect(() => bound.save({ ...newDefinition, id: unrelated.id, revision: unrelated.revision })).toThrow("bound workflow ID");
      expect(() => bound.save({ ...newDefinition, id: workflow.id })).toThrow("current workflow revision");
      expect(() => bound.save({ ...editable, revision: 0 })).toThrow("current workflow revision");
      const latest = store.save({ ...editable, name: "Changed elsewhere" });
      expect(() => bound.save(editable)).toThrow("Workflow changed");
      const updated = await bound.save({ ...editable, revision: latest.revision, name: "Saved by chat" });
      expect(updated.revision).toBe(latest.revision + 1);
      expect(store.get(unrelated.id)?.revision).toBe(1);
      expect(store.list()).toHaveLength(2);
      const lifecycle = factoryInput!.workflowLifecycle!;
      expect(await lifecycle.invoke("list_workflows", {})).toMatchObject({ workflows: [{ id: workflow.id }] });
      expect((await lifecycle.invoke("get_workflow", { id: workflow.id }) as { workflow: { revision: number } }).workflow.revision).toBe(updated.revision);
      await expect(lifecycle.invoke("get_workflow", { id: unrelated.id })).rejects.toThrow("bound workflow ID");
      await expect(lifecycle.invoke("save_workflow", { definition: newDefinition })).rejects.toThrow("bound workflow ID");
      await expect(lifecycle.invoke("save_workflow", { definition: editable })).rejects.toThrow("Workflow changed");
      expect(lifecycleInvoke).not.toHaveBeenCalled();
      expect((await factoryInput?.workflowAuthoring?.editor?.read())?.revision).toBe(updated.revision);
      expect(loadSession(chat.id, home)?.consoleState?.configuration?.workflowId).toBe(workflow.id);
      await instance.close(chat.id);
      const resumed = await instance.resume(chat.id);
      expect(resumed.workflowId).toBe(workflow.id);
      expect(() => instance.create({ workflowId: "missing-workflow" })).toThrow("Workflow definition was not found");
      expect(() => instance.create({ workflowId: "../escape" })).toThrow("Invalid workflow ID");
      const unbound = instance.create();
      await instance.send(unbound.id, "Create a new workflow"); await idle(instance, unbound.id);
      expect(await factoryInput!.workflowAuthoring!.list()).toHaveLength(2);
      const created = await factoryInput!.workflowAuthoring!.save({ ...newDefinition, name: "New unbound draft" });
      expect(created.id).not.toBe(workflow.id);
      expect(created.revision).toBe(1);
      expect(store.list()).toHaveLength(3);
    } finally { store.close(); }
  });

  it("classifies aborted workers as stopped without duplicating cancellation errors", async () => {
    const instance = gateway(); const chat = instance.create();
    await instance.send(chat.id, "Start"); await idle(instance, chat.id);
    eventBus.emit("subagent_lifecycle", { agent_id: `${chat.id}-cancelled`, parent_scan_id: chat.id, status: "failed", task: "Inspect", max_turns: 3, error: "This operation was aborted" });
    const worker = instance.get(chat.id).workers.find(worker => worker.id === `${chat.id}-cancelled`)!;
    expect(worker.status).toBe("stopped"); expect(worker.error).toBeUndefined(); expect(worker.transcript).toEqual([]);
  });
  it("sends image-only messages as native images and preserves public history", async () => {
    const instance = gateway(); const chat = instance.create();
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9uoAAAAASUVORK5CYII=";
    await instance.send(chat.id, { text: "", attachments: [{ kind: "image", value: `data:image/png;base64,${data}`, name: "paste.png" }] });
    await idle(instance, chat.id);
    expect(instance.get(chat.id).messages[0]!.content).toContainEqual({ type: "image", mediaType: "image/png", data, name: "paste.png" });
    expect(instance.get(chat.id).events.find(event => event.type === "user")).toMatchObject({ attachments: [{ kind: "image", name: "paste.png" }] });
    const saved = instance.save(chat.id);
    const resumed = await instance.resume(saved.id);
    expect(instance.get(resumed.id).messages[0]!.content).toContainEqual({ type: "image", mediaType: "image/png", data, name: "paste.png" });
  });
  it("rejects active image formats, malformed base64 and forged raster formats", async () => {
    const instance = gateway(); const chat = instance.create();
    for (const value of ["data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,!!!!", "data:image/png;base64,aGVsbG8="]) {
      await expect(instance.send(chat.id, { attachments: [{ kind: "image", value }] })).rejects.toThrow(/image/i);
    }
    await expect(instance.send(chat.id, { attachments: [{ kind: "image", value: "x".repeat(650001) }] })).rejects.toThrow();
    expect(instance.get(chat.id).messages).toEqual([]);
  });

  it("binds skill authoring to each trusted turn and retains the actor in background work", async () => {
    const seen: unknown[] = [];
    const gate = Promise.withResolvers<void>();
    let background: Promise<void> | undefined;
    const instance = new ConsoleGateway({
      skillAuthoring: author => ({ read: () => author?.userId ?? "anonymous", create: () => undefined, update: () => undefined, copy: () => undefined }),
      createSession: input => {
        const session = engine(input);
        const adapter = () => typeof input.skillAuthoring === "function" ? input.skillAuthoring() : input.skillAuthoring;
        session.send = async text => {
          seen.push(await adapter()!.read("skill"));
          if (text === "Owner request") background = (async () => { await gate.promise; seen.push(await adapter()!.read("skill")); })();
          return outcome();
        };
        return session;
      },
    });
    gateways.push(instance);
    const chat = instance.create();
    await instance.send(chat.id, "Owner request", { userId: "owner", displayName: "Owner" }); await idle(instance, chat.id);
    await instance.send(chat.id, "Editor request", { userId: "editor", displayName: "Editor" }); await idle(instance, chat.id);
    gate.resolve(); await background;
    expect(seen).toEqual(["owner", "editor", "owner"]);
    await instance.send(chat.id, "Anonymous request"); await idle(instance, chat.id);
    expect(seen.at(-1)).toBe("anonymous");
  });

  it("accepts attribution only from a server argument and retains repeated-prompt authors after save/resume", async () => {
    const instance = gateway(); const created = instance.create();
    const alice = { userId: "alice", displayName: "Alice" };
    const bob = { userId: "bob", displayName: "Bob", proposalId: "proposal-1" };
    await expect(instance.send(created.id, { text: "Same prompt", author: alice })).rejects.toThrow("Unsupported input field");
    await instance.send(created.id, "Same prompt", alice); await idle(instance, created.id);
    await instance.send(created.id, "Same prompt"); await idle(instance, created.id);
    await instance.send(created.id, "Same prompt", bob); await idle(instance, created.id);
    const users = instance.get(created.id).messages.filter(message => message.role === "user");
    expect(users.map(message => message.author)).toEqual([alice, undefined, bob]);
    expect(instance.get(created.id).events.filter(event => event.type === "user").map(event => event.type === "user" ? event.author : undefined)).toEqual([alice, undefined, bob]);
    const saved = instance.save(created.id); await instance.close(created.id);
    expect(instance.loadSaved(saved.id).messages.filter(message => message.role === "user").map(message => message.author)).toEqual([alice, undefined, bob]);
    const resumed = await instance.resume(saved.id);
    expect(instance.get(resumed.id).messages.filter(message => message.role === "user").map(message => message.author)).toEqual([alice, undefined, bob]);
  });

  it("preserves queued proposal authors across a retained checkpoint and their eventual user event", async () => {
    const gate = Promise.withResolvers<void>();
    const first = gateway(input => {
      const session = engine(input); const send = session.send;
      session.send = async (...args) => { const result = await send(...args); await gate.promise; return result; };
      return session;
    });
    const created = first.create();
    await first.send(created.id, "Owner request", { userId: "alice", displayName: "Alice" });
    const bob = { userId: "bob", displayName: "Bob", proposalId: "proposal-queued" };
    await first.send(created.id, { text: "Queued evidence review", mode: "queue" }, bob);
    const saved = first.save(created.id);
    const retained = loadSession(saved.id, homes.at(-1))!;
    expect(retained.consoleState?.queuedMessages[0]?.author).toEqual(bob);
    expect(saveSession({ ...retained, id: "queued-checkpoint" }, homes.at(-1))).toBe(true);
    await first.cancel(created.id); gate.resolve(); await idle(first, created.id);
    const resumed = await first.resume("queued-checkpoint");
    expect(first.get(resumed.id).queuedMessages[0]?.author).toEqual(bob);
    await first.send(resumed.id, "Continue checkpoint", { userId: "alice", displayName: "Alice" });
    await vi.waitFor(() => expect(first.get(resumed.id).events.filter(event => event.type === "user").some(event => event.type === "user" && event.text === "Queued evidence review" && event.author?.proposalId === "proposal-queued")).toBe(true));
    await idle(first, resumed.id);
    const queuedUser = first.get(resumed.id).messages.find(message => message.role === "user" && message.content.some(block => block.type === "text" && block.text === "Queued evidence review"));
    expect(queuedUser?.author).toEqual(bob);
  });
  it("searches live and saved replies once, pages results and validates search bounds", async () => {
    const instance = gateway();
    const blank = instance.create({ title: "Blank chat" });
    const live = instance.create({ title: "Customer review" });
    await instance.send(live.id, "ownership check"); await idle(instance, live.id);
    instance.save(live.id);
    saveSession({ id: "saved-search", savedAt: 1, cwd: "/fixture", messageCount: 0, preview: "", summary: "Archived review", archived: true, messages: [{ role: "assistant", content: "ownership check" }] }, homes.at(-1)!);
    const first = await instance.search({ q: "ownership", limit: 1 });
    expect(first.results).toEqual([expect.objectContaining({ id: live.id, source: "live" })]);
    expect(first.hasMore).toBe(true); expect(first.nextOffset).toBe(1);
    expect((await instance.search({ q: "ownership", limit: 1, offset: first.nextOffset })).results).toEqual([expect.objectContaining({ id: "saved-search", archived: true })]);
    expect((await instance.search()).results.map(row => row.id)).not.toContain(blank.id);
    expect((await instance.search({ q: "Complete final text" })).results).toHaveLength(1);
    for (const query of [{ q: "x".repeat(201) }, { limit: 0 }, { offset: -1 }, { limit: 101 }, { offset: 10_001 }]) await expect(instance.search(query)).rejects.toMatchObject({ statusCode: 400 });
  });
  it("shares the web lesson store with local chats without transferring its ownership", async () => {
    const createSession = vi.fn(engine);
    const instance = gateway(createSession);
    const store = new LearningStore(join(homes.at(-1)!, "learning.db"));
    try {
      instance.attachSourceLearning(store);
      const created = instance.create({ title: "Lessons" });
      await instance.send(created.id, "Inspect the workspace.");
      await idle(instance, created.id);
      expect(createSession.mock.calls[0]?.[0].codebaseLearning).toBe(true);
      expect(createSession.mock.calls[0]?.[0].learningStore).toBe(store);
      await instance.closeAll();
      expect(store.listKnowledge()).toEqual([]);
    } finally { store.close(); }
  });
  it("starts new web chats in YOLO and applies Auto through the copilot engine mode", async () => {
    const createSession = vi.fn(engine);
    const instance = gateway(createSession);
    const created = instance.create({ title: "New chat", role: "audit" });
    expect(created.autonomyMode).toBe("yolo");
    await instance.send(created.id, "Inspect the workspace.");
    await idle(instance, created.id);
    expect(createSession.mock.calls[0]?.[0].autonomyMode).toBe("yolo");
    await instance.configure(created.id, { autonomyMode: "copilot" });
    expect(instance.get(created.id).session.autonomyMode).toBe("copilot");
    expect(instance.get(created.id).pendingDecisions).toEqual([]);
  });
  it("reopens scheduled working context once without restoring authorization or sending messages", async () => {
    const createSession = vi.fn(engine);
    const instance = gateway(createSession);
    const created = instance.create({ target: "https://example.test", title: "Scheduled review", autonomyMode: "yolo" });
    await instance.close(created.id);
    const resumedId = await instance.prepareScheduledWorkflowOwner(created.id);
    expect(resumedId).not.toBe(created.id);
    expect(await instance.prepareScheduledWorkflowOwner(created.id)).toBe(resumedId);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]?.[0].autonomyMode).toBe("standard");
    expect(createSession.mock.calls[0]?.[0].scope).toBeUndefined();
    expect(instance.get(resumedId).messages).toEqual([]);
    expect(instance.get(resumedId).pendingDecisions).toEqual([]);
  });
  it("blocks scheduled scope expansion without opening an unattended decision", async () => {
    const instance = gateway();
    const created = instance.create({ target: "https://example.test", title: "Scheduled review" });
    vi.spyOn(instance, "getExecutionContext").mockResolvedValue({
      target: "https://example.test", role: "audit", autonomyMode: "standard",
      scopeEnforcement: { pluginId: "scope", enabled: true, projectPath: "/fixture", message: "Enabled" },
      authorization: { deniedHosts: [], deniedLocalPaths: [], scopedAuditGrants: [], scopedAuditDenials: [] },
    } as unknown as ConsoleExecutionContext);
    await expect(instance.authorizeWorkflowTarget(created.id, { target: "https://another.test", kind: "web" }, undefined, "scheduled", { interactive: false })).rejects.toThrow("Target approval required");
    await expect(instance.authorizeWorkflowTarget(created.id, { target: "npm:example", kind: "package" }, undefined, "scheduled", { interactive: false })).rejects.toThrow("Target approval required");
    expect(instance.get(created.id).pendingDecisions).toHaveLength(0);
  });
  it("leaves a saved connection and history untouched when resume initialization fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "0-resume-failure-")); homes.push(home);
    const initial = new ConsoleGateway({ homeDir: home, createSession: engine }); gateways.push(initial);
    const chat = initial.create({ title: "Source audit", runtime: { providerId: "openrouter", model: "z-ai/glm-5.3-flash" } });
    await initial.send(chat.id, "Source only; preserve findings"); await idle(initial, chat.id);
    await initial.close(chat.id);
    const saved = loadSession(chat.id, home);
    const reopened = new ConsoleGateway({ homeDir: home, createSession: () => { throw new Error("provider temporarily unavailable"); } }); gateways.push(reopened);
    await expect(reopened.resume(chat.id)).rejects.toThrow("provider temporarily unavailable");
    await reopened.closeAll();
    expect(loadSession(chat.id, home)).toEqual(saved);
  });

  it("archives a chat with a failed model initialization without initializing it again", async () => {
    const createSession = vi.fn(() => { throw new Error("The selected model is not available to this ChatGPT account."); });
    const instance = gateway(createSession);
    const created = instance.create({ title: "Unavailable model" });
    await expect(instance.send(created.id, "Keep this message")).rejects.toThrow("selected model");
    expect(instance.get(created.id).session.status).toBe("failed");
    const before = instance.get(created.id).messages;

    const archived = await instance.archive(created.id);

    expect(archived.archived).toBe(true);
    expect(instance.get(created.id).session.status).toBe("closed");
    expect(instance.loadSaved(archived.id).messages).toEqual(before);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("archives a live chat without losing history, persists across gateways, and restores it", async () => {
    const instance = gateway();
    const created = instance.create({ title: "Archive fixture" });
    await instance.send(created.id, "Keep this evidence"); await idle(instance, created.id);
    const before = instance.get(created.id).messages;
    expect(() => instance.archiveSaved(created.id, { archived: true })).toThrow(ConsoleGatewayError);
    const archived = await instance.archive(created.id);
    expect(instance.get(created.id).session.status).toBe("closed");
    expect(archived.archived).toBe(true);
    expect(instance.loadSaved(archived.id).messages).toEqual(before);
    const reopened = new ConsoleGateway({ homeDir: homes.at(-1), projectPath: "/fixture", createSession: engine }); gateways.push(reopened);
    expect(reopened.listSaved().find(row => row.id === archived.id)?.archived).toBe(true);
    expect(reopened.archiveSaved(archived.id, { archived: false }).archived).toBeUndefined();
    expect(reopened.loadSaved(archived.id).messages).toEqual(before);
    expect(() => reopened.archiveSaved(archived.id, { archived: "true" })).toThrow(ConsoleGatewayError);
    reopened.archiveSaved(archived.id, { archived: true });
    reopened.deleteSaved(archived.id);
    expect(reopened.listSaved().find(row => row.id === archived.id)).toBeUndefined();
  });

  it("applies a folder the operator picked without a second confirmation", async () => {
    const instance = gateway(); const created = instance.create();
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "zero-workspace-"))); homes.push(directory);
    await instance.configure(created.id, { workspacePath: directory });
    await vi.waitFor(() => expect(instance.get(created.id).workspacePath).toBe(directory));
    expect(instance.get(created.id).pendingDecisions).toHaveLength(0);
    expect(instance.get(created.id).localScopePath).toBe(directory);
    expect(loadSession(created.id, homes[0])?.cwd).toBe(directory);
  });

  it("rejects missing, protected and symlinked protected roots before requesting approval", async () => {
    const instance = gateway(); const created = instance.create();
    await expect(instance.configure(created.id, { workspacePath: "/zero-missing-folder-12345" })).rejects.toThrow("existing local folder");
    await expect(instance.configure(created.id, { workspacePath: "/" })).rejects.toThrow("protected root");
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "zero-workspace-link-"))); homes.push(directory);
    symlinkSync("/", join(directory, "root"));
    await expect(instance.configure(created.id, { workspacePath: join(directory, "root") })).rejects.toThrow("protected root");
    expect(instance.get(created.id).pendingDecisions).toHaveLength(0);
  });

  it("requires active agents to stop before switching folders", async () => {
    const instance = gateway(); const created = instance.create();
    await instance.send(created.id, "Start"); await idle(instance, created.id);
    eventBus.emit("subagent_lifecycle", { agent_id: `${created.id}-sub-agent`, parent_scan_id: created.id, status: "running", task: "Inspect", max_turns: 3 });
    await expect(instance.configure(created.id, { workspacePath: tmpdir() })).rejects.toThrow("Stop active agents");
    expect(instance.get(created.id).pendingDecisions).toHaveLength(0);
  });

  it("names new sessions from their first prompt and preserves the title in saved history", async () => {
    const instance = gateway();
    const created = instance.create({ title: "New session" });
    await instance.send(created.id, "Review\n  tenant isolation");
    await idle(instance, created.id);
    expect(instance.get(created.id).title).toBe("Review tenant isolation");
    expect(loadSession(created.id, homes.at(-1))?.summary).toBe("Review tenant isolation");
    await instance.configure(created.id, { title: "My review" });
    await instance.send(created.id, "Second request");
    await idle(instance, created.id);
    expect(instance.get(created.id).title).toBe("My review");
  });

  it("titles blank sessions \"New chat\" and reports message counts so clients can reuse a blank one", async () => {
    const instance = gateway();
    const created = instance.create({});
    expect(created).toMatchObject({ title: "New chat", messageCount: 0 });
    expect(instance.list().find((item) => item.id === created.id)?.messageCount).toBe(0);
    await instance.send(created.id, "Review tenant isolation");
    await idle(instance, created.id);
    expect(instance.list().find((item) => item.id === created.id)?.messageCount).toBe(2);
  });

  it("keeps full canonical history and final text when a reattached client has missed the journal", async () => {
    const instance = gateway((input) => {
      const session = engine(input);
      session.send = async (text, callbacks) => {
        session.messages.push({ role: "user", content: [{ type: "text", text }] });
        for (let index = 0; index < 2_100; index++) callbacks?.onAssistantDelta?.("fragment ");
        session.messages.push({ role: "assistant", content: [{ type: "text", text: "Complete authoritative answer." }] });
        return outcome("Complete authoritative answer.");
      };
      return session;
    });
    const created = instance.create(); await instance.send(created.id, "Keep this request."); await idle(instance, created.id);
    const recovery = instance.eventsAfter(created.id, 0);
    expect(recovery.gap).toBe(true);
    expect(recovery.snapshot?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Keep this request." }] },
      { role: "assistant", content: [{ type: "text", text: "Complete authoritative answer." }] },
    ]);
    expect(recovery.snapshot?.lastOutcome?.assistantText).toBe("Complete authoritative answer.");
    expect(JSON.parse(JSON.stringify(recovery.snapshot)).lastOutcome.budget.tokenBudget).toBeNull();
    expect(instance.export(created.id).text).toContain("Keep this request.");
    expect(instance.eventsAfter(created.id, recovery.cursor)).toEqual({ events: [], cursor: recovery.cursor, gap: false });
  });

  it("cancels a decision-waiting turn by declining its approval without closing or clearing the conversation", async () => {
    let permission: boolean | undefined;
    const instance = gateway((input) => {
      const session = engine(input);
      session.send = async (text) => {
        session.messages.push({ role: "user", content: [{ type: "text", text }] });
        permission = await input.approveTool!({ name: "bash", arguments: { command: "rm -rf /fixture/cache" } }, { level: "destructive", category: "delete" as never });
        return { ...outcome(), stopReason: "cancelled" };
      };
      return session;
    });
    const created = instance.create({ autonomyMode: "standard" }); await instance.send(created.id, "Inspect, do not delete.");
    await vi.waitFor(() => expect(instance.get(created.id).pendingDecisions).toHaveLength(1));
    const decision = instance.get(created.id).pendingDecisions[0]!;
    expect(decision.risk?.level).toBe("destructive"); expect(decision.context?.scopeEnforcement.enabled).toBe(true);
    await instance.cancel(created.id); await idle(instance, created.id);
    expect(permission).toBe(false); expect(instance.get(created.id).pendingDecisions).toEqual([]);
    expect(instance.get(created.id).session.status).toBe("ready");
    expect(instance.get(created.id).messages[0]?.content).toEqual([{ type: "text", text: "Inspect, do not delete." }]);
    expect(() => instance.resolveDecision(created.id, decision.id, { approve: true })).toThrow(ConsoleGatewayError);
  });

  it("does not report an excluded network target as approved or consume a malformed operator answer", async () => {
    let resolution: unknown;
    const instance = gateway((input) => {
      const session = engine(input);
      session.send = async () => {
        resolution = await input.requestScope!({ call: { name: "http_request", arguments: { url: "https://excluded.example.test" } }, requestedUrls: ["https://excluded.example.test"], target: input.target, currentScope: input.scope });
        return outcome();
      };
      return session;
    });
    const created = instance.create({ target: "https://app.example.test", scope: { in_scope: ["app.example.test"], out_of_scope: ["excluded.example.test"] } });
    await instance.send(created.id, "Inspect excluded host.");
    await vi.waitFor(() => expect(instance.get(created.id).pendingDecisions).toHaveLength(1));
    const decision = instance.get(created.id).pendingDecisions[0]!;
    expect(() => instance.resolveDecision(created.id, decision.id, { approve: true })).toThrow(ConsoleGatewayError);
    expect(instance.get(created.id).pendingDecisions[0]?.id).toBe(decision.id);
    instance.resolveDecision(created.id, decision.id, { approve: false }); await idle(instance, created.id); expect(resolution).toBeNull();
  });

  it("keeps an operator question pending after an invalid selection and accepts a free-text-only question without granting scope", async () => {
    const instance = gateway((input) => {
      const session = engine(input);
      session.send = async () => {
        await input.askOperator!({
          requestId: "question-1",
          questions: [
            { header: "Strategy", question: "Which strategy?", options: [{ label: "Review only" }] },
            { header: "Context", question: "What context should I use?" },
          ],
        });
        return outcome();
      };
      return session;
    });
    const created = instance.create({ autonomyMode: "standard" }); await instance.send(created.id, "Ask before deciding.");
    await vi.waitFor(() => expect(instance.get(created.id).pendingDecisions).toHaveLength(1));
    const decision = instance.get(created.id).pendingDecisions[0]!;
    expect(() => instance.resolveDecision(created.id, decision.id, { approve: true, answers: [
      { header: "Strategy", selectedLabels: ["Unlisted strategy"] }, { header: "Context", customText: "Evidence only." },
    ] })).toThrow(ConsoleGatewayError);
    expect(instance.get(created.id).pendingDecisions[0]?.id).toBe(decision.id);
    instance.resolveDecision(created.id, decision.id, { approve: true, answers: [
      { header: "Strategy", selectedLabels: ["Review only"] }, { header: "Context", customText: "Evidence only." },
    ] });
    await idle(instance, created.id);
    expect(instance.get(created.id).scope).toBeNull();
    expect(instance.get(created.id).session.autonomyMode).toBe("standard");
    expect(instance.get(created.id).pendingDecisions).toEqual([]);
  });

  it("retries failed async initialization without consuming the rejected message", async () => {
    let attempt = 0;
    const instance = gateway(async (input) => { if (++attempt === 1) throw new Error("Connection unavailable"); return engine(input); });
    const created = instance.create();
    await expect(instance.send(created.id, "Retain my draft.")).rejects.toBeInstanceOf(ConsoleGatewayError);
    expect(instance.get(created.id).messages).toEqual([]);
    expect(instance.eventsAfter(created.id).events.some((event) => event.type === "user")).toBe(false);
    await instance.send(created.id, "Retain my draft."); await idle(instance, created.id);
    expect(instance.get(created.id).messages[0]?.content).toEqual([{ type: "text", text: "Retain my draft." }]);
  });

  it("resumes messages and cap display state with target context without restoring scope authority, and protects a live saved owner", async () => {
    const first = gateway((input) => {
      const session = engine(input);
      session.send = async (text) => {
        session.messages.push({ role: "user", content: [{ type: "text", text }] });
        return { ...outcome("Partial retained answer."), stopReason: "output_cap", outputCap: { checkpoint: { reason: "max_output_tokens", provider: "fixture", model: "fixture", resumable: true } as never, continuations: 2, message: "Send remaining task." } };
      };
      return session;
    });
    const created = first.create({ target: "https://authorized.example.test", autonomyMode: "standard", scope: { in_scope: ["authorized.example.test"] } });
    await first.send(created.id, "Analyze."); await idle(first, created.id); const saved = first.save(created.id); await first.close(created.id);
    const resumed = await first.resume(saved.id);
    const snapshot = first.get(resumed.id);
    expect(snapshot.messages[0]?.content).toEqual([{ type: "text", text: "Analyze." }]);
    expect(snapshot.session.target).toBe("https://authorized.example.test"); expect(snapshot.scope).toBeNull(); expect(snapshot.session.localScopeConfigured).toBe(false);
    expect(snapshot.lastOutcome?.stopReason).toBe("output_cap");
    expect(snapshot.lastOutcome?.budget.tokenBudget).toBeNull();
    expect(() => first.deleteSaved(saved.id)).toThrow(ConsoleGatewayError);
    await expect(first.delete(created.id)).rejects.toBeInstanceOf(ConsoleGatewayError);
    const continuationAuthor = { userId: "reviewer", displayName: "Reviewer" };
    await first.continue(resumed.id, { text: "Summarize only the remaining observations." }, continuationAuthor); await idle(first, resumed.id);
    expect(first.get(resumed.id).messages.at(-1)?.content).toEqual([{ type: "text", text: "Summarize only the remaining observations." }]);
    expect(first.get(resumed.id).messages.at(-1)?.author).toEqual(continuationAuthor);
    const deleted = await first.delete(resumed.id);
    expect(deleted.savedId).toBe(saved.id);
    expect(() => first.get(resumed.id)).toThrow(ConsoleGatewayError);
    expect(first.listSaved().some((entry) => entry.id === saved.id)).toBe(false);
  });

  it("retains only owned descendant workers and stops an owned subtree without stopping another live session", async () => {
    const instance = gateway(); const first = instance.create(); const second = instance.create();
    await instance.send(first.id, "First."); await instance.send(second.id, "Second."); await idle(instance, first.id); await idle(instance, second.id);
    const child = `${first.id}-sub-child`; const nested = `${child}-sub-nested`; const other = `${second.id}-sub-other`;
    const lifecycle = (agent_id: string, parent_scan_id: string) => eventBus.emit("subagent_lifecycle", { agent_id, parent_scan_id, status: "running", task: "Inspect", max_turns: 3 });
    lifecycle(child, first.id); lifecycle(nested, child); lifecycle(other, second.id);
    eventBus.emit("subagent_message", { agent_id: nested, parent_scan_id: child, turn: 1, ts: 1, assistant: "Owned observation.", partial: false });
    expect(instance.workers(first.id).map((worker) => worker.id)).toEqual([child, nested]);
    expect(() => instance.sendWorker(first.id, other, "Cross-session message")).toThrow(ConsoleGatewayError);
    await expect(instance.stopWorker(first.id, other)).rejects.toBeInstanceOf(ConsoleGatewayError);
    await instance.stopWorker(first.id, child);
    expect(instance.workers(first.id).map((worker) => worker.status)).toEqual(["stopped", "stopped"]);
    expect(instance.worker(first.id, nested).transcript[0]?.assistant).toBe("Owned observation.");
    expect(instance.exportWorker(first.id, nested).text).toContain("Owned observation.");
    expect(instance.exportWorker(first.id, nested).source).toBe("published-worker-trace");
    expect(instance.worker(second.id, other).status).toBe("running");
    await instance.clear(first.id); expect(instance.get(first.id).messages).toEqual([]); expect(instance.worker(first.id, nested).transcript[0]?.assistant).toBe("Owned observation.");
  });

  it("attributes worker operator messages through live events and retained worker history", async () => {
    const instance = gateway(); const created = instance.create();
    await instance.send(created.id, "Investigate"); await idle(instance, created.id);
    const workerId = `${created.id}-sub-reviewer`;
    eventBus.emit("subagent_lifecycle", { agent_id: workerId, parent_scan_id: created.id, status: "running", task: "Inspect", max_turns: 3 });
    const author = { userId: "alice", displayName: "Alice" };
    instance.sendWorker(created.id, workerId, "Inspect the retained evidence", author);
    expect(instance.worker(created.id, workerId).operatorMessages?.[0]?.author).toEqual(author);
    expect(instance.get(created.id).events.filter(event => event.type === "worker").some(event => event.type === "worker" && event.worker.operatorMessages?.[0]?.author?.userId === "alice")).toBe(true);
    const saved = instance.save(created.id); await instance.close(created.id);
    expect(loadSession(saved.id, homes.at(-1))?.consoleState?.workers[0]?.operatorMessages?.[0]?.author).toEqual(author);
    const resumed = await instance.resume(saved.id);
    expect(instance.worker(resumed.id, workerId).operatorMessages?.[0]?.author).toEqual(author);
    expect(instance.worker(resumed.id, workerId).status).toBe("stopped");
  });

  it("queues a follow-up without aborting the active turn or stopping its workers", async () => {
    let finish!: () => void;
    let turnSignal: AbortSignal | undefined;
    const delivered: string[] = [];
    const instance = gateway(input => {
      const session = engine(input);
      session.send = async (text, _callbacks, options) => {
        delivered.push(text);
        if (delivered.length === 1) {
          turnSignal = options?.signal;
          await new Promise<void>(resolve => { finish = resolve; });
        }
        return outcome();
      };
      return session;
    });
    const chat = instance.create();
    await instance.send(chat.id, "Investigate");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const child = `${chat.id}-sub-background`;
    eventBus.emit("subagent_lifecycle", { agent_id: child, parent_scan_id: chat.id, status: "running", task: "Inspect", max_turns: 3 });
    try {
      await instance.send(chat.id, { text: "Also summarize the evidence", mode: "queue" });
      expect(turnSignal?.aborted).toBe(false);
      expect(instance.worker(chat.id, child).status).toBe("running");
      expect(delivered).toEqual(["Investigate"]);
      expect(instance.get(chat.id).queuedMessages.map(message => message.text)).toEqual(["Also summarize the evidence"]);
      eventBus.emit("subagent_lifecycle", { agent_id: child, parent_scan_id: chat.id, status: "completed", task: "Inspect", max_turns: 3 });
    } finally { finish(); }
    await idle(instance, chat.id);
    expect(delivered).toEqual(["Investigate", "Also summarize the evidence"]);
    expect(instance.worker(chat.id, child).status).toBe("completed");
  });

  it("logs only bounded learning failure codes without leaking recorder errors", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const instance = gateway(); const chat = instance.create();
      for (const code of ["SQLITE_BUSY", "SQLITE_IOERR", "secret-not-a-code"]) {
        instance.attachLearningRecorder(() => { throw Object.assign(new Error("secret transcript /private/path"), { code }); });
        await instance.send(chat.id, "Private operator text"); await idle(instance, chat.id);
      }
      expect(warning.mock.calls).toEqual([
        ["[console] Learning activity retention failed (SQLITE_BUSY)."],
        ["[console] Learning activity retention failed (SQLITE_IOERR)."],
        ["[console] Learning activity retention failed (unknown)."],
      ]);
      expect(instance.get(chat.id).events.some(event => event.type === "notice" && event.text === "Learning activity could not be retained for this turn.")).toBe(true);
    } finally { warning.mockRestore(); }
  });

  it("retains unread notifications after failed automatic startup without looping", async () => {
    let failSummary = false;
    const delivered: string[] = [];
    const instance = gateway(input => {
      const session = engine(input);
      Object.defineProperty(session, "autonomyMode", { get() {
        if (failSummary) { failSummary = false; throw new Error("Temporary startup failure"); }
        return input.autonomyMode;
      } });
      session.send = async text => { delivered.push(text); return outcome(); };
      return session;
    });
    const chat = instance.create(); await instance.send(chat.id, "Start"); await idle(instance, chat.id);
    const worker = `${chat.id}-worker`;
    eventBus.emit("subagent_lifecycle", { agent_id: worker, parent_scan_id: chat.id, status: "parked", task: "Inspect", max_turns: 3 });
    isolated.inbox = [{ id: "retry", from: worker }]; failSummary = true;
    eventBus.emit("peer_message", { id: "retry", from: worker, to: "Main", body: "Observation", ts: 1, kind: "peer" });
    await vi.waitFor(() => expect(instance.get(chat.id).session.status).toBe("failed"));
    expect(delivered).toEqual(["Start"]);
    // Explicit operator recovery re-enables idle processing; the same unread ID survives.
    await instance.send(chat.id, "Retry now");
    await vi.waitFor(() => expect(delivered).toHaveLength(3)); await idle(instance, chat.id);
    expect(delivered[2]).toMatch(/^\[Agent completion\]/);
  });

  it("wakes only for unread owned worker messages while idle and coalesces messages behind active work", async () => {
    const delivered: string[] = [];
    let finish: (() => void) | undefined;
    const instance = gateway(input => {
      const session = engine(input);
      session.send = async text => {
        delivered.push(text);
        if (text === "Hold") await new Promise<void>(resolve => { finish = resolve; });
        else isolated.inbox = []; // The real engine drains at a model request boundary.
        return outcome();
      };
      return session;
    });
    const chat = instance.create();
    await instance.send(chat.id, "Start"); await idle(instance, chat.id);
    const worker = `${chat.id}-worker`;
    eventBus.emit("subagent_lifecycle", { agent_id: worker, parent_scan_id: chat.id, status: "parked", task: "Inspect", max_turns: 3 });
    const notify = (id: string, from = worker, to = "Main") => eventBus.emit("peer_message", { id, from, to, body: "Untrusted peer observation", ts: 1, kind: "peer" });
    isolated.inbox = [{ id: "foreign", from: "foreign" }]; notify("foreign", "foreign");
    notify("wrong-recipient", worker, "Other");
    expect(delivered).toEqual(["Start"]);
    isolated.inbox = [{ id: "first", from: worker }]; notify("first");
    await vi.waitFor(() => expect(delivered).toHaveLength(2)); await idle(instance, chat.id);
    expect(delivered[1]).not.toContain("Untrusted peer observation");
    await instance.send(chat.id, "Hold");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    isolated.inbox = [{ id: "second", from: worker }, { id: "third", from: worker }];
    notify("second"); notify("third");
    expect(delivered).toHaveLength(3);
    finish!();
    await vi.waitFor(() => expect(delivered).toHaveLength(4)); await idle(instance, chat.id);
    // A message consumed by the active model's boundary must not cause an extra turn.
    await instance.send(chat.id, "Hold");
    await vi.waitFor(() => expect(delivered).toHaveLength(5));
    isolated.inbox = [{ id: "consumed", from: worker }]; notify("consumed");
    isolated.inbox = []; finish!(); await idle(instance, chat.id);
    expect(delivered).toHaveLength(5);
    // Explicit stop pauses automatic delivery, including late child completion.
    await instance.send(chat.id, "Hold");
    await vi.waitFor(() => expect(delivered).toHaveLength(6));
    instance.cancel(chat.id);
    isolated.inbox = [{ id: "after-stop", from: worker }]; notify("after-stop");
    finish!(); await idle(instance, chat.id);
    expect(delivered).toHaveLength(6);
  });

  it("promotes the existing queued message and interrupts once without duplicating attachments", async () => {
    const delivered: Array<{ text: string; images: unknown }> = [];
    const instance = gateway(input => {
      const session = engine(input);
      session.send = async (text, _callbacks, options) => {
        delivered.push({ text, images: options?.images });
        if (delivered.length === 1) await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return outcome();
      };
      return session;
    });
    const chat = instance.create();
    await instance.send(chat.id, "First");
    await instance.send(chat.id, { text: "Later", mode: "queue" });
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9uoAAAAASUVORK5CYII=";
    const accepted = await instance.send(chat.id, { text: "Now", mode: "queue", attachments: [{ kind: "image", value: `data:image/png;base64,${data}`, name: "paste.png" }] });
    expect(accepted.queuedMessageId).toBe(instance.get(chat.id).queuedMessages[1]?.id);
    instance.sendQueuedNow(chat.id, accepted.queuedMessageId);
    await vi.waitFor(() => expect(delivered.map(item => item.text)).toEqual(["First", "Now", "Later"]));
    await idle(instance, chat.id);
    expect(delivered[1]?.images).toEqual([{ mediaType: "image/png", data, name: "paste.png" }]);
    expect(instance.get(chat.id).queuedMessages).toEqual([]);
    expect(() => instance.sendQueuedNow(chat.id, accepted.queuedMessageId)).toThrow(/already started/);
    expect(() => instance.sendQueuedNow(chat.id, "")).toThrow(/Choose a queued/);
  });

  it("retains a queued message when pending configuration prevents immediate promotion", async () => {
    const gate = Promise.withResolvers<void>();
    const instance = gateway(input => {
      const session = engine(input);
      session.send = async () => { await gate.promise; return outcome(); };
      return session;
    });
    const chat = instance.create();
    await instance.send(chat.id, "First");
    const accepted = await instance.send(chat.id, { text: "Keep me", mode: "queue" });
    await instance.configure(chat.id, { target: "https://different.test" });
    const before = instance.get(chat.id).queuedMessages;
    expect(() => instance.sendQueuedNow(chat.id, accepted.queuedMessageId)).toThrow(/pending initialization/);
    expect(instance.get(chat.id).queuedMessages).toEqual(before);
    gate.resolve();
    await idle(instance, chat.id);
  });

  it("changes Local autonomy during a turn and delivers queued operator messages exactly once", async () => {
    const gate = Promise.withResolvers<void>(); const delivered: string[] = []; const observedModes: string[] = [];
    const instance = gateway((input) => {
      const session = engine(input);
      session.send = async (text) => { delivered.push(text); observedModes.push(session.autonomyMode); if (delivered.length === 1) await gate.promise; return outcome(); };
      return session;
    });
    const created = instance.create({ autonomyMode: "standard" }); await instance.send(created.id, "First instruction.");
    await instance.configure(created.id, { autonomyMode: "recon" }); await instance.send(created.id, { text: "Second instruction.", mode: "queue" });
    await instance.send(created.id, { text: "Withdraw this queued instruction.", mode: "queue" });
    const withdrawal = instance.get(created.id).queuedMessages.find((message) => message.text === "Withdraw this queued instruction.")!;
    instance.removeQueued(created.id, withdrawal.id);
    expect(instance.get(created.id).session.autonomyMode).toBe("recon"); expect(instance.get(created.id).pendingConfiguration?.autonomyMode).toBeUndefined();
    gate.resolve(); await vi.waitFor(() => expect(delivered).toEqual(["First instruction.", "Second instruction."])); await idle(instance, created.id);
    expect(observedModes).toEqual(["standard", "recon"]); expect(instance.get(created.id).queuedMessages).toEqual([]);
  });

  it("applies YOLO to an outstanding mode approval exactly once", async () => {
    let session: ConsoleSession;
    const instance = gateway(input => {
      session = engine(input);
      session.send = async () => {
        await input.approveTool!({ name: "bash", arguments: { command: "echo fixture" } });
        return outcome();
      };
      return session;
    });
    const created = instance.create({ autonomyMode: "standard" });
    await instance.send(created.id, "Fixture");
    await vi.waitFor(() => expect(instance.get(created.id).pendingDecisions).toHaveLength(1));
    const decision = instance.get(created.id).pendingDecisions[0]!;
    await instance.configure(created.id, { autonomyMode: "yolo" });
    expect(session!.autonomyMode).toBe("yolo");
    expect(instance.get(created.id).session.autonomyMode).toBe("yolo");
    expect(instance.get(created.id).pendingDecisions).toEqual([]);
    expect(instance.get(created.id).events.filter(event => event.type === "decision-resolved" && event.decisionId === decision.id)).toEqual([expect.objectContaining({ approved: true })]);
    expect(() => instance.resolveDecision(created.id, decision.id, { approve: true })).toThrow("no longer pending");
    await idle(instance, created.id);
  });

  it("opens a chat saved on a removed provider on the configured connection instead of failing", async () => {
    const instance = gateway();
    for (const runtime of [{ providerId: "copilot", model: "copilot/gpt-4o" }, { providerId: "cline", model: "cline-pass/glm-5.3" }, { providerId: "google", model: "gemini-2.5-pro" }]) {
      const created = instance.create({ title: "Legacy provider chat", runtime });
      const selection = (instance.get(created.id) as unknown as { selection?: Record<string, unknown> }).selection;
      expect(selection?.providerId).toBeUndefined();
      expect(selection?.model === undefined || selection.model === "gemini-2.5-pro").toBe(true);
      await instance.close(created.id);
    }
  });

  it("continues saved role and target context with explicit overrides taking precedence", async () => {
    const instance = gateway();
    const created = instance.create({ target: "https://original.example.test", role: "review", autonomyMode: "standard", runtime: { providerId: "openai", model: "saved-model", singleModel: true } });
    await instance.send(created.id, "Keep the working context."); await idle(instance, created.id);
    const saved = instance.save(created.id); await instance.close(created.id);
    expect(loadSession(saved.id, homes.at(-1))?.consoleState?.configuration?.runtime).toMatchObject({ providerId: "openai", model: "saved-model", singleModel: true });
    const restored = await instance.resume(saved.id);
    expect(restored).toMatchObject({ savedId: saved.id, role: "review", target: "https://original.example.test", autonomyMode: "standard", scopeConfigured: false });
    await instance.close(restored.id);
    const overridden = await instance.resume(saved.id, { target: "https://replacement.example.test", role: "audit" });
    expect(overridden).toMatchObject({ role: "audit", target: "https://replacement.example.test" });
  });

  it("rejects malformed raw inputs and corrupt saved messages rather than silently truncating a resume", async () => {
    const instance = gateway(); expect(() => instance.create({ autonomyMode: "unsafe" })).toThrow(ConsoleGatewayError);
    expect(() => instance.create({ scope: { in_scope: "*" } })).toThrow(ConsoleGatewayError);
    const created = instance.create(); await expect(instance.send(created.id, " ")).rejects.toBeInstanceOf(ConsoleGatewayError);
    expect(() => instance.eventsAfter(created.id, NaN)).toThrow(ConsoleGatewayError);
    expect(saveSession({ id: "corrupt", savedAt: 1, cwd: "/fixture", preview: "", messageCount: 2, messages: [{ role: "user", content: [{ type: "text", text: "Retained" }] }, { role: "assistant", content: [{ type: "unsupported" }] }] }, homes.at(-1))).toBe(true);
    await expect(instance.resume("corrupt")).rejects.toBeInstanceOf(ConsoleGatewayError);
  });
});


describe("ConsoleGateway isolated execution boundaries", () => {
  function isolatedGateway(model = "granted-model") {
    isolated.profile = "smolvm";
    const home = mkdtempSync(join(tmpdir(), "0-web-isolated-test-")); homes.push(home);
    const runtime = { resolvedModel: () => model, resolvedProvider: () => "chatgpt-codex", modelSelection: () => ({ agentModels: {}, singleModel: true, autoRoute: false }) };
    const info = { providerId: "chatgpt-codex", providerLabel: "ChatGPT", model, configured: true,
      connectionIdentity: "fixture-account", diagnostics: { valid: true, reason: null, message: null },
      agentModels: {}, singleModel: true, autoRoute: false, contextWindowTokens: 100_000 };
    isolated.runtimeFactory.mockResolvedValue({ runtime, info });
    let id = 0;
    const instance = new ConsoleGateway({ homeDir: home, projectPath: "/fixture", createId: () => `vm-${homes.length}-${++id}` });
    gateways.push(instance);
    return { instance, info };
  }
  function admitFixture() {
    const cleanup = vi.fn(async () => undefined);
    const reconfigure = vi.fn();
    isolated.localFactory.mockImplementation((config: ConsoleGatewaySessionFactoryInput, _db: unknown, options: { onExecution: (execution: unknown) => void }) => {
      const session = engine(config);
      session.cleanup = cleanup;
      session.reconfigureRuntime = reconfigure;
      options.onExecution({ backend: "smolvm", status: "ready", workspacePath: "/fixture" });
      return session;
    });
    return { cleanup, reconfigure };
  }

  it("never prices known worker tokens as the parent when the worker model is unknown", async () => {
    const { instance } = isolatedGateway("gpt-4o");
    isolated.localFactory.mockImplementation((input: ConsoleGatewaySessionFactoryInput): ConsoleSession => {
      const base = engine(input);
      return { ...base, async send(text, callbacks, options) {
        callbacks?.onUsage?.({ inputTokens: 100, outputTokens: 10, kind: "worker", turnTokensUsed: 110, turnTokenBudget: Infinity, iterations: 0, maxToolIterations: 100 });
        // The parent has a known runtime identity. It is a legitimate fallback
        // for this planner receipt, but must never price the unidentified child.
        callbacks?.onUsage?.({ inputTokens: 200, outputTokens: 20, kind: "planner", turnTokensUsed: 330, turnTokenBudget: Infinity, iterations: 1, maxToolIterations: 100 });
        return base.send(text, callbacks, options);
      } };
    });
    const chat = instance.create({});
    await instance.send(chat.id, "Review with one worker."); await idle(instance, chat.id);
    expect(instance.get(chat.id).usage).toMatchObject({ inputTokens: 300, outputTokens: 30, costUnavailable: true });
    expect(instance.get(chat.id).usage.costUsd).toBeCloseTo(estimateCost({ inputTokens: 200, outputTokens: 20 }, "gpt-4o"), 12);
  });

  it("prices engine-routed planner usage through the session's runtime identity", async () => {
    const { instance } = isolatedGateway("z-ai/glm-5.3-flash");
    isolated.localFactory.mockImplementation((input: ConsoleGatewaySessionFactoryInput): ConsoleSession => {
      const base = engine(input);
      return { ...base, async send(text, callbacks, options) {
        // Engine-shaped receipt: the planner usage arrives without a model and
        // must price via the session's runtime identity, not the bare event.
        callbacks?.onUsage?.({ inputTokens: 1_000, outputTokens: 100, kind: "planner", turnTokensUsed: 1_100, turnTokenBudget: Infinity, iterations: 0, maxToolIterations: 100 });
        callbacks?.onUsage?.({ inputTokens: 500, outputTokens: 50, kind: "planner", turnTokensUsed: 1_650, turnTokenBudget: Infinity, iterations: 1, maxToolIterations: 100 });
        return base.send(text, callbacks, options);
      } };
    });
    const chat = instance.create({});
    await instance.send(chat.id, "Price this turn."); await idle(instance, chat.id);
    expect(instance.get(chat.id).usage).toMatchObject({ inputTokens: 1_500, outputTokens: 150, costUnavailable: false, costKind: "estimated" });
    expect(instance.get(chat.id).usage.costUsd).toBeCloseTo(estimateCost({ inputTokens: 1_500, outputTokens: 150 }, "z-ai/glm-5.3-flash"), 12);
  });

  it("passes the lesson store to the host VM adapter without opening host tool resources", async () => {
    const { instance } = isolatedGateway(); admitFixture();
    const store = new LearningStore(join(homes.at(-1)!, "lessons.db"));
    try {
      instance.attachSourceLearning(store);
      const created = instance.create();
      await instance.send(created.id, "Inspect source"); await idle(instance, created.id);
      const config = isolated.localFactory.mock.calls[0]?.[0];
      expect(config.codebaseLearning).toBe(true);
      expect(config.learningStore).toBe(store);
      expect(config.pluginHost).toBeUndefined();
      expect(config.mcpHost).toBeUndefined();
      expect(isolated.pluginManager).not.toHaveBeenCalled();
      await instance.closeAll();
      expect(store.listKnowledge()).toEqual([]);
    } finally { store.close(); }
  });

  it("rejects a VM model/account change after history without changing the grant or transcript", async () => {
    const { instance, info } = isolatedGateway(); const { cleanup, reconfigure } = admitFixture();
    const created = instance.create({ runtime: { providerId: "chatgpt-codex", model: info.model } });
    await instance.send(created.id, "Keep the authorized account and model."); await idle(instance, created.id);
    const before = instance.get(created.id);
    await expect(instance.configure(created.id, { runtime: { providerId: "openai", model: "different-model" } })).rejects.toThrow(/grant is fixed/);
    await expect(instance.reloadConnection(created.id)).rejects.toThrow(/grant is fixed/);
    const after = instance.get(created.id);
    expect(after.messages).toEqual(before.messages);
    expect(after.runtime).toEqual(before.runtime);
    expect(after.pendingConfiguration).toBeUndefined();
    expect(isolated.applyRuntime).not.toHaveBeenCalled();
    expect(reconfigure).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
    expect(isolated.flushPlugins).not.toHaveBeenCalled();
  });

  it("rejects changing an admitted VM workspace before mutating chat metadata", async () => {
    const { instance } = isolatedGateway(); admitFixture();
    const created = instance.create({}); await instance.send(created.id, "Use the existing workspace."); await idle(instance, created.id);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "zero-vm-other-workspace-"))); homes.push(directory);
    const before = instance.get(created.id);
    await expect(instance.configure(created.id, { workspacePath: directory })).rejects.toThrow("workspace grant is fixed");
    expect(instance.get(created.id).workspacePath).toBe(before.workspacePath);
    expect(instance.get(created.id).execution).toEqual(before.execution);
  });
  it("refuses host workflow execution before initializing a selected VM chat", async () => {
    const { instance } = isolatedGateway();
    const created = instance.create();
    await expect(instance.getExecutionContext(created.id)).rejects.toThrow(/host execution is refused/);
    expect(isolated.runtimeFactory).not.toHaveBeenCalled();
    expect(isolated.localFactory).not.toHaveBeenCalled();
    expect(isolated.pluginManager).not.toHaveBeenCalled();
    expect(instance.get(created.id).execution).toMatchObject({ backend: "smolvm", status: "pending" });
  });

  it("retains selected VM failure without retrying a local session or opening host plugins", async () => {
    const { instance } = isolatedGateway();
    isolated.localFactory.mockImplementation(() => { throw new Error("Approved VM image unavailable; host fallback is refused."); });
    const created = instance.create();
    await expect(instance.send(created.id, "Inspect the approved workspace.")).rejects.toThrow(/host fallback is refused/);
    expect(isolated.localFactory).toHaveBeenCalledOnce();
    expect(isolated.pluginManager).not.toHaveBeenCalled();
    const snapshot = instance.get(created.id);
    expect(snapshot.execution).toMatchObject({ backend: "smolvm", status: "failed" });
    expect(snapshot.session.status).toBe("failed");
    expect(snapshot.messages).toEqual([]);
  });

  it("refuses an existing VM when the global profile changes instead of keeping stale execution", async () => {
    const { instance } = isolatedGateway(); admitFixture();
    const created = instance.create(); await instance.send(created.id, "Initial isolated turn."); await idle(instance, created.id);
    const before = instance.get(created.id).messages;
    isolated.profile = "local";
    await expect(instance.send(created.id, "Run after changing the profile.")).rejects.toThrow(/execution profile/i);
    expect(instance.get(created.id).messages).toEqual(before);
    expect(isolated.localFactory).toHaveBeenCalledOnce();
    expect(isolated.pluginManager).not.toHaveBeenCalled();
  });

  it("refuses a retained local session after selecting VM execution", async () => {
    const { instance } = isolatedGateway();
    isolated.profile = "local";
    const refresh = vi.fn(async () => undefined); const release = vi.fn();
    isolated.pluginManager.mockResolvedValue({ refresh, acquire: () => ({ host: undefined, release }) });
    isolated.localFactory.mockImplementation((config: ConsoleGatewaySessionFactoryInput) => engine(config));
    const created = instance.create();
    await instance.send(created.id, "Initial local turn."); await idle(instance, created.id);
    const before = instance.get(created.id);
    expect(before.execution).toMatchObject({ backend: "local", status: "ready" });
    isolated.profile = "smolvm";
    await expect(instance.send(created.id, "Continue inside the selected VM.")).rejects.toThrow(/execution profile/i);
    expect(instance.get(created.id).messages).toEqual(before.messages);
    expect(isolated.localFactory).toHaveBeenCalledOnce();
    expect(isolated.pluginManager).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(isolated.flushPlugins).toHaveBeenCalledOnce();
  });

  it("refuses VM worker delivery through the host mailbox without retaining an operator message", async () => {
    const { instance } = isolatedGateway(); admitFixture();
    const created = instance.create();
    await instance.send(created.id, "Start isolated work."); await idle(instance, created.id);
    const workerId = `${created.id}-sub-child`;
    eventBus.emit("subagent_lifecycle", { agent_id: workerId, parent_scan_id: created.id, status: "running", task: "Inspect", max_turns: 3 });
    expect(instance.worker(created.id, workerId).status).toBe("running");
    expect(() => instance.sendWorker(created.id, workerId, "Guest-only instruction.")).toThrow(/Host mailbox delivery is refused/);
    expect(instance.worker(created.id, workerId).operatorMessages ?? []).toEqual([]);
    expect(instance.eventsAfter(created.id).events.some((event) => event.type === "notice" && event.text.includes("Message delivered"))).toBe(false);
  });

});

describe("deferred browser workflow launches", () => {
  function fixture(overrides: Record<string, unknown> = {}) {
    let callbacks!: NonNullable<ConsoleGatewaySessionFactoryInput["workflowLifecycle"]>;
    let queued!: { requestId: string; status: string };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const instance = gateway(input => {
      callbacks = input.workflowLifecycle!;
      const session = engine(input);
      session.send = async () => {
        queued = await callbacks.invoke("start_run", { templateId: "repository-review", target: "/fixture", idempotencyKey: "request-1", ...overrides }) as typeof queued;
        await held;
        return outcome();
      };
      return session;
    });
    const invoke = vi.fn(async (_sessionId: string, name: string, _args: Record<string, unknown>) => {
      if (name === "get_template") return { template: { id: "repository-review", revision: 1 } };
      if (name === "start_run") return { runId: "run-1", status: "queued" };
      if (name === "get_run") return { runId: "run-1", status: "completed" };
      return {};
    });
    instance.attachWorkflowLifecycle({ invoke });
    const created = instance.create({ target: "/fixture" });
    return { instance, created, invoke, release, callbacks: () => callbacks, queued: () => queued };
  }

  it("queues during the active turn and launches only after idle operator approval", async () => {
    const f = fixture();
    await f.instance.send(f.created.id, "Run the repository workflow");
    await vi.waitFor(() => expect(f.queued()?.status).toBe("queued"));
    expect(f.invoke.mock.calls.some(call => call[1] === "start_run")).toBe(false);
    expect(f.instance.get(f.created.id).pendingDecisions).toEqual([]);
    f.release();
    await vi.waitFor(() => expect(f.instance.get(f.created.id).pendingDecisions).toHaveLength(1));
    expect(await f.callbacks().invoke("get_run", { runId: f.queued().requestId })).toMatchObject({ status: "awaiting-approval" });
    const launch = f.instance.get(f.created.id).pendingDecisions[0]!;
    expect(launch.call?.name).toBe("start_run");
    f.instance.resolveDecision(f.created.id, launch.id, { approve: true });
    await vi.waitFor(() => expect(f.invoke.mock.calls.some(call => call[1] === "start_run")).toBe(true));
    expect(f.invoke).toHaveBeenCalledWith(f.created.id, "start_run", expect.objectContaining({ revision: 1, target: "/fixture" }), { allowApply: false });
    await vi.waitFor(async () => expect(await f.callbacks().invoke("get_run", { runId: f.queued().requestId })).toMatchObject({ runId: "run-1", status: "completed" }));
  });

  it("cancels queued work without invoking the workflow runner", async () => {
    const f = fixture();
    await f.instance.send(f.created.id, "Run the repository workflow");
    await vi.waitFor(() => expect(f.queued()?.status).toBe("queued"));
    expect(await f.callbacks().invoke("cancel_run", { runId: f.queued().requestId })).toMatchObject({ status: "cancelled" });
    f.release(); await idle(f.instance, f.created.id);
    expect(f.invoke.mock.calls.some(call => call[1] === "start_run")).toBe(false);
    expect(f.instance.get(f.created.id).pendingDecisions).toEqual([]);
  });

  it("rejects a queued request when the owner configuration changes", async () => {
    const f = fixture();
    await f.instance.send(f.created.id, "Run the repository workflow");
    await vi.waitFor(() => expect(f.queued()?.status).toBe("queued"));
    await f.instance.setTarget(f.created.id, "/different-target");
    f.release(); await idle(f.instance, f.created.id);
    expect(await f.callbacks().invoke("get_run", { runId: f.queued().requestId })).toMatchObject({ status: "failed", error: expect.stringContaining("configuration changed") });
    expect(f.invoke.mock.calls.some(call => call[1] === "start_run")).toBe(false);
  });

  it("coalesces retries and rejects a changed request with the same key", async () => {
    const f = fixture();
    await f.instance.send(f.created.id, "Run workflow");
    await vi.waitFor(() => expect(f.queued()?.status).toBe("queued"));
    expect(await f.callbacks().invoke("start_run", { templateId: "repository-review", target: "/fixture", idempotencyKey: "request-1" })).toMatchObject({ requestId: f.queued().requestId });
    await expect(f.callbacks().invoke("start_run", { templateId: "repository-review", target: "/other", idempotencyKey: "request-1" })).rejects.toThrow("different workflow request");
    await f.callbacks().invoke("cancel_run", { runId: f.queued().requestId });
    f.release(); await idle(f.instance, f.created.id);
  });

  it("requires explicit idle approval before granting apply capability", async () => {
    const f = fixture({ allowApply: true });
    await f.instance.send(f.created.id, "Run fix and apply");
    await vi.waitFor(() => expect(f.queued()?.status).toBe("queued")); f.release();
    await vi.waitFor(() => expect(f.instance.get(f.created.id).pendingDecisions).toHaveLength(1));
    const decision = f.instance.get(f.created.id).pendingDecisions[0]!;
    expect(decision.title).toContain("permit reviewed changes");
    expect(f.invoke.mock.calls.some(call => call[1] === "start_run")).toBe(false);
    f.instance.resolveDecision(f.created.id, decision.id, { approve: true });
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledWith(f.created.id, "start_run", expect.objectContaining({ allowApply: true }), { allowApply: true }));
  });

  it("cancels the active turn's queued workflows when the operator stops that turn", async () => {
    const f = fixture();
    await f.instance.send(f.created.id, "Run workflow");
    await vi.waitFor(() => expect(f.queued()?.status).toBe("queued"));
    const cancel = f.instance.cancel(f.created.id);
    f.release(); await cancel;
    expect(await f.callbacks().invoke("get_run", { runId: f.queued().requestId })).toMatchObject({ status: "cancelled" });
    expect(f.invoke.mock.calls.some(call => call[1] === "start_run")).toBe(false);
  });

  it("cancels a run allocated while the owning chat closes", async () => {
    const f = fixture();
    let completeLaunch!: (value: { runId: string; status: string }) => void;
    const launching = new Promise<{ runId: string; status: string }>(resolve => { completeLaunch = resolve; });
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (sessionId, name, args) => name === "start_run" ? launching : original(sessionId, name, args));
    await f.instance.send(f.created.id, "Run workflow");
    await vi.waitFor(() => expect(f.queued()?.status).toBe("queued")); f.release();
    await vi.waitFor(() => expect(f.instance.get(f.created.id).pendingDecisions).toHaveLength(1));
    f.instance.resolveDecision(f.created.id, f.instance.get(f.created.id).pendingDecisions[0]!.id, { approve: true });
    await vi.waitFor(() => expect(f.invoke.mock.calls.some(call => call[1] === "start_run")).toBe(true));
    await f.instance.close(f.created.id);
    completeLaunch({ runId: "late-run", status: "queued" });
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledWith(f.created.id, "cancel_run", { runId: "late-run" }));
  });

  it("treats declined launch approval as cancellation", async () => {
    const f = fixture();
    await f.instance.send(f.created.id, "Run workflow");
    await vi.waitFor(() => expect(f.queued()?.status).toBe("queued")); f.release();
    await vi.waitFor(() => expect(f.instance.get(f.created.id).pendingDecisions).toHaveLength(1));
    f.instance.resolveDecision(f.created.id, f.instance.get(f.created.id).pendingDecisions[0]!.id, { approve: false });
    await vi.waitFor(async () => expect(await f.callbacks().invoke("get_run", { runId: f.queued().requestId })).toMatchObject({ status: "cancelled" }));
    expect(f.invoke.mock.calls.some(call => call[1] === "start_run")).toBe(false);
  });
});

it("acknowledges stop before an active turn finishes teardown", async () => {
 let release!: () => void;
 const teardown = new Promise<void>(resolve => { release = resolve; });
 const instance = gateway(input => {
  const session = engine(input);
  session.send = async () => { await teardown; return { ...outcome(), stopReason: "cancelled" }; };
  return session;
 });
 const created = instance.create(); await instance.send(created.id, "test");
 await instance.cancel(created.id);
 expect(instance.get(created.id).session.status).toBe("cancelling");
 expect(instance.get(created.id).session.cancellation?.phase).toBe("draining");
 expect(instance.get(created.id).events.some(event => event.type === "notice" && event.text.startsWith("Cancellation requested."))).toBe(true);
 release(); await idle(instance, created.id);
 expect(instance.get(created.id).session.status).toBe("ready");
});


describe("truthful cancellation reporting", () => {
  it("reports a bounded timeout while abort-ignoring work remains fenced and other sessions stay usable", async () => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<void>();
    const instance = gateway(input => {
      const session = engine(input);
      if (input.target === "stuck") session.send = async () => { await gate.promise; return outcome("Late completion"); };
      return session;
    });
    const stuck = instance.create({ target: "stuck" });
    const other = instance.create({ target: "other" });
    try {
      await instance.send(stuck.id, "Wait despite abort");
      const cancellation = await instance.cancel(stuck.id);
      expect(cancellation.status).toBe("cancelling");
      expect(cancellation.cancellation?.phase).toBe("draining");
      expect(Date.parse(cancellation.cancellation!.deadlineAt) - Date.parse(cancellation.cancellation!.requestedAt)).toBe(CONSOLE_CANCELLATION_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(CONSOLE_CANCELLATION_TIMEOUT_MS - 1);
      expect(instance.get(stuck.id).session.cancellation?.phase).toBe("draining");
      expect((await instance.cancel(stuck.id)).cancellation).toEqual(cancellation.cancellation);
      await vi.advanceTimersByTimeAsync(1);
      const timedOut = instance.get(stuck.id);
      expect(timedOut.session.status).toBe("cancelling");
      expect(timedOut.session.cancellation?.phase).toBe("timed_out");
      expect(timedOut.session.cancellation?.message).toContain("still draining");
      expect(timedOut.lastOutcome).toBeNull();
      expect(timedOut.events.some(event => event.type === "turn-complete")).toBe(false);
      await expect(instance.send(stuck.id, "Must not overlap")).rejects.toThrow("already processing");
      await expect(instance.reloadConnection(stuck.id)).rejects.toThrow(/active|finish|Wait/i);
      await instance.send(other.id, "Other sessions still work");
      await vi.waitFor(() => expect(instance.get(other.id).session.status).toBe("ready"));
      expect(instance.get(stuck.id).session.status).toBe("cancelling");
      expect((await instance.cancel(stuck.id)).cancellation?.deadlineAt).toBe(cancellation.cancellation!.deadlineAt);
      gate.resolve();
      await vi.waitFor(() => expect(instance.get(stuck.id).session.status).toBe("ready"));
      expect(instance.get(stuck.id).session.cancellation).toBeUndefined();
      expect(instance.get(stuck.id).lastOutcome?.stopReason).toBe("cancelled");
      await instance.send(stuck.id, "A later turn can start after cleanup");
      await vi.waitFor(() => expect(instance.get(stuck.id).session.status).toBe("ready"));
      await vi.advanceTimersByTimeAsync(CONSOLE_CANCELLATION_TIMEOUT_MS);
      expect(instance.get(stuck.id).session.cancellation).toBeUndefined();
      expect(instance.get(other.id).session.status).toBe("ready");
    } finally {
      gate.resolve();
      await vi.waitFor(() => expect(instance.get(stuck.id).session.status).toBe("ready"));
      vi.useRealTimers();
    }
  });

  it("clears the reporting deadline when cooperative cancellation finishes promptly", async () => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<void>();
    const instance = gateway(input => {
      const session = engine(input);
      session.send = async () => { await gate.promise; return { ...outcome(), stopReason: "cancelled" }; };
      return session;
    });
    const created = instance.create();
    try {
      await instance.send(created.id, "Stop promptly");
      await instance.cancel(created.id);
      gate.resolve();
      await vi.waitFor(() => expect(instance.get(created.id).session.status).toBe("ready"));
      const before = instance.get(created.id).cursor;
      await vi.advanceTimersByTimeAsync(CONSOLE_CANCELLATION_TIMEOUT_MS * 2);
      expect(instance.get(created.id).cursor).toBe(before);
      expect(instance.get(created.id).session.cancellation).toBeUndefined();
    } finally { gate.resolve(); vi.useRealTimers(); }
  });
});


describe("explicit connection reload", () => {
  it("retries failed initialization in the same conversation without discarding selection or history", async () => {
    const factory = vi.fn(async (input: ConsoleGatewaySessionFactoryInput) => engine(input));
    factory.mockRejectedValueOnce(new Error("Connection expired"));
    const instance = gateway(factory);
    const created = instance.create({ title: "Keep this chat", runtime: { providerId: "chatgpt-codex", model: "gpt-6.1-sol", reasoningEffort: "high" } });
    await expect(instance.send(created.id, "Retry after reconnect")).rejects.toThrow("Connection expired");
    const before = instance.get(created.id);
    const result = await instance.reloadConnection(created.id);
    expect(result.id).toBe(created.id); expect(result.title).toBe("Keep this chat"); expect(result.status).toBe("ready");
    expect(instance.get(created.id).messages).toEqual(before.messages);
    expect(factory).toHaveBeenCalledTimes(2); expect(isolated.reloadConnection).not.toHaveBeenCalled();
    await instance.send(created.id, "Continue with the same model"); await idle(instance, created.id);
    const stored = loadSession(created.id, homes.at(-1)!);
    expect(stored?.consoleState?.configuration?.runtime).toMatchObject({ providerId: "chatgpt-codex", model: "gpt-6.1-sol", reasoningEffort: "high" });
  });
  it.each([true, false])("preserves transcript and workspace plan policy (%s) on initialization and reload", async (allowChatGptPlan) => {
    const home = mkdtempSync(join(tmpdir(), "0-web-refresh-test-")); homes.push(home);
    const runtime = { resolvedModel: () => "gpt-6.1-sol", resolvedProvider: () => "chatgpt-codex", modelSelection: () => ({ agentModels: {}, singleModel: true, autoRoute: false }) };
    const info = { providerId: "chatgpt-codex", providerLabel: "ChatGPT", model: "gpt-6.1-sol", configured: true, connectionIdentity: "account-a", diagnostics: { valid: true, reason: null, message: null }, agentModels: {}, singleModel: true, autoRoute: false, reasoning: { effort: "high", options: ["high"] }, contextWindowTokens: 100_000 };
    isolated.runtimeFactory.mockResolvedValue({ runtime, info });
    isolated.pluginManager.mockResolvedValue({ refresh: async () => undefined, acquire: () => ({ host: {}, release: () => undefined }) });
    const reconfigure = vi.fn(); const cleanup = vi.fn(async () => undefined);
    isolated.localFactory.mockImplementation((config: ConsoleGatewaySessionFactoryInput) => { const session = engine(config); session.reconfigureRuntime = reconfigure; session.cleanup = cleanup; return session; });
    const instance = new ConsoleGateway({ homeDir: home, projectPath: "/fixture", allowChatGptPlan }); gateways.push(instance);
    const created = instance.create({ runtime: { providerId: "chatgpt-codex", model: info.model } });
    await instance.send(created.id, "Keep the history"); await idle(instance, created.id);
    const before = instance.get(created.id);
    isolated.reloadConnection.mockResolvedValue({ ...info, connectionIdentity: "account-b" });
    const result = await instance.reloadConnection(created.id);
    expect(result.runtime?.connectionIdentity).toBe("account-b"); expect(instance.get(created.id).messages).toEqual(before.messages);
    expect(isolated.runtimeFactory).toHaveBeenCalledWith(expect.anything(), { allowChatGptPlan });
    expect(isolated.reloadConnection).toHaveBeenCalledWith(runtime, { allowChatGptPlan }); expect(reconfigure).toHaveBeenCalledWith({ contextWindowTokens: 100_000 });
    expect(cleanup).not.toHaveBeenCalled(); expect(isolated.localFactory).toHaveBeenCalledTimes(1);
  });
  it("refuses active turns and running owned workers before reconnecting", async () => {
    const gate = Promise.withResolvers<void>();
    const instance = gateway(input => { const session = engine(input); session.send = async () => { await gate.promise; return outcome(); }; return session; });
    const created = instance.create(); await instance.send(created.id, "Working");
    await expect(instance.reloadConnection(created.id)).rejects.toThrow("current turn");
    gate.resolve(); await idle(instance, created.id);
    eventBus.emit("subagent_lifecycle", { agent_id: `${created.id}-worker`, parent_scan_id: created.id, status: "running", task: "Inspect", max_turns: 3 });
    await expect(instance.reloadConnection(created.id)).rejects.toThrow("active agents");
    expect(isolated.reloadConnection).not.toHaveBeenCalled();
  });
  it("tracks active turns across worker queued, running, and parked transitions", async () => {
    const instance = gateway();
    const created = instance.create();
    await instance.send(created.id, "Init session");
    await idle(instance, created.id);

    expect(instance.hasActiveTurns()).toBe(false);

    // Initial worker parks
    eventBus.emit("subagent_lifecycle", {
      agent_id: `${created.id}-worker`,
      parent_scan_id: created.id,
      status: "parked",
      task: "Inspect",
      max_turns: 3,
    });
    // Parked worker does not make the session active
    expect(instance.hasActiveTurns()).toBe(false);

    // Revived worker becomes queued while waiting for queue capacity
    eventBus.emit("subagent_lifecycle", {
      agent_id: `${created.id}-worker`,
      parent_scan_id: created.id,
      status: "queued",
      task: "Inspect next",
      max_turns: 3,
    });
    expect(instance.hasActiveTurns()).toBe(true);

    // Revived worker acquires slot and runs
    eventBus.emit("subagent_lifecycle", {
      agent_id: `${created.id}-worker`,
      parent_scan_id: created.id,
      status: "running",
      task: "Inspect next",
      max_turns: 3,
    });
    expect(instance.hasActiveTurns()).toBe(true);

    // Revived worker completes and returns to parked
    eventBus.emit("subagent_lifecycle", {
      agent_id: `${created.id}-worker`,
      parent_scan_id: created.id,
      status: "parked",
      task: "Inspect next",
      max_turns: 3,
    });
    expect(instance.hasActiveTurns()).toBe(false);
  });
});

describe("chat schedule approval",()=>{
 it("routes schedules independently of workflow execution services",async()=>{
  let callbacks!:NonNullable<ConsoleGatewaySessionFactoryInput["workflowLifecycle"]>;
  const instance=gateway(input=>{callbacks=input.workflowLifecycle!;return engine(input);});
  const invoke=vi.fn(async()=>({schedules:[]}));
  instance.attachScheduleLifecycle({invoke});
  const created=instance.create();await instance.send(created.id,"List schedules");await idle(instance,created.id);
  await expect(callbacks.invoke("list_schedules",{})).resolves.toEqual({schedules:[]});
  expect(invoke).toHaveBeenCalledWith(created.id,"list_schedules",{},expect.objectContaining({activationApproved:false}));
  await expect(callbacks.invoke("list_templates",{})).rejects.toThrow("Workflow lifecycle is unavailable");
 });
 it("saves drafts directly but requires a decision before activating recurring execution",async()=>{
  let callbacks!:NonNullable<ConsoleGatewaySessionFactoryInput["workflowLifecycle"]>;
  const instance=gateway(input=>{callbacks=input.workflowLifecycle!;return engine(input);});
  instance.attachWorkflowLifecycle({invoke:async()=>({})});
  const invoke=vi.fn(async(_session:string,name:string,_args:Record<string,unknown>,_context?:unknown)=> name==="list_schedules" ? {schedules:[{id:"schedule-1",version:3}]} : {trigger:{id:"schedule-1"}});
  instance.attachScheduleLifecycle({invoke});
  const created=instance.create();await instance.send(created.id,"Edit my schedule");await idle(instance,created.id);
  await callbacks.invoke("create_schedule",{workflowId:"workflow-1",workflowRevision:1,cadence:"daily",startAt:"2026-12-01T09:00:00Z",timezone:"UTC"});
  expect(invoke).toHaveBeenCalledWith(created.id,"create_schedule",expect.anything(),expect.objectContaining({activationApproved:false}));
  const enabling=callbacks.invoke("update_schedule",{id:"schedule-1",enabled:true});
  await vi.waitFor(()=>expect(instance.get(created.id).pendingDecisions).toHaveLength(1));
  expect(invoke.mock.calls.some(call=>call[1]==="update_schedule")).toBe(false);
  const decision=instance.get(created.id).pendingDecisions[0]!;
  expect(decision.call?.name).toBe("update_schedule");
  instance.resolveDecision(created.id,decision.id,{approve:true});await enabling;
  expect(invoke).toHaveBeenCalledWith(created.id,"update_schedule",{id:"schedule-1",enabled:true,expectedVersion:3},expect.objectContaining({activationApproved:true}));
 });
});

describe("owned execution force stop", () => {
  it("waits for confirmed resource exit, keeps the queue paused and leaves another chat usable", async () => {
    const gate = Promise.withResolvers<void>();
    const confirmed = Promise.withResolvers<void>();
    const instance = gateway(input => {
      const session = engine(input);
      if (input.target === "owned-stuck") {
        session.send = async () => { await gate.promise; return outcome("Interrupted"); };
        session.forceStop = async () => { await confirmed.promise; gate.resolve(); return { processExited: true, resourcesStopped: true, quarantined: false }; };
      }
      return session;
    });
    const stuck = instance.create({ target: "owned-stuck" });
    const other = instance.create({ target: "other" });
    try {
      await instance.send(stuck.id, "Wait");
      await instance.send(stuck.id, { text: "Keep queued", mode: "queue" });
      const stopping = instance.forceStop(stuck.id);
      expect(instance.get(stuck.id).session.cancellation?.phase).toBe("force_stopping");
      await expect(instance.send(stuck.id, "Must not overlap")).rejects.toThrow();
      await instance.send(other.id, "Still usable");
      await vi.waitFor(() => expect(instance.get(other.id).session.status).toBe("ready"));
      confirmed.resolve();
      expect((await stopping).status).toBe("ready");
      expect(instance.get(stuck.id).queuedMessages.map(message => message.text)).toEqual(["Keep queued"]);
      expect(instance.get(stuck.id).usage.costUnavailable).toBe(true);
    } finally { confirmed.resolve(); gate.resolve(); await instance.closeAll(); }
  });
  it("keeps unconfirmed execution quarantined even after its old turn settles", async () => {
    const gate = Promise.withResolvers<void>();
    const instance = gateway(input => {
      const session = engine(input);
      session.send = async () => { await gate.promise; return outcome("Late teardown"); };
      session.forceStop = async () => { gate.resolve(); return { processExited: true, resourcesStopped: false, quarantined: true, error: "Creation ownership unresolved" }; };
      return session;
    });
    const created = instance.create({ target: "unconfirmed" });
    try {
      await instance.send(created.id, "Wait");
      await expect(instance.forceStop(created.id)).rejects.toThrow("Creation ownership unresolved");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(instance.get(created.id).session.status).toBe("cancelling");
      expect(instance.get(created.id).session.cancellation?.phase).toBe("unconfirmed");
      await expect(instance.send(created.id, "Must stay fenced")).rejects.toThrow();
      const saved = instance.save(created.id);
      await instance.close(created.id);
      const resumed = await instance.resume(saved.id);
      expect(resumed.status).toBe("cancelling");
      expect(resumed.cancellation?.phase).toBe("unconfirmed");
      await expect(instance.send(resumed.id, "Restart must not clear quarantine")).rejects.toThrow();
    } finally { gate.resolve(); await instance.closeAll(); }
  });
});

describe("strict cyber access program selection", () => {
  it("accepts explicit enum/null values and rejects misspelled or structured program requests", () => {
    const instance = gateway(input => engine(input));
    for (const cyberAccessProgram of ["standard", "daybreak_blue", "daybreak_red", null] as const) {
      expect(instance.create({ runtime: { cyberAccessProgram } }).id).toBeTruthy();
    }
    for (const cyberAccessProgram of ["blue", "DAYBREAK_BLUE", true, {}, ["daybreak_blue"]]) {
      expect(() => instance.create({ runtime: { cyberAccessProgram } })).toThrow("Unsupported cyber access program");
    }
    expect(() => instance.create({ runtime: { accessProgram: "daybreak_blue" } })).toThrow();
    expect(() => instance.create({ runtime: { cyberAccessProgram: "daybreak_blue" }, modelSource: { kind: "local", grantId: "00000000-0000-4000-8000-000000000001" } })).toThrow("direct canonical OpenAI or ChatGPT connection");
  });
});

it("does not silently ignore a cyber selection on a custom console engine", async () => {
  const factory = vi.fn((input: ConsoleGatewaySessionFactoryInput) => engine(input));
  const instance = gateway(factory);
  const chat = instance.create({ runtime: { cyberAccessProgram: "daybreak_blue" } });
  await expect(instance.send(chat.id, "Synthetic request")).rejects.toThrow("custom console engine");
  expect(factory).not.toHaveBeenCalled();
});

it("privately binds saved program resume and requires explicit clear or reselect after account change", async () => {
  const home = mkdtempSync(join(tmpdir(), "0-web-program-binding-")); homes.push(home);
  const identityA = "a".repeat(64); const identityB = "b".repeat(64); let activeIdentity = identityA;
  const runtime = { resolvedModel: () => "gpt-6.1-sol", resolvedProvider: () => "openai", modelSelection: () => ({ agentModels: {}, singleModel: true, autoRoute: false }) };
  const info = () => ({ providerId: "openai", providerLabel: "OpenAI", model: "gpt-6.1-sol", configured: true, connectionIdentity: activeIdentity, diagnostics: { valid: true, reason: null, message: null }, agentModels: {}, singleModel: true, autoRoute: false, reasoning: null, contextWindowTokens: 100_000, accessProgram: { requested: "daybreak_blue", options: ["daybreak_blue"] } });
  isolated.runtimeFactory.mockImplementation(async (selection, policy) => {
    if (selection.cyberAccessProgram != null && policy.requiredProgramConnectionIdentity !== undefined && policy.requiredProgramConnectionIdentity !== activeIdentity) throw new Error("Saved program connection changed");
    return { runtime, info: { ...info(), accessProgram: { requested: selection.cyberAccessProgram ?? null, options: ["daybreak_blue"] } } };
  });
  isolated.applyRuntime.mockImplementation(async (_runtime, selection) => ({ ...info(), accessProgram: { requested: selection.cyberAccessProgram ?? null, options: ["daybreak_blue"] } }));
  isolated.localFactory.mockImplementation((config: ConsoleGatewaySessionFactoryInput) => engine(config));
  isolated.pluginManager.mockResolvedValue({ refresh: async () => undefined, acquire: () => ({ host: {}, release: () => undefined }) });
  const first = new ConsoleGateway({ homeDir: home, projectPath: "/fixture" }); gateways.push(first);
  const created = first.create({ runtime: { providerId: "openai", model: "gpt-6.1-sol", cyberAccessProgram: "daybreak_blue" } });
  await first.send(created.id, "Keep history"); await idle(first, created.id); await first.close(created.id);
  const saved = loadSession(created.id, home)!;
  expect(saved.consoleState?.configuration?.runtime.connectionIdentity).toBe(identityA);
  const same = new ConsoleGateway({ homeDir: home, projectPath: "/fixture" }); gateways.push(same);
  expect((await same.resume(created.id)).runtime?.accessProgram?.requested).toBe("daybreak_blue");
  await same.closeAll(); activeIdentity = identityB;
  const changed = new ConsoleGateway({ homeDir: home, projectPath: "/fixture" }); gateways.push(changed);
  await expect(changed.resume(created.id, { runtime: { model: "gpt-6.1-sol" } })).rejects.toThrow("connection changed");
  expect(loadSession(created.id, home)?.consoleState?.configuration?.runtime).toMatchObject({ connectionIdentity: identityA, cyberAccessProgram: "daybreak_blue" });
  expect((await changed.resume(created.id, { runtime: { cyberAccessProgram: null } })).runtime?.accessProgram?.requested).toBeNull();
  expect(() => changed.create({ runtime: { connectionIdentity: identityB, cyberAccessProgram: "daybreak_blue" } })).toThrow();
});


it("rejects unsupported worker transport transitions before changing the captured runtime", async () => {
  const reconfigure = vi.fn();
  const instance = gateway(input => ({ ...engine(input), forceStop: async () => ({ processExited: true, resourcesStopped: true, quarantined: false }), reconfigureRuntime: reconfigure }));
  const chat = instance.create({ title: "Keep history" });
  await instance.send(chat.id, "Preserve context"); await idle(instance, chat.id);
  const history = instance.get(chat.id).messages;
  await expect(instance.setRuntime(chat.id, { providerId: "chatgpt-plan" })).rejects.toThrow("Start a new chat");
  expect(reconfigure).not.toHaveBeenCalled(); expect(instance.get(chat.id).messages).toEqual(history);
  expect(instance.get(chat.id).session.status).toBe("ready");
});

it("persists quarantine when an explicit worker runtime change is not acknowledged", async () => {
  const instance = gateway(input => ({ ...engine(input), forceStop: async () => ({ processExited: true, resourcesStopped: true, quarantined: false }),
    reconfigureRuntime: async () => { throw new Error("Synthetic rebind failed"); } }));
  const chat = instance.create({}); await instance.send(chat.id, "Keep context"); await idle(instance, chat.id);
  await expect(instance.setRuntime(chat.id, { model: "synthetic-model" })).rejects.toThrow("Synthetic rebind failed");
  expect(instance.get(chat.id).session.status).toBe("cancelling");
  const saved = instance.save(chat.id);
  expect(loadSession(saved.id, homes.at(-1))?.consoleState?.executionQuarantine?.reason).toContain("runtime change");
  await expect(instance.send(chat.id, "Must not run with unconfirmed selection")).rejects.toThrow();
});


it("awaits explicit worker runtime acknowledgement before completing configuration", async () => {
  const ack = Promise.withResolvers<void>();
  const reconfigure = vi.fn(async () => { await ack.promise; });
  const instance = gateway(input => ({ ...engine(input), forceStop: async () => ({ processExited: true, resourcesStopped: true, quarantined: false }), reconfigureRuntime: reconfigure }));
  const chat = instance.create({}); await instance.send(chat.id, "Keep context"); await idle(instance, chat.id);
  let settled = false;
  const changing = instance.setRuntime(chat.id, { model: "next-model" }).then(value => { settled = true; return value; });
  try {
    await vi.waitFor(() => expect(reconfigure).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    ack.resolve(); await changing;
    expect(settled).toBe(true);
  } finally { ack.resolve(); await changing; }
});

it.each(["resource-proof", "cleanup", "undefined-cleanup", "null-cleanup"])("quarantines rejected startup with unconfirmed %s and never retries its factory", async failure => {
  const send = vi.fn();
  const factory = vi.fn((input: ConsoleGatewaySessionFactoryInput) => ({ ...engine(input), ready: Promise.reject(new Error("Synthetic startup failure")), send,
    forceStop: async () => ({ processExited: true, resourcesStopped: failure !== "resource-proof", quarantined: failure === "resource-proof" }),
    cleanup: async () => { if (failure === "undefined-cleanup") throw undefined; if (failure === "null-cleanup") throw null; throw new Error("Synthetic cleanup unconfirmed"); } }));
  const instance = gateway(factory), home = homes.at(-1)!;
  const chat = instance.create({ title: "Keep startup ownership" });
  await expect(instance.send(chat.id, "Must not dispatch")).rejects.toThrow("Synthetic startup failure");
  expect(instance.get(chat.id).session.status).toBe("cancelling");
  await expect(instance.send(chat.id, "Must not retry")).rejects.toThrow("Startup cleanup");
  expect(factory).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
  const saved = instance.save(chat.id);
  expect(loadSession(saved.id, home)?.consoleState?.executionQuarantine?.reason).toContain("Startup cleanup");
  if (failure === "undefined-cleanup") await expect(instance.close(chat.id)).rejects.toBeUndefined();
  else if (failure === "null-cleanup") await expect(instance.close(chat.id)).rejects.toBeNull();
  else await expect(instance.close(chat.id)).rejects.toThrow("Synthetic cleanup unconfirmed");
  const reopened = new ConsoleGateway({ homeDir: home, projectPath: "/fixture", createSession: factory }); gateways.push(reopened);
  const resumed = await reopened.resume(saved.id); expect(resumed.status).toBe("cancelling");
  await expect(reopened.send(resumed.id, "Must stay blocked after restart")).rejects.toThrow("Startup cleanup");
  expect(factory).toHaveBeenCalledOnce();
});

it("force-stops a published startup controller before ready and never dispatches its late-ready turn", async () => {
  const ready = Promise.withResolvers<void>(), oldSend = vi.fn(); let first = true;
  const factory = vi.fn((input: ConsoleGatewaySessionFactoryInput) => {
    if (!first) return engine(input); first = false;
    return { ...engine(input), ready: ready.promise, send: oldSend, forceStop: async () => ({ processExited: true, resourcesStopped: true, quarantined: false }) };
  });
  const instance = gateway(factory), chat = instance.create({});
  const sending = expect(instance.send(chat.id, "Never dispatch original request")).rejects.toThrow(/startup execution was stopped/);
  await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
  expect(instance.get(chat.id).session.execution?.status).toBe("pending");
  expect((await instance.cancel(chat.id)).cancellation?.forceStopAvailable).toBe(true);
  await instance.send(chat.id, { text: "Retain queued startup message", mode: "queue" });
  expect((await instance.forceStop(chat.id)).status).toBe("ready"); await sending;
  ready.resolve(); await new Promise(resolve => setTimeout(resolve, 10));
  expect(oldSend).not.toHaveBeenCalled();
  expect(instance.get(chat.id).queuedMessages.map(item => item.text)).toEqual(["Retain queued startup message"]);
  expect(instance.get(chat.id).messages).toEqual([]);
  await instance.send(chat.id, "Explicit new request"); await idle(instance, chat.id);
  expect(oldSend).not.toHaveBeenCalled(); expect(factory).toHaveBeenCalledTimes(2);
});

it("merges failed-resume startup quarantine into original private program binding and history", async () => {
  const { LlmApiRuntime } = await import("@0/engine");
  const { describeWebConsoleRuntime } = await import("./operator-services.js");
  const home = mkdtempSync(join(tmpdir(), "0-startup-quarantine-resume-")); homes.push(home);
  const runtime = new LlmApiRuntime({ type: "api", timeout: 1000, provider: "openai", model: "gpt-fixture", cyberAccessProgram: "daybreak_blue", env: { OPENAI_API_KEY: "synthetic", OPENAI_WIRE_API: "responses", OPENAI_BASE_URL: "https://api.openai.com/v1", ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1", ZERO_LLM_FALLBACK: "" } });
  isolated.runtimeFactory.mockResolvedValue({ runtime, info: describeWebConsoleRuntime(runtime) });
  isolated.pluginManager.mockResolvedValue({ refresh: async () => undefined, acquire: () => ({ host: {}, release: () => undefined }) });
  isolated.localFactory.mockImplementation(input => engine(input));
  const first = new ConsoleGateway({ homeDir: home, projectPath: "/fixture" }); gateways.push(first);
  const chat = first.create({ runtime: { providerId: "openai", model: "gpt-fixture", cyberAccessProgram: "daybreak_blue" } });
  await first.send(chat.id, "Retain authoritative saved history"); await idle(first, chat.id); await first.close(chat.id);
  const original = loadSession(chat.id, home)!;
  isolated.localFactory.mockImplementation(input => ({ ...engine(input), ready: Promise.reject(new Error("Synthetic resume startup failure")),
    forceStop: async () => ({ processExited: true, resourcesStopped: false, quarantined: true }), cleanup: async () => { throw new Error("Unknown owned startup resources"); } }));
  const reopened = new ConsoleGateway({ homeDir: home, projectPath: "/fixture" }); gateways.push(reopened);
  await expect(reopened.resume(chat.id)).rejects.toThrow("Synthetic resume startup failure");
  const updated = loadSession(chat.id, home)!;
  expect(updated.messages).toEqual(original.messages); expect(updated.consoleState?.configuration).toEqual(original.consoleState?.configuration);
  expect(updated.consoleState?.configuration?.runtime).toMatchObject({ cyberAccessProgram: "daybreak_blue", connectionIdentity: runtime.connectionIdentity() });
  expect(updated.consoleState?.executionQuarantine?.reason).toContain("Startup cleanup");
  const calls = isolated.localFactory.mock.calls.length;
  const third = new ConsoleGateway({ homeDir: home, projectPath: "/fixture" }); gateways.push(third);
  const blocked = await third.resume(chat.id); expect(blocked.status).toBe("cancelling");
  await expect(third.send(blocked.id, "Cannot bypass quarantine")).rejects.toThrow("Startup cleanup");
  expect(isolated.localFactory).toHaveBeenCalledTimes(calls);
  await expect(reopened.close(reopened.list()[0]!.id)).rejects.toThrow("Unknown owned startup resources");
});

it("does not dispatch an initializing request when cooperative cancel precedes late readiness", async () => {
  const ready = Promise.withResolvers<void>(), send = vi.fn();
  const factory = vi.fn((input: ConsoleGatewaySessionFactoryInput) => ({ ...engine(input), ready: ready.promise, send,
    forceStop: async () => ({ processExited: true, resourcesStopped: true, quarantined: false }) }));
  const instance = gateway(factory), chat = instance.create({});
  const sending = expect(instance.send(chat.id, "Do not infer after cancel")).rejects.toThrow("Startup execution is stopping");
  await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
  await instance.cancel(chat.id); ready.resolve(); await sending;
  expect(send).not.toHaveBeenCalled(); expect(instance.get(chat.id).messages).toEqual([]);
  expect(instance.get(chat.id).session.status).toBe("ready");
});

it("preserves a divergent private branch under a new ID without replacing another gateway history", async () => {
  const home = mkdtempSync(join(tmpdir(), "0-review-stale-writer-")); homes.push(home);
  const a = new ConsoleGateway({homeDir:home,projectPath:join(home,"project-a"),dbPath:join(home,"a.db"),createSession:engine});
  const b = new ConsoleGateway({homeDir:home,projectPath:join(home,"project-b"),dbPath:join(home,"b.db"),createSession:engine});
  gateways.push(a,b);
  const seeded = a.create({title:"Shared base"});
  await a.send(seeded.id,"BASE retained evidence"); await idle(a,seeded.id); await a.close(seeded.id);
  const branchA=await a.resume(seeded.id); const branchB=await b.resume(seeded.id);
  await a.send(branchA.id,"A branch evidence"); await idle(a,branchA.id);
  await b.send(branchB.id,"B newer branch evidence"); await idle(b,branchB.id);
  const before=loadSession(seeded.id,home)!;
  expect(JSON.stringify(before.messages)).toContain("B newer branch evidence");
  expect(JSON.stringify(a.get(branchA.id).messages)).toContain("A branch evidence");
  const liveBefore = a.get(branchA.id);
  const snapshot = a.saveAs(branchA.id);
  expect(snapshot.id).not.toBe(seeded.id);
  expect(a.get(branchA.id)).toEqual(liveBefore);
  expect(JSON.stringify(loadSession(snapshot.id,home)?.messages)).toContain("A branch evidence");
  const after=loadSession(seeded.id,home)!;
  expect(after).toEqual(before);
  expect(JSON.stringify(after.messages)).toContain("B newer branch evidence");
  expect(JSON.stringify(b.get(branchB.id).messages)).toContain("B newer branch evidence");
});


it("save-as retains private native payload and paused context without changing scan identity", async () => {
  let captured: ConsoleSession | undefined;
  const instance=gateway(input => captured=engine(input));
  const chat=instance.create({target:"https://fixture.example"});
  await instance.send(chat.id,"Private branch"); await idle(instance,chat.id);
  captured!.messages.push({role:"assistant",content:[{type:"text",text:"Private result"}],providerRaw:{provider:"fixture",output:[{encrypted_content:"synthetic-private-native"}]}} as NativeMessage);
  instance.save(chat.id); await instance.close(chat.id);
  const original=loadSession(chat.id,homes.at(-1))!;
  original.consoleState!.queuedMessages=[{id:"paused-one",text:"Keep paused request",createdAt:"2026-11-09T00:00:00Z"}];
  original.consoleState!.stagedPrompt="Retain staged context";
  expect(saveSession(original,homes.at(-1))).toBe(true);
  const resumed=await instance.resume(chat.id);
  const scanId=captured!.scanId, before=instance.get(resumed.id);
  const saved=instance.saveAs(resumed.id), privateCopy=loadSession(saved.id,homes.at(-1))!;
  expect(privateCopy.messages).toEqual(captured!.messages);
  expect(JSON.stringify(privateCopy.messages)).toContain("synthetic-private-native");
  expect(privateCopy.consoleState?.queuedMessages.map(message=>message.text)).toEqual(["Keep paused request"]);
  expect(privateCopy.consoleState?.stagedPrompt).toBe("Retain staged context");
  expect(instance.get(resumed.id)).toEqual(before); expect(captured!.scanId).toBe(scanId);
});


it("rejects save-as until initialization and owned work are idle", async()=>{
  const ready=Promise.withResolvers<void>(), finished=Promise.withResolvers<void>();
  let sent=0;
  const instance=gateway(input=>({...engine(input),ready:ready.promise,async send(text,callbacks,options){sent++;await finished.promise;return engine(input).send(text,callbacks,options);}}));
  const chat=instance.create({}); const pending=instance.send(chat.id,"Do not duplicate execution");
  await vi.waitFor(()=>expect(instance.get(chat.id).session.status).toBe("working"));
  expect(()=>instance.saveAs(chat.id)).toThrow(); ready.resolve(); await pending;
  await vi.waitFor(()=>expect(sent).toBe(1)); expect(()=>instance.saveAs(chat.id)).toThrow();
  finished.resolve(); await idle(instance,chat.id); expect(()=>instance.saveAs(chat.id)).not.toThrow(); expect(sent).toBe(1);
});

it("retains a quiescent quarantine marker in save-as without permitting execution",async()=>{
  const instance=gateway(input=>({...engine(input),ready:Promise.reject(new Error("Synthetic startup failure")),forceStop:async()=>({processExited:true,resourcesStopped:false,quarantined:true})}));
  const chat=instance.create({});await expect(instance.send(chat.id,"Retain evidence")).rejects.toThrow("Synthetic startup failure");
  const before=instance.get(chat.id);const copy=instance.saveAs(chat.id);
  expect(loadSession(copy.id,homes.at(-1))?.consoleState?.executionQuarantine?.reason).toContain("Startup cleanup");
  expect(instance.get(chat.id)).toEqual(before);
  await expect(instance.send(chat.id,"Still blocked")).rejects.toThrow("Startup cleanup");
  const resumed=await instance.resume(copy.id);
  await expect(instance.send(resumed.id,"Copy is also blocked")).rejects.toThrow("Startup cleanup");
  expect(()=>instance.saveAs(resumed.id)).toThrow("initialization");
});


it("keeps an abort-ignoring spawn_agents batch fenced until confirmed drain and leaves another chat usable", async () => {
  vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "1");
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  const started = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  let childStarts = 0, parentCalls = 0, stopped = false;
  const childRuntime: import("@0/engine").NativeRuntime = { type: "api", isAvailable: async () => true,
    executeNative: async (_system, _messages, _tools, _callbacks, signal) => {
      childStarts++; started.resolve(signal!);
      await release.promise; // The real native loop awaits a runtime that ignores abort.
      return { content: [{ type: "tool_use", id: "child-done", name: "done", input: { summary: "Drained" } }], stopReason: "tool_use", durationMs: 0, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const runtime: import("@0/engine").NativeRuntime = { ...childRuntime, forkForSubagent: async () => childRuntime,
    executeNative: async () => { parentCalls++; if (parentCalls > 1) throw new Error("Unexpected extra planner request"); return { content: [{ type: "tool_use", id: "blocking-batch", name: "spawn_agents", input: { read_only: true, tasks: [{ task: "Running child" }, { task: "Queued second" }, { task: "Queued third" }] } }], stopReason: "tool_use", durationMs: 0, usage: { inputTokens: 1, outputTokens: 1 } }; } };
  let activeSend: Promise<ConsoleTurnOutcome> | undefined;
  const instance = gateway(input => {
    if (input.target !== "https://batch.fixture") return engine(input);
    const real = createConsoleSession({ runtime, scanId: input.scanId, target: input.target, initialMessages: input.initialMessages, refineObjective: false, allowModelSelfExtension: false, autonomyMode: "yolo" });
    return { ...real,
      send: (...args) => activeSend = real.send(...args),
      // This fixture's supervisor confirms drain only after the actual worker
      // tree and send promise finish; the real OS-process guarantee is covered
      // by host-console-session/controller tests, not asserted by this fixture.
      forceStop: async () => { release.resolve(); await activeSend; await real.stopPersistentAgents(); stopped = true; return { processExited: true, resourcesStopped: true, quarantined: false }; },
    };
  });
  const batch = instance.create({ target: "https://batch.fixture" });
  const other = instance.create({ target: "https://other.fixture" });
  try {
    await instance.send(batch.id, "Run the batch");
    await vi.waitFor(() => expect(childStarts, JSON.stringify(instance.get(batch.id).events)).toBe(1));
    const signal = await started.promise;
    expect(parentCalls).toBe(1); expect(childStarts).toBe(1);
    expect((await instance.cancel(batch.id)).status).toBe("cancelling");
    expect(signal.aborted).toBe(true);
    await instance.send(batch.id, { text: "Retain queued operator input", mode: "queue" });
    expect(instance.get(batch.id).lastOutcome).toBeNull();
    expect(instance.get(batch.id).session.status).toBe("cancelling");
    await instance.send(other.id, "Unrelated chat still works"); await idle(instance, other.id);
    expect(instance.get(other.id).lastOutcome?.stopReason).toBe("end_turn");
    const result = await instance.forceStop(batch.id);
    expect(stopped).toBe(true); expect(result.status).toBe("ready");
    expect(childStarts).toBe(1); expect(parentCalls).toBe(1);
    const snapshot = instance.get(batch.id);
    expect(snapshot.lastOutcome?.stopReason).toBe("cancelled");
    expect(snapshot.queuedMessages.map(message => message.text)).toEqual(["Retain queued operator input"]);
    expect(snapshot.messages.some(message => JSON.stringify(message).includes("blocking-batch"))).toBe(true);
  } finally { release.resolve(); await activeSend; vi.unstubAllEnvs(); }
}, 15000);


describe("confirmed mode changes and pending tool actions", () => {
  it("resumes a real native file edit once after Standard switches to YOLO", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "0-mode-action-"))); homes.push(root);
    const file = join(root, "fixture.txt"); writeFileSync(file, "before");
    let calls = 0;
    const runtime: import("@0/engine").NativeRuntime = { type: "api", isAvailable: async () => true,
      executeNative: async () => ++calls === 1
        ? { content: [{ type: "tool_use", id: "one-edit", name: "str_replace", input: { path: file, old_string: "before", new_string: "after" } }], stopReason: "tool_use", durationMs: 0, usage: { inputTokens: 1, outputTokens: 1 } }
        : { content: [{ type: "text", text: "Done" }], stopReason: "end_turn", durationMs: 0, usage: { inputTokens: 1, outputTokens: 1 } },
    };
    let real!: ConsoleSession;
    const instance = gateway(async input => {
      real = createConsoleSession({ ...input, runtime, role: "attack", workspaceRoot: root, refineObjective: false, allowModelSelfExtension: false });
      await real.ready; real.configureWorkspace(root); return real;
    });
    const chat = instance.create({ autonomyMode: "standard", role: "attack" });
    await instance.send(chat.id, "Perform the one synthetic edit.");
    await vi.waitFor(() => expect(instance.get(chat.id).pendingDecisions[0]?.call?.name).toBe("str_replace"));
    expect(readFileSync(file, "utf8")).toBe("before");
    const priorScope = real.scope, priorPath = real.localScopePath;
    await instance.configure(chat.id, { autonomyMode: "standard" });
    expect(instance.get(chat.id).pendingDecisions).toHaveLength(1);
    await instance.configure(chat.id, { autonomyMode: "yolo" }); await idle(instance, chat.id);
    expect(readFileSync(file, "utf8")).toBe("after"); expect(calls).toBe(2);
    expect(instance.get(chat.id).pendingDecisions).toEqual([]);
    expect(instance.get(chat.id).events.filter(event => event.type === "tool-result" && event.call.name === "str_replace")).toHaveLength(1);
    expect(real.scope).toBe(priorScope); expect(real.localScopePath).toBe(priorPath);
  });

  it.each(["local", "smolvm"] as const)("waits for the %s mode acknowledgement before releasing its action", async backend => {
    isolated.profile = backend;
    const ack = Promise.withResolvers<void>();
    let allowed: boolean | undefined;
    const instance = gateway(input => {
      const session = engine(input), apply = session.setAutonomyMode.bind(session);
      session.setAutonomyMode = async mode => { await ack.promise; await apply(mode); };
      session.send = async () => { allowed = await input.approveTool!({ name: "bash", arguments: { command: "echo fixture" } }); return outcome(); };
      return session;
    });
    const chat = instance.create({ autonomyMode: "standard" }); await instance.send(chat.id, "Fixture");
    await vi.waitFor(() => expect(instance.get(chat.id).pendingDecisions).toHaveLength(1));
    const change = instance.configure(chat.id, { autonomyMode: "yolo" });
    expect(allowed).toBeUndefined(); expect(instance.get(chat.id).session.autonomyMode).toBe("standard");
    expect(instance.get(chat.id).pendingDecisions).toHaveLength(1);
    ack.resolve(); await change; await idle(instance, chat.id);
    expect(allowed).toBe(true); expect(instance.get(chat.id).pendingDecisions).toEqual([]);
  });

  it.each(["failed acknowledgement", "cancelled turn", "closed session"])("never releases an action after %s", async failure => {
    const ack = Promise.withResolvers<void>();
    let allowed: boolean | undefined;
    const instance = gateway(input => {
      const session = engine(input), apply = session.setAutonomyMode.bind(session);
      session.setAutonomyMode = async mode => { await ack.promise; await apply(mode); };
      session.send = async () => { allowed = await input.approveTool!({ name: "bash", arguments: { command: "echo fixture" } }); return outcome(); };
      return session;
    });
    const chat = instance.create({ autonomyMode: "standard" }); await instance.send(chat.id, "Fixture");
    await vi.waitFor(() => expect(instance.get(chat.id).pendingDecisions).toHaveLength(1));
    const decision = instance.get(chat.id).pendingDecisions[0]!;
    const change = instance.configure(chat.id, { autonomyMode: "yolo" });
    if (failure === "failed acknowledgement") {
      const rejected = expect(change).rejects.toThrow("Mode not applied"); ack.reject(new Error("Mode not applied")); await rejected;
      expect(allowed).toBeUndefined(); expect(instance.get(chat.id).session.autonomyMode).toBe("standard");
      expect(instance.get(chat.id).pendingDecisions[0]?.id).toBe(decision.id);
      instance.resolveDecision(chat.id, decision.id, { approve: false });
    } else {
      if (failure === "cancelled turn") await instance.cancel(chat.id); else await instance.close(chat.id);
      const checked = failure === "closed session" ? expect(change).rejects.toThrow("session changed") : change;
      ack.resolve(); await checked;
    }
    await vi.waitFor(() => expect(allowed).toBe(false));
    expect(instance.get(chat.id).events.some(event => event.type === "decision-resolved" && event.decisionId === decision.id && event.approved)).toBe(false);
  });

  it("does not let an invalid mixed request supersede a valid mode acknowledgement", async () => {
    const ack = Promise.withResolvers<void>(); let allowed: boolean | undefined;
    const instance = gateway(input => {
      const session = engine(input), apply = session.setAutonomyMode.bind(session);
      session.setAutonomyMode = async mode => { await ack.promise; await apply(mode); };
      session.send = async () => { allowed = await input.approveTool!({ name: "bash", arguments: {} }); return outcome(); };
      return session;
    });
    const chat = instance.create({ autonomyMode: "standard" }); await instance.send(chat.id, "Fixture");
    await vi.waitFor(() => expect(instance.get(chat.id).pendingDecisions).toHaveLength(1));
    const valid = instance.configure(chat.id, { autonomyMode: "yolo" });
    await expect(instance.configure(chat.id, { autonomyMode: "standard", workspacePath: "/nonexistent-mode-regression-project" })).rejects.toThrow("current turn");
    ack.resolve(); await valid; await idle(instance, chat.id);
    expect(instance.get(chat.id).session.autonomyMode).toBe("yolo"); expect(allowed).toBe(true);
    expect(instance.get(chat.id).pendingDecisions).toEqual([]);
  });

  it("does not approve an action from a superseded YOLO acknowledgement", async () => {
    const yolo = Promise.withResolvers<void>(), standard = Promise.withResolvers<void>();
    let allowed: boolean | undefined;
    const instance = gateway(input => {
      const session = engine(input), apply = session.setAutonomyMode.bind(session);
      session.setAutonomyMode = async mode => { await (mode === "yolo" ? yolo.promise : standard.promise); await apply(mode); };
      session.send = async () => { allowed = await input.approveTool!({ name: "bash", arguments: {} }); return outcome(); };
      return session;
    });
    const chat = instance.create({ autonomyMode: "standard" }); await instance.send(chat.id, "Fixture");
    await vi.waitFor(() => expect(instance.get(chat.id).pendingDecisions).toHaveLength(1));
    const first = instance.configure(chat.id, { autonomyMode: "yolo" });
    const latest = instance.configure(chat.id, { autonomyMode: "standard" });
    yolo.resolve(); await first;
    expect(allowed).toBeUndefined(); expect(instance.get(chat.id).pendingDecisions).toHaveLength(1);
    standard.resolve(); await latest;
    expect(allowed).toBeUndefined(); expect(instance.get(chat.id).session.autonomyMode).toBe("standard");
    await instance.cancel(chat.id); await idle(instance, chat.id); expect(allowed).toBe(false);
  });

  it("keeps questions, directory/scope expansion, audit escalation and package workflow intent explicit", async () => {
    let permissions!: Promise<unknown[]>;
    const instance = gateway(input => {
      const session = engine(input);
      session.send = async () => {
        permissions = Promise.all([
          input.approveTool!({ name: "bash", arguments: { command: "echo fixture" } }),
          input.askOperator!({ requestId: "question", questions: [{ header: "Context", question: "Which context?" }] }),
          input.requestLocalScope!({ requestedPath: "/fixture/other", call: { name: "read_file", arguments: {} } }),
          input.requestScope!({ requestedUrls: ["https://other.fixture"], call: { name: "http_request", arguments: {} }, target: "https://fixture" }),
          input.escalateScopedAudit!({ call: { name: "bash", arguments: {} }, reason: "Leave source-only audit" }),
        ]);
        await permissions; return outcome();
      };
      return session;
    });
    const chat = instance.create({ autonomyMode: "standard" }); await instance.send(chat.id, "Fixture");
    await vi.waitFor(() => expect(instance.get(chat.id).pendingDecisions).toHaveLength(5));
    await instance.configure(chat.id, { autonomyMode: "yolo" });
    expect(instance.get(chat.id).pendingDecisions.map(item => item.kind).sort()).toEqual(["audit-escalation", "local-scope", "operator-question", "scope"]);
    for (const decision of instance.get(chat.id).pendingDecisions) instance.resolveDecision(chat.id, decision.id, { approve: false });
    await permissions; await idle(instance, chat.id);
    vi.spyOn(instance, "getExecutionContext").mockResolvedValue({ target: "https://fixture", role: "attack", autonomyMode: "yolo", scopeEnforcement: { pluginId: "scope", enabled: true, projectPath: "/fixture", message: "Enabled" }, authorization: { deniedHosts: [], deniedLocalPaths: [], scopedAuditGrants: [], scopedAuditDenials: [] } } as unknown as ConsoleExecutionContext);
    const request = instance.authorizeWorkflowTarget(chat.id, { target: "npm:fixture", kind: "package" });
    const declined = expect(request).rejects.toThrow("authorization was declined");
    await vi.waitFor(() => expect(instance.get(chat.id).pendingDecisions).toHaveLength(1));
    const intent = instance.get(chat.id).pendingDecisions[0]!; expect(intent.kind).toBe("tool");
    await instance.configure(chat.id, { autonomyMode: "yolo" });
    expect(instance.get(chat.id).pendingDecisions[0]?.id).toBe(intent.id);
    instance.resolveDecision(chat.id, intent.id, { approve: false }); await declined;
  });

  it("does not auto-release an old action ahead of staged target restrictions", async () => {
    const instance = gateway(input => { const session = engine(input); session.send = async () => { await input.approveTool!({ name: "bash", arguments: {} }); return outcome(); }; return session; });
    const chat = instance.create({ autonomyMode: "standard" }); await instance.send(chat.id, "Fixture");
    await vi.waitFor(() => expect(instance.get(chat.id).pendingDecisions).toHaveLength(1));
    await instance.configure(chat.id, { autonomyMode: "yolo", target: "https://restricted.fixture" });
    expect(instance.get(chat.id).session.autonomyMode).toBe("standard");
    expect(instance.get(chat.id).pendingDecisions).toHaveLength(1);
    await instance.configure(chat.id, { autonomyMode: "yolo" });
    expect(instance.get(chat.id).pendingDecisions).toHaveLength(1);
    await instance.cancel(chat.id);
  });

  it("applies a VM mode change before a late Standard approval arrives without deadlocking", async () => {
    isolated.profile = "smolvm";
    const later = Promise.withResolvers<void>(); let allowed: boolean | undefined;
    const instance = gateway(input => { const session = engine(input); session.send = async () => { await later.promise; allowed = await input.approveTool!({ name: "bash", arguments: {} }); return outcome(); }; return session; });
    const chat = instance.create({ autonomyMode: "standard" }); await instance.send(chat.id, "Fixture");
    await instance.configure(chat.id, { autonomyMode: "yolo" });
    expect(instance.get(chat.id).session.autonomyMode).toBe("yolo");
    expect(instance.get(chat.id).pendingConfiguration).toBeUndefined();
    later.resolve(); await idle(instance, chat.id);
    expect(allowed).toBe(true); expect(instance.get(chat.id).pendingDecisions).toEqual([]);
  });
  it("emits an additive visual event for visualize, keeps the spec out of tool-result, and persists the spec via the saved tool_use", async () => {
    const spec = { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] };
    const input = { kind: "graph", title: "Path", summary: "A reaches B.", spec };
    const visual = { id: "viz-1", version: 1 as const, createdAt: "2026-09-30T00:00:00.000Z", ...input };
    const instance = gateway(inputArgs => {
      const base = engine(inputArgs);
      return { ...base, async send(text, callbacks) {
        base.messages.push({ role: "user", content: [{ type: "text", text }] });
        const call: ToolCall = { name: "visualize", arguments: input };
        callbacks?.onToolStart?.(call);
        callbacks?.onToolResult?.(call, { success: true, output: { visual_id: "viz-1" }, meta: { kind: "visual", visual } as never });
        const failed: ToolCall = { name: "visualize", arguments: { kind: "graph" } };
        callbacks?.onToolResult?.(failed, { success: false, output: null, error: "bad" });
        base.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "visualize", input }] });
        base.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: '{"visual_id":"viz-1"}' }] });
        return outcome("done");
      } };
    });
    const chat = instance.create();
    await instance.send(chat.id, { text: "draw it" }); await idle(instance, chat.id);
    const events = instance.get(chat.id).events;
    const visuals = events.filter(event => event.type === "visual");
    expect(visuals).toHaveLength(1);
    expect(visuals[0]).toMatchObject({ type: "visual", visual: { id: "viz-1", version: 1, kind: "graph", spec: { nodes: [{ id: "a" }, { id: "b" }] } }, call: { name: "visualize" } });
    // Strictly ordered after its tool-result; the failed call yields no visual.
    const results = events.filter(event => event.type === "tool-result");
    expect(results).toHaveLength(2);
    expect(JSON.stringify((results[0] as { result: unknown }).result)).not.toContain('"nodes"');
    expect(events.findIndex(event => event.type === "visual")).toBe(events.indexOf(results[0]!) + 1);
    // Events are replayed through the cursor API unchanged.
    expect(instance.eventsAfter(chat.id, 0).events.some(event => event.type === "visual")).toBe(true);
    // Saved sessions persist messages: the spec survives as the visualize tool_use input.
    const resumed = await instance.resume(instance.save(chat.id).id);
    const blocks = instance.get(resumed.id).messages.flatMap(message => message.content);
    expect(blocks).toContainEqual({ type: "tool_use", id: "tu1", name: "visualize", input });
  });
});

describe("ConsoleGateway windowed snapshots, long-poll and resume reuse", () => {
  async function bigChat() {
    const instance = gateway();
    const chat = instance.create({});
    for (let i = 0; i < 5; i++) { await instance.send(chat.id, `question ${i}`); await idle(instance, chat.id); }
    for (let w = 0; w < 4; w++) {
      const agent_id = `${chat.id}-w${w}`;
      eventBus.emit("subagent_lifecycle", { agent_id, parent_scan_id: chat.id, status: "running", task: `Task ${w}`, name: `Worker ${w}`, model: "m" });
      for (let turn = 1; turn <= 30; turn++) eventBus.emit("subagent_message", { agent_id, parent_scan_id: chat.id, turn, ts: turn, assistant: "x".repeat(4_000) });
    }
    return { instance, chat };
  }

  it("keeps the default snapshot and bounds the opt-in window with worker summaries", async () => {
    const { instance, chat } = await bigChat();
    const full = instance.get(chat.id);
    expect(full.messages).toHaveLength(10);
    expect(full.workers).toHaveLength(4);
    expect(full.workers[0]!.transcript).toHaveLength(30);

    const windowed = instance.getWindowed(chat.id, { window: 4, workers: "summary" });
    expect(windowed.messages).toEqual(full.messages.slice(-4));
    expect(windowed.events.length).toBeLessThanOrEqual(4);
    expect(windowed.window).toMatchObject({ messages: 4, messagesTotal: 10, firstMessageIndex: 6, workers: "summary" });
    expect(windowed.toolsOmitted).toBe(true);
    expect(windowed.tools).toEqual([]);
    const summary = windowed.workers[0] as unknown as Record<string, unknown>;
    expect(summary).toMatchObject({ name: "Worker 0", status: "running", model: "m", turnCount: 30, toolCallCount: 0 });
    expect(summary).not.toHaveProperty("transcript");
    expect(JSON.stringify(windowed).length).toBeLessThan(JSON.stringify(full).length / 10);

    // The summary-only workers option keeps every message.
    expect(instance.getWindowed(chat.id, { workers: "summary" }).messages).toHaveLength(10);
    // The full worker is still available on demand.
    expect(instance.worker(chat.id, `${chat.id}-w2`).transcript).toHaveLength(30);
  });

  it("pages older messages by index", async () => {
    const { instance, chat } = await bigChat();
    const all = instance.get(chat.id).messages;
    const first = instance.messagesPage(chat.id, { limit: 3 });
    expect(first).toMatchObject({ total: 10, firstIndex: 7, hasMore: true });
    expect(first.messages).toEqual(all.slice(7));
    const older = instance.messagesPage(chat.id, { before: first.firstIndex, limit: 100 });
    expect(older).toMatchObject({ firstIndex: 0, hasMore: false });
    expect(older.messages).toEqual(all.slice(0, 7));
  });

  it("returns a small resync marker for a stale cursor when asked", async () => {
    const { instance, chat } = await bigChat();
    const cursor = instance.get(chat.id).cursor;
    expect(instance.eventsAfter(chat.id, cursor + 50)).toHaveProperty("snapshot");
    const resync = instance.eventsAfter(chat.id, cursor + 50, { resync: true });
    expect(resync).toEqual({ events: [], cursor, gap: true, resync: true });
    expect(JSON.stringify(resync).length).toBeLessThan(200);
  });

  it("long-polls: waits for new events, times out, and stops on abort", async () => {
    const instance = gateway();
    const chat = instance.create({}); await instance.send(chat.id, "hi"); await idle(instance, chat.id);
    const cursor = instance.get(chat.id).cursor;
    vi.useFakeTimers();
    try {
      let woke = false;
      const waiting = instance.waitForEvents(chat.id, cursor, 20_000).then(() => { woke = true; });
      await vi.advanceTimersByTimeAsync(19_000);
      expect(woke).toBe(false);
      await vi.advanceTimersByTimeAsync(1_001);
      await waiting; expect(woke).toBe(true);

      woke = false;
      const early = instance.waitForEvents(chat.id, cursor, 25_000).then(() => { woke = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(woke).toBe(false);
      eventBus.emit("subagent_lifecycle", { agent_id: `${chat.id}-late`, parent_scan_id: chat.id, status: "running", task: "t" });
      await early; expect(woke).toBe(true);
      expect(instance.eventsAfter(chat.id, cursor).events.length).toBeGreaterThan(0);

      const abort = new AbortController(); woke = false;
      const aborted = instance.waitForEvents(chat.id, instance.get(chat.id).cursor, 25_000, abort.signal).then(() => { woke = true; });
      abort.abort(); await aborted; expect(woke).toBe(true);
      // A stale cursor never waits.
      await instance.waitForEvents(chat.id, 9_999, 25_000); 
    } finally { vi.useRealTimers(); }
  });

  it("reuses the live session for a saved id and reaps unused resumed sessions without rewriting them", async () => {
    const createSession = vi.fn(engine);
    const instance = gateway(createSession);
    const chat = instance.create({});
    await instance.send(chat.id, "hello"); await idle(instance, chat.id);
    const saved = instance.save(chat.id);
    await instance.close(chat.id);
    const home = homes.at(-1)!;

    const first = await instance.resume(saved.id);
    const second = await instance.resume(saved.id);
    expect(second.id).toBe(first.id);
    expect(instance.list().filter(item => item.savedId === (saved.id) && item.status !== "closed")).toHaveLength(1);
    expect(createSession.mock.calls.length).toBe(2); // original + one resume

    const before = readFileSync(join(home, ".0", "console-sessions", `${saved.id}.json`), "utf8");
    expect(await instance.reapIdleResumed(60_000)).toEqual([]); // not idle long enough
    expect(await instance.reapIdleResumed(0)).toEqual([first.id]);
    expect(instance.get(first.id).session.status).toBe("closed");
    expect(readFileSync(join(home, ".0", "console-sessions", `${saved.id}.json`), "utf8")).toBe(before);

    // A resumed chat that was written to is never reaped.
    const again = await instance.resume(saved.id);
    await instance.send(again.id, "more"); await idle(instance, again.id);
    expect(await instance.reapIdleResumed(0)).toEqual([]);
  });

  it("serves a read-only windowed saved transcript without starting a session", async () => {
    const createSession = vi.fn(engine);
    const instance = gateway(createSession);
    const chat = instance.create({});
    for (let i = 0; i < 3; i++) { await instance.send(chat.id, `q${i}`); await idle(instance, chat.id); }
    const saved = instance.save(chat.id); const id = saved.id;
    await instance.close(chat.id);
    const calls = createSession.mock.calls.length;
    const page = instance.savedTranscript(id, { window: 2 });
    expect(page).toMatchObject({ total: 6, firstIndex: 4, hasMore: true });
    expect(page.messages).toHaveLength(2);
    expect(instance.savedTranscript(id, { before: 4, limit: 10 }).messages).toHaveLength(4);
    expect(instance.savedTranscript(id).messages).toHaveLength(6);
    expect(createSession.mock.calls.length).toBe(calls);
  });
});

describe("ConsoleGateway automatic titles", () => {
  type Call = { system: string; messages: NativeMessage[] };
  function titled(execute: (call: Call) => Promise<unknown> | unknown) {
    isolated.profile = "local";
    const calls: Call[] = [];
    const runtime = {
      resolvedModel: () => "gpt-4o", resolvedProvider: () => "openai", modelSelection: () => ({ agentModels: {}, singleModel: true, autoRoute: false }),
      executeNative: vi.fn(async (system: string, messages: NativeMessage[]) => { const call = { system, messages }; calls.push(call); return execute(call); }),
    };
    const info = { providerId: "openai", providerLabel: "OpenAI", model: "gpt-4o", configured: true, connectionIdentity: "fixture-account", diagnostics: { valid: true, reason: null, message: null }, agentModels: {}, singleModel: true, autoRoute: false, contextWindowTokens: 100_000 };
    isolated.runtimeFactory.mockResolvedValue({ runtime, info });
    isolated.pluginManager.mockResolvedValue({ refresh: async () => undefined, acquire: () => ({ host: undefined, release: () => undefined }) });
    isolated.localFactory.mockImplementation((config: ConsoleGatewaySessionFactoryInput) => engine(config));
    const home = mkdtempSync(join(tmpdir(), "0-web-title-test-")); homes.push(home);
    let id = 0;
    const instance = new ConsoleGateway({ homeDir: home, projectPath: "/fixture", createId: () => `title-${homes.length}-${++id}`, now: () => new Date("2026-09-30T00:00:00Z") });
    gateways.push(instance);
    return { instance, calls, runtime, home };
  }
  const ok = (text: string) => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 6 } });
  const sessionTitles = (instance: ConsoleGateway, id: string) =>
    instance.eventsAfter(id, 0).events.flatMap(event => event.type === "session" ? [event.session.title] : []);
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  it("titles a default chat once after the first completed turn and announces it live", async () => {
    const { instance, calls, home } = titled(() => ok('"Wassup greeting check."'));
    const created = instance.create();
    expect(instance.get(created.id).session.titleSource).toBe("default");
    await instance.send(created.id, "wassup"); await idle(instance, created.id);
    await vi.waitFor(() => expect(instance.get(created.id).session.titleSource).toBe("auto"));
    expect(instance.get(created.id).title).toBe("Wassup greeting check");
    expect(sessionTitles(instance, created.id)).toEqual(expect.arrayContaining(["wassup", "Wassup greeting check"]));
    expect(loadSession(created.id, home)?.consoleState?.titleSource).toBe("auto");
    expect(loadSession(created.id, home)?.summary).toBe("Wassup greeting check");
    // The auxiliary call is billed to the session ledger (the fixture engine reports no turn usage).
    expect(instance.get(created.id).usage).toMatchObject({ inputTokens: 100, outputTokens: 6 });
    expect(calls).toHaveLength(1);
    await instance.send(created.id, "Second request"); await idle(instance, created.id);
    await settle();
    expect(calls).toHaveLength(1);
    expect(instance.get(created.id).title).toBe("Wassup greeting check");
  });

  it("falls back to the first sentence when the model call fails", async () => {
    const { instance } = titled(() => { throw new Error("provider down"); });
    const created = instance.create();
    await instance.send(created.id, "Review the login flow. Also check cookies."); await idle(instance, created.id);
    await vi.waitFor(() => expect(instance.get(created.id).session.titleSource).toBe("auto"));
    expect(instance.get(created.id).title).toBe("Review the login flow");
  });

  it("never overwrites a title the operator or creator set", async () => {
    const { instance, calls } = titled(() => ok("Model title"));
    const explicit = instance.create({ title: "Campaign iter 12: probe-auth" });
    expect(instance.get(explicit.id).session.titleSource).toBe("user");
    await instance.send(explicit.id, "go"); await idle(instance, explicit.id);
    const renamed = instance.create();
    await instance.configure(renamed.id, { title: "My plan" });
    expect(instance.get(renamed.id).session.titleSource).toBe("user");
    await instance.send(renamed.id, "go"); await idle(instance, renamed.id);
    await settle();
    expect(calls).toHaveLength(0);
    expect(instance.get(explicit.id).title).toBe("Campaign iter 12: probe-auth");
    expect(instance.get(renamed.id).title).toBe("My plan");
  });

  it("keeps an operator rename that lands while the title call is in flight", async () => {
    let release!: (value: unknown) => void;
    const { instance } = titled(() => new Promise(resolve => { release = resolve; }));
    const created = instance.create();
    await instance.send(created.id, "Audit billing"); await idle(instance, created.id);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await instance.configure(created.id, { title: "Mine" });
    release(ok("Model title"));
    await settle();
    expect(instance.get(created.id).title).toBe("Mine");
    expect(instance.get(created.id).session.titleSource).toBe("user");
  });

  it("treats legacy saved titles as the operator's and leaves them untouched", async () => {
    const { instance, calls, home } = titled(() => ok("Model title"));
    expect(saveSession({ id: "legacy", savedAt: 1, cwd: "/fixture", preview: "", summary: "wassup", messageCount: 2, messages: [{ role: "user", content: [{ type: "text", text: "wassup" }] }, { role: "assistant", content: [{ type: "text", text: "hey" }] }],
      consoleState: { version: 1, title: "wassup", objective: "", usage: { inputTokens: 0, outputTokens: 0 }, lastOutcome: null, todos: null, workers: [], compaction: null, queuedMessages: [] } }, home)).toBe(true);
    const resumed = await instance.resume("legacy");
    expect(instance.get(resumed.id).session.titleSource).toBe("user");
    await instance.send(resumed.id, "continue"); await idle(instance, resumed.id);
    await settle();
    expect(calls).toHaveLength(0);
    expect(instance.get(resumed.id).title).toBe("wassup");
  });

  it("regenerates on request, replacing even an operator title, and rejects blank chats", async () => {
    const { instance } = titled(() => ok("Fresh generated title"));
    const created = instance.create({ title: "Old name" });
    await expect(instance.regenerateTitle(created.id)).rejects.toMatchObject({ statusCode: 409 });
    await instance.send(created.id, "Review tenant isolation"); await idle(instance, created.id);
    const result = await instance.regenerateTitle(created.id);
    expect(result).toMatchObject({ title: "Fresh generated title", source: "model" });
    expect(result.session.titleSource).toBe("auto");
    expect(instance.get(created.id).title).toBe("Fresh generated title");
    expect(sessionTitles(instance, created.id).at(-1)).toBe("Fresh generated title");
  });

  it("keeps a good title when regeneration only produces the raw-prompt fallback", async () => {
    let fail = false;
    const { instance } = titled(() => { if (fail) throw new Error("provider down"); return ok("Billing audit plan"); });
    const created = instance.create();
    await instance.send(created.id, "Audit billing flows for tenant isolation"); await idle(instance, created.id);
    await vi.waitFor(() => expect(instance.get(created.id).session.titleSource).toBe("auto"));
    fail = true;
    const result = await instance.regenerateTitle(created.id);
    expect(result.source).toBe("fallback");
    expect(result.title).toBe("Billing audit plan");
    expect(instance.get(created.id).title).toBe("Billing audit plan");
  });

  it("does not re-stamp a resumed session's last activity on save or close", async () => {
    const { instance, home } = titled(() => ok("Model title"));
    const savedAt = Date.now() - 3 * 86_400_000;
    expect(saveSession({ id: "old-one", savedAt, cwd: "/fixture", preview: "", summary: "Old", messageCount: 2, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }, { role: "assistant", content: [{ type: "text", text: "hey" }] }],
      consoleState: { version: 1, title: "Old", objective: "", usage: { inputTokens: 0, outputTokens: 0 }, lastOutcome: null, todos: null, workers: [], compaction: null, queuedMessages: [] } }, home)).toBe(true);
    const resumed = await instance.resume("old-one");
    expect(Date.parse(instance.get(resumed.id).session.updatedAt)).toBe(savedAt);
    await instance.close(resumed.id);
    expect(loadSession("old-one", home)?.savedAt).toBe(savedAt);
  });

  it("serves POST /api/console/sessions/:id/title/regenerate", async () => {
    const { instance } = titled(() => ok("Route generated title"));
    const created = instance.create();
    await instance.send(created.id, "Probe the API gateway"); await idle(instance, created.id);
    await vi.waitFor(() => expect(instance.get(created.id).session.titleSource).toBe("auto"));
    const { handleWebConsoleApiRequest } = await import("./dashboard-api.js");
    const { Readable } = await import("node:stream");
    const call = async (path: string, method = "POST") => {
      const req = Object.assign(Readable.from([]), { method, headers: {}, url: path });
      let status = 0; let body = "";
      const res = { writeHead: (code: number) => { status = code; }, end: (chunk: string) => { body = chunk; } };
      const none = { handle: async () => null };
      const handled = await handleWebConsoleApiRequest(req as never, res as never, new URL(`http://local${path}`), instance, none as never, none as never, none as never, {} as never, none as never);
      return { handled, status, body: JSON.parse(body) as { title?: string; source?: string; session?: { titleSource?: string }; error?: string } };
    };
    const response = await call(`/api/console/sessions/${created.id}/title/regenerate`);
    expect(response).toMatchObject({ handled: true, status: 200, body: { title: "Route generated title", source: "model", session: { titleSource: "auto" } } });
    expect((await call(`/api/console/sessions/${created.id}/title/regenerate`, "GET")).status).toBe(405);
    expect((await call("/api/console/sessions/missing/title/regenerate")).status).toBe(404);
  });
});
