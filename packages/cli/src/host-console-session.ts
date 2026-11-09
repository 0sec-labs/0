import { consoleJevFeatures } from "./console-jev-features.js";
import { ScopePolicy, getScopeEnforcementState, type ConsoleSession, type ConsoleSessionConfig, type ConsoleSessionCheckpoint,
  type ConsoleRenderCallbacks, type ConsoleTurnOutcome, type ConsoleUsageReport, type NativeMessage, type ScopeEnforcementState } from "@0/core";
import { HostConsoleProcess, type HostConsoleProcessOptions } from "./host-console-process.js";
import { HOST_CONSOLE_CALLBACKS, encodeHostConsoleFrame, type HostConsoleBootstrap, type HostConsoleFrame, type HostConsoleStopResult } from "./host-console-protocol.js";
import { captureWebConsoleRuntimeBootstrap, applyWebConsoleRuntimeBootstrap, type WebConsoleRuntimeBootstrap } from "./web/operator-services.js";

type Config = Omit<ConsoleSessionConfig, "db">;
interface Mirror {
  scanId: string; systemPrompt: string; tools: ConsoleSession["tools"]; messages: NativeMessage[];
  autonomyMode: ConsoleSession["autonomyMode"]; webSearchEnabled?: boolean; target: string;
  localScopePath?: string; sourceContext?: ConsoleSession["sourceContext"]; checkpoint?: ConsoleSessionCheckpoint; active?: boolean;
}
const DIRECT_CALLBACKS = ["requestScope", "requestLocalScope", "approveTool", "escalateScopedAudit", "askOperator", "sourceLessonHints"] as const;
const UNSUPPORTED = ["pluginHost", "mcpHost", "jevRuntime", "contribution", "developmentSourceRoot", "huntMemoryStore", "learningStore"] as const;
const BRIDGED = new Set<string>(["runtime", "scope", "skillAuthoring", "skillEditor", "workflowAuthoring", "workflowLifecycle", "conversationHistory", "onHarnessUpdate", ...DIRECT_CALLBACKS]);

function executionEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined &&
    /^(ZERO_(?:DISABLE_[A-Z0-9_]+|ALLOW_[A-Z0-9_]+|ALLOWED_LOCAL_ORIGINS|FEATURE_[A-Z0-9_]+|NO_TELEMETRY|MCP|0VERSE_MCP|0VERSE_ROOT|0VERSE_RUNTIME_CONFIG|BASH_TIMEOUT_MS|JEV_FEATURES|JEV_BROWSER_READ_ONLY_URLS|AUDIT_SKILLS_MANIFEST|NETWORK_[A-Z0-9_]+|PUBLIC_NETWORK|SCOPE_[A-Z0-9_]+)|DO_NOT_TRACK|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/.test(entry[0])));
}

/** Append truthful termination results; never replay or discard an old tool call. */
export function closeInterruptedHostToolCalls(messages: readonly NativeMessage[]): NativeMessage[] {
  const result = structuredClone(messages) as NativeMessage[];
  const pending = new Map<string, string>();
  for (const message of result) for (const block of message.content) {
    if (block.type === "tool_use") pending.set(block.id, block.name);
    if (block.type === "tool_result") pending.delete(block.tool_use_id);
  }
  if (pending.size) result.push({ role: "user", content: [...pending.keys()].map(id => ({ type: "tool_result" as const, tool_use_id: id, is_error: true,
    content: "This tool was interrupted. The host confirmed termination of this session execution and its registered owned resources. The tool was not replayed; completed external effects were not undone." })) });
  return result;
}

