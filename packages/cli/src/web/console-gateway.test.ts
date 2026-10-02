import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventBus, type ConsoleSession, type ConsoleTurnOutcome, type NativeMessage, type ToolCall } from "@0/core";
import { LearningStore } from "@0/db";
import { ConsoleGateway, ConsoleGatewayError, type ConsoleGatewaySessionFactoryInput, type ConsoleExecutionContext } from "./console-gateway.js";
import { loadSession, saveSession } from "../tui/session-store.js";

const isolated = vi.hoisted(() => ({
  profile: "local" as "local" | "smolvm",
  localFactory: vi.fn(),
  runtimeFactory: vi.fn(),
  applyRuntime: vi.fn(),
  pluginManager: vi.fn(),
  flushPlugins: vi.fn(),
}));
vi.mock("../console-execution.js", () => ({ consoleExecutionProfile: () => isolated.profile }));
vi.mock("../console-session.js", () => ({ createLocalConsoleSession: (...args: unknown[]) => isolated.localFactory(...args) }));
vi.mock("./operator-services.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./operator-services.js")>(),
  createWebConsoleRuntime: (...args: unknown[]) => isolated.runtimeFactory(...args),
  applyWebConsoleRuntimeSelection: (...args: unknown[]) => isolated.applyRuntime(...args),
  getWebConsolePluginHostManager: (...args: unknown[]) => isolated.pluginManager(...args),
  flushWebConsolePlugins: (...args: unknown[]) => isolated.flushPlugins(...args),
}));
beforeEach(() => {
  isolated.profile = "local";
  isolated.localFactory.mockReset(); isolated.runtimeFactory.mockReset();
  isolated.applyRuntime.mockReset(); isolated.pluginManager.mockReset();
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
  let currentTarget = input.target;
  let currentScope = input.scope;
  let currentFolder: string | undefined;
  return {
    scanId: input.scanId, ready: Promise.resolve(), systemPrompt: "Fixture", tools: [], messages,
    get autonomyMode() { return currentMode; }, get target() { return currentTarget; }, get scope() { return currentScope; },
    scopeEnforcement: { pluginId: "scope", enabled: true, projectPath: "/fixture", message: "Scope authorization enabled" }, get localScopePath() { return currentFolder; },
    configureWorkspace: path => { currentFolder = path; },
    setAutonomyMode: (mode) => { currentMode = mode; }, reconfigureRuntime: () => undefined,
    configureEngagement: (selection) => {
      if (selection.target !== undefined) currentTarget = selection.target;
      if (selection.scope !== undefined) currentScope = selection.scope ?? undefined;
    },
    clearConversation: () => { messages.splice(0); }, stopPersistentAgent: async () => true, stopPersistentAgents: async () => undefined,
    exportCheckpoint: () => { throw new Error("Fixture has no executable checkpoint"); }, prepareHandoff: async () => ({}), cleanup: async () => undefined,
    async send(text, callbacks) {
      messages.push({ role: "user", content: [{ type: "text", text }] });
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

  it("changes the workspace only after explicit folder approval and preserves it on denial", async () => {
    const instance = gateway(); const created = instance.create();
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "zero-workspace-"))); homes.push(directory);
    await instance.configure(created.id, { workspacePath: directory });
    await vi.waitFor(() => expect(instance.get(created.id).pendingDecisions).toHaveLength(1));
    expect(instance.get(created.id).localScopePath).toBeUndefined();
    const denied = instance.get(created.id).pendingDecisions[0]!;
    expect(denied).toMatchObject({ kind: "local-scope", requestedPath: directory });
    instance.resolveDecision(created.id, denied.id, { approve: false });
    await vi.waitFor(() => expect(instance.get(created.id).pendingConfiguration).toBeUndefined());
    expect(instance.get(created.id).workspacePath).toBe("/fixture");
    await instance.configure(created.id, { workspacePath: directory });
    await vi.waitFor(() => expect(instance.get(created.id).pendingDecisions).toHaveLength(1));
    instance.resolveDecision(created.id, instance.get(created.id).pendingDecisions[0]!.id, { approve: true });
    await vi.waitFor(() => expect(instance.get(created.id).workspacePath).toBe(directory));
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

  it("uses an AI title returned by the successful accounted turn", async () => {
    const instance = gateway((input) => {
      const session = engine(input);
      const original = session.send;
      session.send = async (body, callbacks, options) => {
        expect(options?.generateTitle).toBe(true);
        return { ...await original(body, callbacks, options), conversationTitle: "Tenant boundary review" };
      };
      return session;
    });
    const created = instance.create({ title: "New session" });
    await instance.send(created.id, "Find authorization issues");
    await idle(instance, created.id);
    expect(instance.get(created.id).title).toBe("Tenant boundary review");
    expect(loadSession(created.id, homes.at(-1))?.summary).toBe("Tenant boundary review");
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
    await first.continue(resumed.id, { text: "Summarize only the remaining observations." }); await idle(first, resumed.id);
    expect(first.get(resumed.id).messages.at(-1)?.content).toEqual([{ type: "text", text: "Summarize only the remaining observations." }]);
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

  it("stages autonomy changes at the turn boundary and delivers queued operator messages exactly once", async () => {
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
    expect(instance.get(created.id).session.autonomyMode).toBe("standard"); expect(instance.get(created.id).pendingConfiguration?.autonomyMode).toBe("recon");
    gate.resolve(); await vi.waitFor(() => expect(delivered).toEqual(["First instruction.", "Second instruction."])); await idle(instance, created.id);
    expect(observedModes).toEqual(["standard", "recon"]); expect(instance.get(created.id).queuedMessages).toEqual([]);
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
  function isolatedGateway() {
    isolated.profile = "smolvm";
    const home = mkdtempSync(join(tmpdir(), "0-web-isolated-test-")); homes.push(home);
    const runtime = { resolvedModel: () => "granted-model", resolvedProvider: () => "chatgpt-codex", modelSelection: () => ({ agentModels: {}, singleModel: true, autoRoute: false }) };
    const info = { providerId: "chatgpt-codex", providerLabel: "ChatGPT", model: "granted-model", configured: true,
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
 expect(instance.get(created.id).session.status).toBe("working");
 expect(instance.get(created.id).events.some(event => event.type === "notice" && event.text.startsWith("Cancellation requested."))).toBe(true);
 release(); await idle(instance, created.id);
 expect(instance.get(created.id).session.status).toBe("ready");
});
