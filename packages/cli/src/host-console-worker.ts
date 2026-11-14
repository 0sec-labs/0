import { createReadStream, createWriteStream, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ScopePolicy, withScopeEnforcement, eventBus, connectServicePlugins, TOOL_DEFINITIONS, observeExecutionResources,
  type ConsoleSession, type ConsoleSessionConfig, type McpHost } from "@0/core";
import { VERSION } from "@0/shared";
import { createHostLocalConsoleSession } from "./console-session.js";
import { LearningStore } from "@0/db";
import { connectConsoleMcp } from "./console-mcp.js";
import { loadServicePluginConnections } from "./web/service-plugins.js";
import { createSessionPluginHostManager } from "./tui/session-plugin-host.js";
import { encodeHostConsoleFrames, HostConsoleFrameReader, HOST_CONSOLE_CALLBACKS, type HostConsoleFrame, type HostConsoleBootstrap } from "./host-console-protocol.js";
import { captureWebConsoleRuntimeBootstrap, createWebConsoleRuntimeFromBootstrap } from "./web/operator-services.js";

const RENDER_EVENTS = ["onAssistantDelta", "onReasoningDelta", "onToolStart", "onToolResult", "onUsage", "onNotice", "onCompaction"] as const;
const WORKER_EVENTS = new Set(["subagent_lifecycle", "subagent_progress", "subagent_message"]);