function serialConfig(config: Config, learningDbPath?: string): Record<string, unknown> {
  for (const key of UNSUPPORTED) if (config[key] !== undefined && !(key === "learningStore" && learningDbPath)) throw new Error(`Host ${key} requires an explicit worker adapter`);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (BRIDGED.has(key) || value === undefined || (key === "learningStore" && learningDbPath)) continue;
    if (["maxTurnTokens", "maxToolIterations"].includes(key) && value === Infinity) continue;
    const supplied = key === "skillDiscoveryOptions" && typeof value === "function" ? value() : value;
    const encoded = JSON.stringify(supplied, (_name, item) => {
      if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint" || (typeof item === "number" && !Number.isFinite(item))) throw new Error(`Host ${key} is not serializable`);
      if (item && typeof item === "object" && !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error(`Host ${key} contains a live resource`);
      return item;
    });
    if (encoded !== undefined) result[key] = JSON.parse(encoded);
  }
  if (config.scope) result.scope = config.scope.raw;
  if (config.workflowAuthoring?.editor) result.workflowEditorId = config.workflowAuthoring.editor.id;
  return result;
}

/** Explicit eligibility, never fallback to a different provider or execution profile. */
export function hostConsoleSessionSupport(config: Config, options: Pick<HostConsoleSessionOptions, "learningDbPath" | "executionEnvironment" | "scopeEnforcement"> = {}): { supported: boolean; reason?: string } {
  if (!["darwin", "linux"].includes(process.platform)) return { supported: false, reason: "Confirmed host session termination is qualified only on macOS and Linux; this platform keeps in-process execution" };
  if (!process.versions.bun) return { supported: false, reason: "Confirmed host session termination requires Bun native SQLite; Node's WASM database locks are not qualified for forced exit" };
  if (consoleJevFeatures(options.executionEnvironment ?? process.env).length > 0) return { supported: false, reason: "Enabled Jev features require the existing in-process execution adapter; private worker capability binding is not qualified" };
  try {
    encodeHostConsoleFrame({ type: "init", value: { sessionId: config.scanId, executionProfile: "local", config: serialConfig(config, options.learningDbPath), runtime: captureWebConsoleRuntimeBootstrap(config.runtime),
      learningDbPath: options.learningDbPath, executionEnvironment: options.executionEnvironment ?? executionEnvironment(), scopeEnforcement: options.scopeEnforcement ?? getScopeEnforcementState(config.workspaceRoot), callbacks: [...HOST_CONSOLE_CALLBACKS] } });
    return { supported: true };
  }
  catch { return { supported: false, reason: "This session has a runtime or live host resource that cannot be captured by the host execution worker" }; }
}

export interface HostConsoleSessionOptions {
  config: Config;
  dbPath?: string;
  /** Only supply after proving the injected host store uses this exact backing DB. */
  learningDbPath?: string;
  /** Captured execution/MCP policy, private pipe only; never a public snapshot. */
  executionEnvironment?: Record<string, string>;
  launch: Pick<HostConsoleProcessOptions, "command" | "args" | "cwd" | "env" | "graceMs" | "confirmationMs">;
  scopeEnforcement?: ScopeEnforcementState;
  onBus?: (name: string, value: unknown) => void;
  onSnapshot?: (value: unknown) => void;
}

export type HostConsoleSession = ConsoleSession & {
  forceStop(): Promise<HostConsoleStopResult>;
  readonly executionProcess: HostConsoleProcess;
};

