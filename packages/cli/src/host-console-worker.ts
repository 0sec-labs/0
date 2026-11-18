import { createReadStream, createWriteStream, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { eventBus, TOOL_DEFINITIONS, observeExecutionResources,
  type ConsoleSession, type ConsoleSessionConfig, type McpToolHost } from "@0/engine";
import { VERSION, parseApprovals } from "@0/engine/shared";
import { createHostLocalConsoleSession } from "./console-session.js";
import { connectConsoleMcp } from "./console-mcp.js";
import { connectExtensionMcp, connectExtensionRuns } from "./console-extension-mcp.js";
import { encodeHostConsoleFrames, HostConsoleFrameReader, HOST_CONSOLE_CALLBACKS, type HostConsoleFrame, type HostConsoleBootstrap } from "./host-console-protocol.js";
import { captureWebConsoleRuntimeBootstrap, createWebConsoleRuntimeFromBootstrap } from "./web/operator-services.js";

const RENDER_EVENTS = ["onAssistantDelta", "onReasoningDelta", "onToolStart", "onToolResult", "onUsage", "onNotice", "onCompaction", "onRetry"] as const;
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
  let mcpHost: McpToolHost | undefined;
  let active = false;
  let runtime: ReturnType<typeof createWebConsoleRuntimeFromBootstrap>["runtime"];
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
      messages: session.messages, approvals: session.approvals, webSearchEnabled: session.webSearchEnabled,
      sourceContext: session.sourceContext,
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
    for (const close of [() => session?.cleanup(), () => mcpHost?.closeAll()]) {
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
        const direct = ["approveTool", "askOperator"];
        for (const name of direct) if (bootstrap.callbacks.includes(name)) (config as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => invoke(name, args);
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
        mcpHost = connectExtensionMcp(await connectConsoleMcp(config.workspaceRoot ?? process.cwd()), config.workspaceRoot ?? process.cwd());
        config.mcpHost = mcpHost; config.extensionRuns = connectExtensionRuns(config.workspaceRoot ?? process.cwd());
        session = createHostLocalConsoleSession(config, bootstrap.dbPath);
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
            if (!["onAssistantDelta", "onReasoningDelta", "onRetry"].includes(name)) snapshot();
          }]));
          try {
            const pending = session!.send(frame.text as string, render, { signal: turn!.signal, images: frame.images as NonNullable<Parameters<ConsoleSession["send"]>[2]>["images"], generateTitle: frame.generateTitle === true, ...(frame.untrusted === true ? { untrusted: true } : {}) });
            snapshot(); value = await pending;
          } finally { active = false; turn = undefined; }
          break;
        }
        case "stopWorker": value = await session.stopPersistentAgent(String(frame.agentId)); break;
        case "stopWorkers": await session.stopPersistentAgents(); break;
        case "checkpoint": value = session.exportCheckpoint(); break;
        case "handoff": value = await session.prepareHandoff(); break;
        case "autonomy": {
          // frame.value is the retired access value: accepted and ignored.
          const approvals = parseApprovals(frame.approvals);
          if (approvals) await session.setApprovals(approvals);
          break;
        }
        case "webSearch": {
          if (typeof frame.value !== "boolean") throw new Error("Invalid web search setting");
          await session.setWebSearchEnabled?.(frame.value); break;
        }
        case "workerPolicy": {
          if (active || !session.setWorkerPolicy) throw new Error("Worker policy requires an idle session with policy support");
          session.setWorkerPolicy(frame.value === null ? undefined : frame.value as Parameters<NonNullable<ConsoleSession["setWorkerPolicy"]>>[0]); break;
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