/** Private stdio entry, called only by the host controller's dedicated process. */
export async function runHostConsoleWorker(): Promise<void> {
  const input = createReadStream("", { fd: 3, autoClose: false });
  const output = createWriteStream("", { fd: 4, autoClose: false });
  const backpressure = new Int32Array(new SharedArrayBuffer(4));
  const emit = (frame: HostConsoleFrame) => {
    for (const chunk of encodeHostConsoleFrames(frame)) {
      const bytes = Buffer.from(chunk);
      let offset = 0; const deadline = Date.now() + 5000;
      while (offset < bytes.length) {
        try { offset += writeSync(4, bytes, offset, Math.min(65536, bytes.length - offset)); }
        catch (error) {
          if (!["EAGAIN", "EINTR"].includes((error as NodeJS.ErrnoException).code ?? "") || Date.now() >= deadline) throw error;
          Atomics.wait(backpressure, 0, 0, 5);
        }
      }
    }
  };
  observeExecutionResources(event => {
    if (event.type === "creating") emit({ type: "resource-begin", id: event.id });
    else if (event.type === "registered") emit({ type: "resource", id: event.id, pid: event.pid, group: event.group });
    else emit({ type: "resource-failed", id: event.id });
  });
  let initialized = false;
  let closing = false;
  let session: ConsoleSession | undefined;
  let turn: AbortController | undefined;
  let bootstrap: HostConsoleBootstrap;
  let mcpHost: McpHost | undefined;
  let plugins: Awaited<ReturnType<typeof createSessionPluginHostManager>> | undefined;
  let learningStore: LearningStore | undefined;
  let active = false;
  let runtime: ReturnType<typeof createWebConsoleRuntimeFromBootstrap>["runtime"];
  let releasePlugins: (() => void) | undefined;
  let lastMessageCount = -1;
  let lastBinding = "";
  const binding = () => {
    if (!runtime || closing) return;
    const value = captureWebConsoleRuntimeBootstrap(runtime);
    const key = JSON.stringify(value);
    if (key !== lastBinding) { emit({ type: "runtime-binding", value }); lastBinding = key; }
  };
  const callbacks = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const invoke = (name: string, args: unknown[]): Promise<unknown> => {
    if (!bootstrap.callbacks.includes(name) || closing || callbacks.size >= 64) return Promise.reject(new Error("Host callback is unavailable"));
    const id = randomUUID();
    const promise = new Promise((resolve, reject) => callbacks.set(id, { resolve, reject }));
    emit({ type: "callback", id, name, args });
    return promise;
  };
  const snapshot = () => {
    if (!session || closing) return;
    lastMessageCount = session.messages.length;
    binding();
    let checkpoint;
    try { checkpoint = session.exportCheckpoint(); } catch { /* Live turns/workers are not portable authority. */ }
    emit({ type: "snapshot", value: {
      scanId: session.scanId, systemPrompt: session.systemPrompt, tools: session.tools,
      messages: session.messages, autonomyMode: session.autonomyMode, webSearchEnabled: session.webSearchEnabled,
      target: session.target, scope: session.scope?.raw, localScopePath: session.localScopePath,
      scopeEnforcement: session.scopeEnforcement, sourceContext: session.sourceContext,
      ...(checkpoint ? { checkpoint } : {}), active,
    } });
  };
  const unsubscribe = eventBus.subscribe({ emit(type, payload) {
    if (!closing && WORKER_EVENTS.has(type)) { emit({ type: "bus", name: type, value: payload }); snapshot(); }
  } });
  const finish = async () => {
    if (closing) return;
    snapshot(); closing = true; turn?.abort(new Error("Host session worker closing"));
    for (const pending of callbacks.values()) pending.reject(new Error("Host session worker closing"));
    callbacks.clear();
    const failures: unknown[] = [];
    for (const close of [() => session?.cleanup(), () => mcpHost?.closeAll(), () => releasePlugins?.(), () => plugins?.dispose(), () => learningStore?.close()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    unsubscribe(); clearInterval(tick);
    // Keep resource observation installed until OS exit, including late cleanup
    // continuations. Turning it off here would reopen an untracked spawn race.
    if (failures.length) throw new AggregateError(failures, "Host session cleanup incomplete");
  };
  const receive = async (frame: HostConsoleFrame) => {
    if (frame.type === "abort") { turn?.abort(new Error(typeof frame.reason === "string" ? frame.reason : "Operator cancelled this turn")); return; }
    if (frame.type === "callback-result") {
      const pending = frame.id ? callbacks.get(frame.id) : undefined;
      if (frame.id) callbacks.delete(frame.id);
      if (frame.error) pending?.reject(new Error("Host callback failed")); else pending?.resolve(frame.value);
      return;
    }
    try {
      if (frame.type === "init") {
        if (initialized) throw new Error("Host session already initialized");
        initialized = true;
        bootstrap = frame.value as HostConsoleBootstrap;
        if (!bootstrap || typeof bootstrap.sessionId !== "string" || bootstrap.runtime?.version !== 1 || !Array.isArray(bootstrap.callbacks)
          || bootstrap.callbacks.some(name => !HOST_CONSOLE_CALLBACKS.includes(name as typeof HOST_CONSOLE_CALLBACKS[number]))) throw new Error("Invalid host session bootstrap");
        if (bootstrap.executionProfile !== "local") throw new Error("Host process requires the operator-selected local execution profile");
        Object.assign(process.env, bootstrap.executionEnvironment);
        runtime = createWebConsoleRuntimeFromBootstrap(bootstrap.runtime).runtime;
        const config = { ...bootstrap.config, scanId: bootstrap.sessionId, runtime } as unknown as Omit<ConsoleSessionConfig, "db">;
        if (bootstrap.learningDbPath) config.learningStore = learningStore = new LearningStore(bootstrap.learningDbPath);
        if (bootstrap.config.scope) config.scope = ScopePolicy.fromJson(bootstrap.config.scope as Parameters<typeof ScopePolicy.fromJson>[0]);
        const direct = ["requestScope", "requestLocalScope", "approveTool", "escalateScopedAudit", "askOperator"];
        for (const name of direct) if (bootstrap.callbacks.includes(name)) (config as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => invoke(name, args);
        if (bootstrap.callbacks.includes("requestScope")) config.requestScope = async request => {
          const value = await invoke("requestScope", [request]) as { target: string; scope: Parameters<typeof ScopePolicy.fromJson>[0] } | null;
          return value ? { ...value, scope: ScopePolicy.fromJson(value.scope) } : null;
        };
        if (bootstrap.callbacks.includes("sourceLessonHints")) config.sourceLessonHints = (root) => invoke("sourceLessonHints", [root]) as ReturnType<NonNullable<ConsoleSessionConfig["sourceLessonHints"]>>;
        if (bootstrap.callbacks.includes("historyList")) config.conversationHistory = {
          list: (...args) => invoke("historyList", args) as ReturnType<NonNullable<ConsoleSessionConfig["conversationHistory"]>["list"]>,
          read: (...args) => invoke("historyRead", args) as ReturnType<NonNullable<ConsoleSessionConfig["conversationHistory"]>["read"]>,
        };
        if (bootstrap.callbacks.includes("skillRead")) config.skillAuthoring = {
          read: (...args: unknown[]) => invoke("skillRead", args), create: (...args: unknown[]) => invoke("skillCreate", args),
          update: (...args: unknown[]) => invoke("skillSave", args), copy: (...args: unknown[]) => invoke("skillCopy", args),
        } as ConsoleSessionConfig["skillAuthoring"];
        if (bootstrap.callbacks.includes("skillEditorRead")) config.skillEditor = { read: () => invoke("skillEditorRead", []) } as ConsoleSessionConfig["skillEditor"];
        if (bootstrap.callbacks.includes("workflowList")) config.workflowAuthoring = {
          list: () => invoke("workflowList", []), save: (...args: unknown[]) => invoke("workflowSave", args),
          ...(typeof bootstrap.config.workflowEditorId === "string" ? { editor: { id: bootstrap.config.workflowEditorId, read: () => invoke("workflowEditorRead", []) } } : {}),
        } as ConsoleSessionConfig["workflowAuthoring"];
        if (bootstrap.callbacks.includes("workflowInvoke")) config.workflowLifecycle = { invoke: (...args: unknown[]) => invoke("workflowInvoke", args) };
        plugins = await createSessionPluginHostManager({ projectPath: config.workspaceRoot, reservedToolNames: Object.values(TOOL_DEFINITIONS).map(tool => tool.name), coreVersion: VERSION });
        mcpHost = await connectServicePlugins(loadServicePluginConnections(), await connectConsoleMcp(config.workspaceRoot ?? process.cwd()));
        const lease = plugins.acquire(); releasePlugins = lease.release;
        config.pluginHost = lease.host; config.mcpHost = mcpHost;
        config.onHarnessUpdate = value => { emit({ type: "harness", value }); snapshot(); };
        session = withScopeEnforcement(bootstrap.scopeEnforcement, () => createHostLocalConsoleSession(config, bootstrap.dbPath));
        await session.ready; snapshot(); emit({ type: "ready" }); return;
      }
      if (!session || closing || frame.type !== "request" || typeof frame.op !== "string") throw new Error("Invalid host session request");
      let value: unknown;
      switch (frame.op) {
        case "send": {
          if (active || typeof frame.text !== "string") throw new Error("Host session is busy or message is invalid");
          active = true; turn = new AbortController();
          const render = Object.fromEntries(RENDER_EVENTS.map(name => [name, (...args: unknown[]) => {
            emit({ type: "event", name, args });
            if (!["onAssistantDelta", "onReasoningDelta"].includes(name)) snapshot();
          }]));
          try {
            const pending = withScopeEnforcement(bootstrap.scopeEnforcement, () => session!.send(frame.text as string, render, { signal: turn!.signal, images: frame.images as NonNullable<Parameters<ConsoleSession["send"]>[2]>["images"], generateTitle: frame.generateTitle === true }));
            snapshot(); value = await pending;
          } finally { active = false; turn = undefined; }
          break;
        }
        case "stopWorker": value = await session.stopPersistentAgent(String(frame.agentId)); break;
        case "stopWorkers": await session.stopPersistentAgents(); break;
        case "checkpoint": value = session.exportCheckpoint(); break;
        case "harness": {
          if (active || !session.harness) throw new Error("Host session has no idle harness");
          value = await session.harness.interact(frame.value as Parameters<NonNullable<ConsoleSession["harness"]>["interact"]>[0]); break;
        }
        case "handoff": value = await session.prepareHandoff(); break;
        case "autonomy": {
          if (typeof frame.value !== "string" || !["standard", "recon", "copilot", "yolo"].includes(frame.value)) throw new Error("Invalid autonomy mode");
          await session.setAutonomyMode(frame.value as Parameters<ConsoleSession["setAutonomyMode"]>[0]); break;
        }
        case "webSearch": {
          if (typeof frame.value !== "boolean") throw new Error("Invalid web search setting");
          await session.setWebSearchEnabled?.(frame.value); break;
        }
        case "workerPolicy": {
          if (active || !session.setWorkerPolicy) throw new Error("Worker policy requires an idle session with policy support");
          session.setWorkerPolicy(frame.value === null ? undefined : frame.value as Parameters<NonNullable<ConsoleSession["setWorkerPolicy"]>>[0]); break;
        }
        case "configure": {
          const selected = frame.value as { target?: string; scope?: Parameters<typeof ScopePolicy.fromJson>[0] | null };
          session.configureEngagement({ target: selected.target, ...(selected.scope === undefined ? {} : { scope: selected.scope ? ScopePolicy.fromJson(selected.scope) : null }) }); break;
        }
        case "workspace": if (typeof frame.value !== "string") throw new Error("Invalid workspace"); else { session.configureWorkspace(frame.value); break; }
        case "clear": session.clearConversation(); break;
        case "reconfigure": {
          if (active) throw new Error("Runtime replacement requires an idle main turn");
          const selected = frame.value as { config: Parameters<ConsoleSession["reconfigureRuntime"]>[0]; runtime: HostConsoleBootstrap["runtime"] };
          // Only this parent→worker control operation may replace selection.
          // Child→parent refresh handback remains strict account/model/program.
          if (selected.runtime.version !== 1) throw new Error("Unsupported private runtime bootstrap version");
          runtime.applyPrivateWorkerBinding(selected.runtime.binding, { replaceSelection: true });
          session.reconfigureRuntime(selected.config);
          break;
        }
        case "close": await finish(); emit({ type: "result", id: frame.id }); output.end(() => process.exit(0)); return;
        default: throw new Error("Unsupported host session operation");
      }
      snapshot(); emit({ type: "result", id: frame.id, value });
    } catch {
      emit({ type: "error", id: frame.id, error: "Host session operation failed" });
      if (frame.type === "init") void finish().finally(() => output.end(() => process.exit(1)));
    }
  };
  const reader = new HostConsoleFrameReader();
  const tick = setInterval(() => {
    if (active && session && session.messages.length !== lastMessageCount) snapshot();
    if (active) binding();
  }, 100);
  input.setEncoding("utf8"); input.on("data", (data: string) => { try { reader.push(data, frame => { void receive(frame); }); } catch { void finish(); } });
  input.once("end", () => { void finish().finally(() => process.exit(0)); });
  await new Promise<void>(resolve => input.once("close", resolve));
}