export function createHostConsoleSession(options: HostConsoleSessionOptions): HostConsoleSession {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("Host session process termination is not qualified on this platform");
  if (!process.versions.bun) throw new Error("Host session process termination requires Bun native SQLite");
  if (consoleJevFeatures(options.executionEnvironment ?? process.env).length > 0) throw new Error("Enabled Jev features require the existing in-process execution adapter");
  const { config } = options;
  const serial = serialConfig(config, options.learningDbPath);
  const runtime = captureWebConsoleRuntimeBootstrap(config.runtime);
  if (!config.scanId) throw new Error("Host session workers require a stable session identity");
  let scope = config.initialCheckpoint
    ? config.initialCheckpoint.grantedScope === null ? undefined : ScopePolicy.fromJson(config.initialCheckpoint.grantedScope)
    : config.scope;
  let target = config.initialCheckpoint?.target ?? config.target ?? "";
  let localScopePath = config.initialCheckpoint?.localScopePath;
  let mirror: Mirror = {
    scanId: config.scanId, systemPrompt: config.systemPrompt ?? "", tools: config.tools ?? [],
    messages: structuredClone(config.initialMessages ?? config.initialCheckpoint?.messages ?? []),
    autonomyMode: config.initialCheckpoint?.autonomyMode ?? config.autonomyMode ?? "standard", target,
    webSearchEnabled: config.webSearchEnabled, checkpoint: config.initialCheckpoint,
  };
  let render: ConsoleRenderCallbacks | undefined;
  let turnUsage = { inputTokens: 0, outputTokens: 0 };
  let turnText = "";
  let lastUsage: ConsoleUsageReport | undefined;
  let completedTools: ConsoleTurnOutcome["toolCalls"] = [];
  let harnessSnapshot: ReturnType<NonNullable<ConsoleSession["harness"]>["snapshot"]> | undefined;
  let fenced = false;
  let handoff = false;
  let mutationError: unknown;
  let mutations = Promise.resolve();
  let cleanup: Promise<void> | undefined;
  let stop: Promise<HostConsoleStopResult> | undefined;
  const callbacks: Record<string, (...args: unknown[]) => unknown | Promise<unknown>> = {};
  for (const name of DIRECT_CALLBACKS) {
    const callback = config[name];
    if (typeof callback === "function") callbacks[name] = (...args) => (callback as (...args: unknown[]) => unknown)(...args);
  }
  if (config.requestScope) callbacks.requestScope = async (...args) => {
    const request = args[0] as Parameters<NonNullable<Config["requestScope"]>>[0];
    if (request.currentScope) request.currentScope = scope;
    const result = await config.requestScope!(request);
    if (result && !fenced) { scope = result.scope; target = result.target; mirror.target = result.target; }
    return result ? { ...result, scope: result.scope.raw } : null;
  };
  if (config.requestLocalScope) callbacks.requestLocalScope = async (...args) => {
    const result = await config.requestLocalScope!(args[0] as Parameters<NonNullable<Config["requestLocalScope"]>>[0]);
    if (result && !fenced) localScopePath = result.scopePath;
    return result;
  };
  if (config.conversationHistory) {
    callbacks.historyList = (...args) => config.conversationHistory!.list(...args as Parameters<NonNullable<Config["conversationHistory"]>["list"]>);
    callbacks.historyRead = (...args) => config.conversationHistory!.read(...args as Parameters<NonNullable<Config["conversationHistory"]>["read"]>);
  }
  if (config.skillAuthoring) for (const [name, method] of [["skillRead", "read"], ["skillCreate", "create"], ["skillSave", "update"], ["skillCopy", "copy"]] as const) {
    callbacks[name] = (...args) => {
      const adapter = typeof config.skillAuthoring === "function" ? config.skillAuthoring() : config.skillAuthoring!;
      if (!adapter) throw new Error("Host skill adapter is unavailable");
      return (adapter[method] as (...values: unknown[]) => unknown)(...args);
    };
  }
  if (config.skillEditor) callbacks.skillEditorRead = () => config.skillEditor!.read();
  if (config.workflowAuthoring) {
    callbacks.workflowList = () => config.workflowAuthoring!.list();
    callbacks.workflowSave = (...args) => config.workflowAuthoring!.save(args[0] as Parameters<NonNullable<Config["workflowAuthoring"]>["save"]>[0]);
    if (config.workflowAuthoring.editor) callbacks.workflowEditorRead = () => config.workflowAuthoring!.editor!.read();
  }
  if (config.workflowLifecycle) callbacks.workflowInvoke = (...args) => config.workflowLifecycle!.invoke(...args as Parameters<NonNullable<Config["workflowLifecycle"]>["invoke"]>);
  const policy = options.scopeEnforcement ?? getScopeEnforcementState(config.workspaceRoot);
  const bootstrap: HostConsoleBootstrap = { sessionId: config.scanId, executionProfile: "local", config: serial, dbPath: options.dbPath, learningDbPath: options.learningDbPath,
    executionEnvironment: options.executionEnvironment ?? executionEnvironment(), runtime, scopeEnforcement: policy, callbacks: Object.keys(callbacks) };
  // Eligibility must fail before an OS process is created; no silent truncation.
  encodeHostConsoleFrame({ type: "init", value: bootstrap });
  const earlyPolicy = Object.fromEntries(Object.entries(bootstrap.executionEnvironment).filter(([key]) =>
    /^(ZERO_(?:FEATURE_|DISABLE_|ALLOW_|ALLOWED_|NO_TELEMETRY)|DO_NOT_TRACK)/.test(key) && !/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/.test(key)));
  const controller = new HostConsoleProcess({ ...options.launch, env: { ...options.launch.env, ...earlyPolicy },
    onSnapshot(value) {
      if (fenced || !value || typeof value !== "object") return;
      const next = value as Mirror;
      if (next.scanId !== config.scanId || !Array.isArray(next.messages) || !Array.isArray(next.tools)) throw new Error("Invalid host session mirror");
      mirror = structuredClone(next); options.onSnapshot?.(value);
    },
    onCallback: async (name, args) => {
      if (fenced || !callbacks[name] || !HOST_CONSOLE_CALLBACKS.includes(name as typeof HOST_CONSOLE_CALLBACKS[number])) throw new Error("Host callback is not granted");
      return callbacks[name]!(...args);
    },
    onEvent(frame: HostConsoleFrame) {
      if (fenced) return;
      if (frame.type === "runtime-binding") { applyWebConsoleRuntimeBootstrap(config.runtime, frame.value as WebConsoleRuntimeBootstrap); return; }
      if (frame.type === "bus" && typeof frame.name === "string" && ["subagent_lifecycle", "subagent_progress", "subagent_message"].includes(frame.name)) { options.onBus?.(frame.name, frame.value); return; }
      if (frame.type === "harness") { harnessSnapshot = frame.value as typeof harnessSnapshot; config.onHarnessUpdate?.(frame.value as Parameters<NonNullable<Config["onHarnessUpdate"]>>[0]); return; }
      if (frame.type === "event" && typeof frame.name === "string" && ["onAssistantDelta", "onReasoningDelta", "onToolStart", "onToolResult", "onUsage", "onNotice", "onCompaction"].includes(frame.name) && Array.isArray(frame.args)) {
        if (frame.name === "onAssistantDelta" && typeof frame.args[0] === "string") turnText += frame.args[0];
        if (frame.name === "onUsage") {
          const usage = frame.args[0] as ConsoleUsageReport;
          if (typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number") { turnUsage.inputTokens += usage.inputTokens; turnUsage.outputTokens += usage.outputTokens; lastUsage = usage; }
        }
        if (frame.name === "onToolResult") completedTools.push({ call: frame.args[0] as ConsoleTurnOutcome["toolCalls"][number]["call"], result: frame.args[1] as ConsoleTurnOutcome["toolCalls"][number]["result"] });
        const callback = render?.[frame.name as keyof ConsoleRenderCallbacks];
        if (callback) (callback as (...args: unknown[]) => void)(...frame.args);
      }
    },
  });
  const ready = controller.start(bootstrap);
  void ready.catch(() => {});
  const ensure = () => { if (fenced || handoff) throw new Error("Host session execution is fenced"); if (mutationError) throw mutationError; };
  const queue = (op: string, value: unknown) => {
    ensure();
    mutations = mutations.then(async () => { await ready; ensure(); await controller.request(op, { value }); }).catch(error => { mutationError = error; });
  };
  const forceStop = () => {
    fenced = true;
    return stop ??= controller.forceStop().then(result => {
      if (result.processExited && result.resourcesStopped && !result.quarantined) {
        mirror.messages = closeInterruptedHostToolCalls(mirror.messages);
        mirror.active = false;
        mirror.checkpoint = undefined;
      }
      return result;
    });
  };
  // Only renderer-facing harness operations cross the boundary; execution and
  // harness resource ownership remain in the dedicated process.
  const harnessProxy = {
    snapshot: () => structuredClone(harnessSnapshot!),
    interact: async (value: Parameters<NonNullable<ConsoleSession["harness"]>["interact"]>[0]) => {
      await ready; await mutations; ensure();
      return controller.request("harness", { value });
    },
  } as unknown as NonNullable<ConsoleSession["harness"]>;
  return {
    get executionProcess() { return controller; },
    get scanId() { return mirror.scanId; }, ready,
    get systemPrompt() { return mirror.systemPrompt; }, get tools() { return mirror.tools; }, get messages() { return mirror.messages; },
    get autonomyMode() { return mirror.autonomyMode; }, get target() { return target; }, get scope() { return scope; },
    get scopeEnforcement() { return policy; }, get localScopePath() { return localScopePath ?? undefined; },
    get sourceContext() { return mirror.sourceContext; }, get webSearchEnabled() { return mirror.webSearchEnabled; },
    get harness() { return harnessSnapshot ? harnessProxy : undefined; },
    setAutonomyMode(value) { queue("autonomy", value); mirror.autonomyMode = value; },
    setWebSearchEnabled(value) { queue("webSearch", value); return mutations; },
    configureEngagement(value) { queue("configure", { ...value, ...(value.scope === undefined ? {} : { scope: value.scope?.raw ?? null }) }); if (value.scope !== undefined) scope = value.scope ?? undefined; if (value.target !== undefined) { target = value.target; mirror.target = value.target; } },
    configureWorkspace(value) { queue("workspace", value); localScopePath = value; },
    reconfigureRuntime(value) { queue("reconfigure", value); },
    clearConversation() { queue("clear", undefined); mirror.messages = []; },
    async send(text, callbacks, sendOptions) {
      await ready; await mutations; ensure(); render = callbacks;
      turnUsage = { inputTokens: 0, outputTokens: 0 }; lastUsage = undefined; turnText = ""; completedTools = [];
      const abort = () => {
        if (!fenced) {
          const reason: unknown = sendOptions?.signal?.reason;
          controller.abort(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : undefined);
        }
      };
      sendOptions?.signal?.addEventListener("abort", abort, { once: true });
      try {
        if (sendOptions?.signal?.aborted) throw sendOptions.signal.reason;
        return await controller.request("send", { text, images: sendOptions?.images, generateTitle: sendOptions?.generateTitle }) as Awaited<ReturnType<ConsoleSession["send"]>>;
      } catch (error) {
        if (!stop || (await stop).quarantined) throw error;
        const receipt = lastUsage as ConsoleUsageReport | undefined; // Updated by incoming IPC callbacks.
        const notice = "Session execution and registered resources were confirmed stopped. Any in-flight request without a usage receipt remains unpriced; completed external effects were not undone.";
        callbacks?.onNotice?.(notice);
        return { assistantText: turnText, toolCalls: completedTools, usage: turnUsage,
          budget: { tokensUsed: turnUsage.inputTokens + turnUsage.outputTokens, tokenBudget: receipt?.turnTokenBudget ?? config.maxTurnTokens ?? Infinity,
            iterations: receipt?.iterations ?? 0, maxToolIterations: receipt?.maxToolIterations ?? config.maxToolIterations ?? Infinity },
          stopReason: "cancelled", error: notice };
      } finally { render = undefined; sendOptions?.signal?.removeEventListener("abort", abort); }
    },
    async stopPersistentAgent(agentId) { await ready; ensure(); return await controller.request("stopWorker", { agentId }) as boolean; },
    async stopPersistentAgents() { await ready; ensure(); await controller.request("stopWorkers"); },
    exportCheckpoint() { ensure(); if (mirror.active || !mirror.checkpoint || mutationError) throw new Error("Host session is not quiescent"); return structuredClone(mirror.checkpoint); },
    async prepareHandoff() { await ready; await mutations; ensure(); const value = await controller.request("handoff") as { warnings?: string[] }; handoff = true; return value; },
    forceStop,
    cleanup() { return cleanup ??= (async () => {
      if (!fenced) {
        const timer = setTimeout(() => { void forceStop(); }, 1000);
        try { await ready; await controller.request("close"); }
        catch { /* The deadline triggers real process termination, never fake completion. */ }
        finally { clearTimeout(timer); }
      }
      const result = await forceStop();
      if (result.quarantined) throw new Error("Host session resource teardown could not be confirmed");
    })(); },
  };
}
