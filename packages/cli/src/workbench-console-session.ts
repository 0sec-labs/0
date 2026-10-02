import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { DEFAULT_MAX_TOOL_ITERATIONS, getScopeEnforcementState, runSmolvmWorkbench, ScopePolicy } from "@0/core";
import type { ConsoleSession, ConsoleSessionConfig, ConsoleSessionCheckpoint, ConsoleRenderCallbacks, ConsoleTurnOutcome, SmolvmWorkbenchResult, SmolvmWorkbenchOptions } from "@0/core";
import { findingSchema, type Finding } from "@0/shared";
import type { TuiSettings } from "./tui/settings.js";
import type { WorkbenchConfig } from "./workbench.js";
import { prepareWorkbenchPlugins, GUEST_PLUGIN_ASSETS } from "./workbench-plugins.js";
import { encodeWorkbenchFrame, WorkbenchFrameReader, WORKBENCH_MAX_PENDING, guestWorkspacePath, hostWorkspacePath, mapWorkbenchTarget, mapWorkbenchCheckpoint, serializeWorkbenchConfig, validateWorkbenchSourceContext, validateWorkbenchSourceLesson } from "./workbench-console-protocol.js";
import type { WorkbenchFrame, WorkbenchSourceContextArtifact, WorkbenchSourceLesson } from "./workbench-console-protocol.js";
import { servicePluginSecretRedactor, validateGuestServicePluginConnections } from "./workbench-service-plugins.js";

export interface WorkbenchExecutionSnapshot {
  backend: "smolvm"; status: "pending" | "ready" | "running" | "stopped" | "failed";
  runId?: string; workspacePath?: string; guestWorkspacePath?: string; imageDigest?: string; cpus?: number; memoryMb?: number; message?: string;
}
export interface WorkbenchProviderTransport {
  provider: "chatgpt-codex"; models: readonly string[];
  request(envelope: { provider: "chatgpt-codex"; model: string; body: string }, signal?: AbortSignal): Promise<Response>;
  close?(): Promise<void>;
}
export interface WorkbenchControllerOptions {
  workbench: WorkbenchConfig;
  selection: { model: string; provider?: "chatgpt-codex"; contextWindowTokens?: number | null; agentModels?: Record<string, string>; singleModel?: boolean; autoRoute?: boolean };
  provider: WorkbenchProviderTransport;
  network: boolean;
  onExecution?: (snapshot: WorkbenchExecutionSnapshot) => void;
  lifetimeMs?: number; idleMs?: number;
  guestCommand?: readonly string[];
  assets?: { cliDist: string; dependencies?: string };
  artifactDirectory?: string;
  guestSettings?: TuiSettings;
  pluginHomeDir?: string;
}
export interface WorkbenchConsoleSessionOptions extends WorkbenchControllerOptions {
  config: Omit<ConsoleSessionConfig, "runtime" | "db">;
  onFindings?: (findings: Finding[], completion?: { outcome?: ConsoleTurnOutcome }) => void | Promise<void>;
  /** Trusted host persistence adapter; source references have been rehashed and scoped on host. */
  onSourceContext?: (artifact: WorkbenchSourceContextArtifact, context: { workspaceRoot: string; scanId: string; runId: string }) => void | Promise<void>;
  onSourceLesson?: (lesson: WorkbenchSourceLesson, context: { workspaceRoot: string; scopePath: string; scanId: string; runId: string }) => void | Promise<void>;
  readSourceLessons?: (context: { workspaceRoot: string; scopePath: string }) => WorkbenchSourceLesson[] | Promise<WorkbenchSourceLesson[]>;
}
const EVENTS = new Set(["onHarnessUpdate", "onAssistantDelta", "onReasoningDelta", "onToolStart", "onToolResult", "onUsage", "onNotice", "onCompaction"]);
const DECISIONS = new Set(["requestScope", "requestLocalScope", "approveTool", "escalateScopedAudit", "askOperator", "historyList", "historyRead", "sourceLessons"]);
function validateOptions(options: WorkbenchControllerOptions): void {
  if (options.provider.provider !== "chatgpt-codex" || (options.selection.provider && options.selection.provider !== "chatgpt-codex") || !options.provider.models.includes(options.selection.model)) throw new Error("Workbench requires an explicit host provider/model grant");
  for (const model of Object.values(options.selection.agentModels ?? {})) if (model !== "auto" && !options.provider.models.includes(model)) throw new Error("Workbench worker model is outside the host provider grant");
  for (const [name, value, max] of [["lifetimeMs", options.lifetimeMs ?? 30 * 60_000, 60 * 60_000], ["idleMs", options.idleMs ?? 5 * 60_000, 15 * 60_000]] as const) if (!Number.isSafeInteger(value) || value < 1000 || value > max) throw new Error(`Invalid workbench ${name}`);
}
function guestCommand(options: WorkbenchControllerOptions, cli: boolean): { command: readonly string[]; mounts?: SmolvmWorkbenchOptions["readOnlyMounts"] } {
  if (options.guestCommand) return { command: options.guestCommand };
  const entry = cli ? "run-agent" : "console-agent";
  if (!options.assets) return { command: ["/usr/local/bin/0", "--workbench-inner", "workbench", entry] };
  // Current compiled code is copied inside the guest; host asset grants remain read-only.
  const dependencies = options.assets.dependencies ? "/opt/0-controller-deps/node_modules" : "/opt/0/node_modules";
  const script = `const fs=require('node:fs');const path='/tmp/0-controller-cli';fs.cpSync('/opt/0-controller-cli',path,{recursive:true});fs.symlinkSync(${JSON.stringify(dependencies)},path+'/node_modules');const child=require('node:child_process').spawn(process.execPath,[path+'/0.js','--workbench-inner','workbench',${JSON.stringify(entry)}],{stdio:'inherit',env:process.env});child.once('error',e=>{console.error(e.message);process.exit(1)});child.once('exit',code=>process.exit(code??1));`;
  return { command: ["/usr/local/bin/node", "--eval", script], mounts: [{ source: options.assets.cliDist, target: "/opt/0-controller-cli" }, ...(options.assets.dependencies ? [{ source: options.assets.dependencies, target: "/opt/0-controller-deps/node_modules" }] : [])] };
}

/** A single owned VM, immutable workspace grant and bounded host/guest protocol. */
class Controller {
  readonly abort = new AbortController();
  readonly runId = randomUUID();
  readonly workspace: string;
  execution: WorkbenchExecutionSnapshot;
  ready: Promise<void>;
  done?: Promise<SmolvmWorkbenchResult>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private input?: { write(data: string): void; end(): void };
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private providers = new Map<string, AbortController>();
  private idle?: ReturnType<typeof setTimeout>;
  private lifetime?: ReturnType<typeof setTimeout>;
  private started = false;
  private guestReady = false;
  private startupStderr = "";
  private redact = (value: string) => value;
  receive: (frame: WorkbenchFrame) => void = () => {};
  decision: (name: string, args: unknown[]) => Promise<unknown> = async () => null;
  constructor(readonly options: WorkbenchControllerOptions, readonly init: Record<string, unknown>, readonly cli: boolean) {
    validateOptions(options); this.workspace = realpathSync(options.workbench.workspaceRoot ?? process.cwd());
    this.execution = { backend: "smolvm", status: "pending", runId: this.runId, workspacePath: this.workspace, guestWorkspacePath: "/workspace", imageDigest: options.workbench.imageDigest, cpus: options.workbench.cpus, memoryMb: options.workbench.memoryMb };
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => {});
  }
  status(status: WorkbenchExecutionSnapshot["status"], message?: string): void { const { message: _previous, ...snapshot } = this.execution; this.execution = { ...snapshot, status, ...(message ? { message } : {}) }; this.options.onExecution?.(this.execution); }
  write(frame: WorkbenchFrame): void { if (!this.input || this.abort.signal.aborted) throw new Error("Workbench VM is unavailable"); this.input.write(encodeWorkbenchFrame(frame)); }
  touch(): void { clearTimeout(this.idle); this.idle = setTimeout(() => { this.abort.abort(new Error("Workbench idle deadline expired")); }, this.options.idleMs ?? 5 * 60_000); this.idle.unref(); }
  async start(): Promise<void> {
    if (this.started) return this.ready; this.started = true; this.status("pending", "Preparing workspace");
    let stagedPlugins: Awaited<ReturnType<typeof prepareWorkbenchPlugins>> | undefined;
    this.lifetime = setTimeout(() => this.abort.abort(new Error("Workbench lifetime expired")), this.options.lifetimeMs ?? 30 * 60_000); this.lifetime.unref();
    try {
      const root = join(this.options.workbench.stateRoot, "controller-results"); await mkdir(root, { recursive: true, mode: 0o700 });
      const artifacts = this.options.artifactDirectory ?? await realpath(await mkdtemp(join(root, "run-")));
      const reader = new WorkbenchFrameReader(); const launch = guestCommand(this.options, this.cli);
      const connections = this.cli ? [] : (await import("./web/service-plugins.js")).loadServicePluginConnections(this.options.pluginHomeDir).filter(item => item.enabled);
      const servicePluginConnections = validateGuestServicePluginConnections(connections, this.options.network);
      this.redact = servicePluginSecretRedactor(servicePluginConnections);
      const plugins = stagedPlugins = await prepareWorkbenchPlugins(this.workspace, this.options.pluginHomeDir);
      this.done = runSmolvmWorkbench({ image: this.options.workbench.image, stateRoot: this.options.workbench.stateRoot, workspaceRoot: this.workspace,
        onStartupProgress: message => this.status("pending", message),
        command: launch.command, environment: { ZERO_PROVIDER: "chatgpt-codex", ZERO_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" }, network: this.options.network,
        tty: false, cpus: this.options.workbench.cpus, memoryMb: this.options.workbench.memoryMb, storageGb: this.options.workbench.storageGb,
        approvedImages: this.options.workbench.approvedImages, signal: this.abort.signal, workspaceMode: "snapshot", artifactDirectory: artifacts,
        readOnlyMounts: [...(launch.mounts ?? []), ...(plugins.directory ? [{ source: plugins.directory, target: GUEST_PLUGIN_ASSETS }] : [])], transport: { initialInput: encodeWorkbenchFrame({ type: "init", ...this.init, servicePluginConnections, servicePluginNetworkGranted: this.options.network, pluginApprovals: plugins.approvals, guestSettings: this.options.guestSettings, selection: { ...this.options.selection, provider: "chatgpt-codex" } }), onReady: input => { this.input = input; }, onStdout: data => reader.push(data, frame => this.dispatch(frame)), onStderr: data => { this.startupStderr = this.redact(this.startupStderr + data).slice(-4096); } },
      });
      this.done = this.done.finally(() => plugins.cleanup());
      void this.done.then(async result => {
        const error = new Error(this.redact(result.error ?? "Workbench VM exited") + (!this.guestReady && this.startupStderr.trim() ? `: ${this.startupStderr.trim()}` : ""));
        if (!this.guestReady) this.rejectReady(error);
        for (const pending of this.pending.values()) pending.reject(error); this.pending.clear();
        clearTimeout(this.idle); clearTimeout(this.lifetime);
        for (const pending of this.providers.values()) pending.abort(); this.providers.clear();
        await this.options.provider.close?.();
        this.status(result.cleanupFailed || (result.exitCode !== 0 && !this.abort.signal.aborted) ? "failed" : "stopped", result.error ? this.redact(result.error) : undefined);
      });
      this.touch(); await this.ready;
    } catch (error) {
      if (!this.done) { await stagedPlugins?.cleanup(); await this.options.provider.close?.(); }
      clearTimeout(this.idle); clearTimeout(this.lifetime); this.abort.abort(); this.rejectReady(new Error(this.redact(error instanceof Error ? error.message : "Workbench startup failed"))); this.status("failed", this.redact(error instanceof Error ? error.message : "Workbench startup failed")); throw new Error(this.redact(error instanceof Error ? error.message : "Workbench startup failed")); }
  }
  private dispatch(frame: WorkbenchFrame): void {
    if (frame.type === "ready") { if (this.guestReady || frame.platform !== "linux" || frame.workspace !== "/workspace") throw new Error("Invalid workbench guest readiness"); this.guestReady = true; this.status("ready"); this.resolveReady(); return; }
    if (frame.type === "provider") { void this.provider(frame); return; }
    if (frame.type === "provider-cancel") { this.providers.get(frame.id!)?.abort(); return; }
    if (frame.type === "decision") {
      if (!DECISIONS.has(String(frame.name)) || !Array.isArray(frame.args)) throw new Error("Invalid guest decision callback");
      void this.decision(String(frame.name), frame.args).then(value => this.write({ type: "decision-result", id: frame.id, value }), () => this.write({ type: "decision-result", id: frame.id, error: "Host decision unavailable" })).catch(() => {}); return;
    }
    if (frame.type === "result" || frame.type === "error") {
      const pending = this.pending.get(frame.id!); this.pending.delete(frame.id!);
      if (frame.type === "error") { const error = new Error(typeof frame.error === "string" ? this.redact(frame.error) : "Guest operation failed"); if (!this.guestReady) this.rejectReady(error); pending?.reject(error); }
      else pending?.resolve(frame.value); return;
    }
    this.receive(frame);
  }
  private async provider(frame: WorkbenchFrame): Promise<void> {
    if (!frame.id || this.providers.size >= 4 || this.providers.has(frame.id)) { this.abort.abort(new Error("Invalid guest provider request")); return; }
    const envelope = frame.envelope as { provider: "chatgpt-codex"; model: string; body: unknown };
    const abort = new AbortController(); this.providers.set(frame.id, abort);
    const cancel = () => abort.abort(); this.abort.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (!envelope || envelope.provider !== "chatgpt-codex" || !this.options.provider.models.includes(envelope.model) || typeof envelope.body !== "string") throw new Error("Invalid guest provider envelope");
      const response = await this.options.provider.request({ provider: envelope.provider, model: envelope.model, body: envelope.body as string }, abort.signal);
      this.write({ type: "provider-headers", id: frame.id, status: response.status, contentType: response.headers.get("content-type") ?? "text/event-stream" });
      let bytes = 0;
      if (response.body) { const reader = response.body.getReader(); try { while (true) { const next = await reader.read(); if (next.done) break; const chunk = next.value; bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw new Error("Provider response exceeds controller limit"); for (let offset = 0; offset < chunk.length; offset += 49152) this.write({ type: "provider-chunk", id: frame.id, data: Buffer.from(chunk.subarray(offset, offset + 49152)).toString("base64") }); } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
      this.write({ type: "provider-end", id: frame.id });
    } catch { try { this.write({ type: "provider-error", id: frame.id }); } catch { /* VM already cancelled. */ } }
    finally { this.providers.delete(frame.id); this.abort.signal.removeEventListener("abort", cancel); }
  }
  async request(op: string, values: Record<string, unknown> = {}): Promise<unknown> {
    await this.start(); if (this.pending.size >= WORKBENCH_MAX_PENDING) throw new Error("Workbench request limit reached"); this.touch();
    const id = randomUUID(); const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    try { this.write({ type: "request", id, op, ...values }); } catch (error) { this.pending.delete(id); throw error; } return result;
  }
  async close(beforeRelease?: () => Promise<void>): Promise<void> {
    if (!this.started) { await this.options.provider.close?.(); return; }
    let exited = false;
    try {
      await Promise.race([this.request("close"), new Promise((_, reject) => setTimeout(() => reject(new Error("Workbench close acknowledgement timed out")), 1000))]);
      await beforeRelease?.();
      this.write({ type: "release" });
      this.input?.end();
      await Promise.race([this.done?.then(() => { exited = true; }), new Promise(resolve => setTimeout(resolve, 1000))]);
    } catch (error) {
      // Persisting artifacts may fail, but native teardown must still be confirmed.
      this.abort.abort();
      const result = await this.done;
      if (result?.cleanupFailed) throw new Error(result.error ?? "Workbench teardown could not be confirmed");
      if (beforeRelease) await beforeRelease();
      // Native shutdown races are benign; persistence failures are not.
    }
    finally {
      if (!exited) this.abort.abort();
      const result = await this.done;
      if (result?.cleanupFailed) throw new Error(result.error ?? "Workbench teardown could not be confirmed");
    }
  }
}

export function createWorkbenchConsoleSession(options: WorkbenchConsoleSessionOptions): ConsoleSession & { readonly execution: WorkbenchExecutionSnapshot } {
  const workspace = realpathSync(options.workbench.workspaceRoot ?? options.config.workspaceRoot ?? process.cwd());
  const config = { ...options.config, scanId: options.config.scanId ?? `console-${randomUUID()}` };
  const serial = serializeWorkbenchConfig(config, workspace);
  const callbacks = [...DECISIONS].filter(name => name === "historyList" || name === "historyRead" ? !!config.conversationHistory : typeof (config as unknown as Record<string, unknown>)[name] === "function");
  const sourceLearningEnabled = config.codebaseLearning === true && config.role !== "verify" && !/^(1|true)$/i.test(process.env.ZERO_DISABLE_HUNT_MEMORY ?? "");
  if (sourceLearningEnabled && options.readSourceLessons) callbacks.push("sourceLessons");
  const scopeEnforcement = getScopeEnforcementState(workspace, options.pluginHomeDir);
  const controller = new Controller({ ...options, workbench: { ...options.workbench, workspaceRoot: workspace } }, { config: serial, callbacks, scopeEnforcement }, false);
  let messages = structuredClone(config.initialMessages ?? config.initialCheckpoint?.messages ?? []);
  let checkpoint = config.initialCheckpoint;
  let target = config.target ?? ""; let scope = config.scope; let localScopePath = config.initialCheckpoint?.localScopePath ?? undefined;
  // Guest state never creates authority. Only the host's initial grant and approval callback do.
  let explicitYoloSourceGrant = !!options.workbench.workspaceRoot && config.autonomyMode === "yolo";
  let sourceScopePath = config.initialCheckpoint?.localScopePath ?? (!scopeEnforcement.enabled || explicitYoloSourceGrant ? workspace : undefined);
  const authorizedSourceRoot = (guestPath: unknown): string | undefined => {
    if (!sourceScopePath || typeof guestPath !== "string") return undefined;
    try {
      const requested = realpathSync(hostWorkspacePath(guestPath, workspace));
      const approved = realpathSync(sourceScopePath);
      if (!statSync(requested).isDirectory()) return undefined;
      if (requested === approved || (explicitYoloSourceGrant && (requested === workspace || requested.startsWith(workspace + sep)))) return requested;
    } catch { /* Unknown or foreign scope is not authority. */ }
    return undefined;
  };
  const sourceArtifacts = new Set<string>();
  let sourceFrames = 0;
  let sourcePersistence = Promise.resolve();
  const flushSourceContext = async () => { try { await sourcePersistence; } catch { throw new Error("Workbench source context persistence failed"); } };
  let autonomyMode = config.autonomyMode ?? "standard";
  let systemPrompt = config.systemPrompt ?? ""; let tools = config.tools ?? [];
  let render: ConsoleRenderCallbacks | undefined; let active = false; let findings: Finding[] = []; let engineWorkStarted = false; let lastOutcome: ConsoleTurnOutcome | undefined; let cleanupPromise: Promise<void> | undefined;
  const deferred: Promise<unknown>[] = [];
  const queue = (op: string, value?: unknown) => { if (!controller.done) { serial[op === "autonomy" ? "autonomyMode" : op] = value; return; } const pending = controller.request(op, { value }); deferred.push(pending); void pending.catch(() => {}); };
  controller.decision = async (name, args) => {
    if (name === "sourceLessons") {
      if (!sourceLearningEnabled || !sourceScopePath || !options.readSourceLessons || /^(1|true)$/i.test(process.env.ZERO_DISABLE_HUNT_MEMORY ?? "") || args.length !== 1 || typeof args[0] !== "string") return [];
      const requested = authorizedSourceRoot(args[0]);
      if (!requested) return []; // Only exact scope or a subtree of an explicit host YOLO grant.
      await flushSourceContext();
      const notes = await options.readSourceLessons({ workspaceRoot: workspace, scopePath: requested });
      return notes.slice(0, 6).flatMap(note => {
        try { return [validateWorkbenchSourceLesson(note, workspace, requested)]; } catch { return []; }
      });
    }
    if (name === "historyList") return config.conversationHistory!.list(...args as Parameters<NonNullable<ConsoleSessionConfig["conversationHistory"]>["list"]>);
    if (name === "historyRead") return config.conversationHistory!.read(...args as Parameters<NonNullable<ConsoleSessionConfig["conversationHistory"]>["read"]>);
    const callback = (config as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name];
    if (!callback || !callbacks.includes(name)) return null;
    if (name === "requestLocalScope") {
      const request = structuredClone(args[0]) as Record<string, unknown>;
      for (const key of ["requestedPath", "currentScopePath"]) if (typeof request[key] === "string") request[key] = hostWorkspacePath(request[key] as string, workspace);
      const value = await callback(request); if (!value) return null; const resolution = value as { scopePath: string }; const guestPath = guestWorkspacePath(resolution.scopePath, workspace); sourceScopePath = hostWorkspacePath(guestPath, workspace); return { scopePath: guestPath };
    }
    if (name === "requestScope") {
      const request = args[0] as Record<string, unknown>;
      const value = await callback({ ...request, target: mapWorkbenchTarget(String(request.target ?? ""), workspace, true), ...(request.currentScope ? { currentScope: new ScopePolicy((request.currentScope as { raw: ConstructorParameters<typeof ScopePolicy>[0] }).raw) } : {}) });
      if (!value) return null; const resolution = value as { target: string; scope: ScopePolicy }; return { target: mapWorkbenchTarget(resolution.target, workspace), scope: resolution.scope.raw };
    }
    return callback(...args);
  };
  controller.receive = frame => {
    if (frame.type === "source-lesson") {
      if (++sourceFrames > 128) throw new Error("Workbench source export limit reached");
      if (!sourceLearningEnabled || !options.onSourceLesson || !sourceScopePath || /^(1|true)$/i.test(process.env.ZERO_DISABLE_HUNT_MEMORY ?? "")) return;
      const lessonScope = frame.scopePath === undefined ? sourceScopePath : authorizedSourceRoot(frame.scopePath);
      if (!lessonScope) return;
      let lesson: WorkbenchSourceLesson;
      try { lesson = validateWorkbenchSourceLesson(frame.lesson, workspace, lessonScope); } catch { return; }
      const key = JSON.stringify({ scopePath: lessonScope, lesson });
      if (sourceArtifacts.has(key)) return;
      sourceArtifacts.add(key);
      const scopePath = lessonScope;
      sourcePersistence = sourcePersistence.then(() => options.onSourceLesson!(lesson, { workspaceRoot: workspace, scopePath, scanId: config.scanId, runId: controller.runId }));
      void sourcePersistence.catch(() => {});
    } else if (frame.type === "source-context") {
      if (++sourceFrames > 128) throw new Error("Workbench source context export limit reached");
      if (!sourceLearningEnabled || !options.onSourceContext || !sourceScopePath || /^(1|true)$/i.test(process.env.ZERO_DISABLE_HUNT_MEMORY ?? "")) return;
      let artifact: WorkbenchSourceContextArtifact;
      try { artifact = validateWorkbenchSourceContext(frame.artifact, workspace, sourceScopePath); } catch { return; } // Untrusted or stale guest evidence grants nothing.
      const key = JSON.stringify(artifact);
      if (sourceArtifacts.has(key)) return;
      sourceArtifacts.add(key);
      sourcePersistence = sourcePersistence.then(() => options.onSourceContext!(artifact, { workspaceRoot: workspace, scanId: config.scanId, runId: controller.runId }));
      void sourcePersistence.catch(() => {});
    } else if (frame.type === "state") {
      const state = frame.snapshot as Record<string, unknown>;
      if (!state || state.scanId !== config.scanId || !Array.isArray(state.messages) || state.messages.length > 10000 || !Array.isArray(state.tools)) throw new Error("Invalid guest session state");
      messages = state.messages as typeof messages; systemPrompt = String(state.systemPrompt ?? ""); tools = state.tools as typeof tools;
      target = mapWorkbenchTarget(String(state.target ?? ""), workspace, true);
      scope = state.scope ? new ScopePolicy(state.scope as ConstructorParameters<typeof ScopePolicy>[0]) : undefined;
      localScopePath = state.localScopePath ? hostWorkspacePath(String(state.localScopePath), workspace) : undefined;
      autonomyMode = state.autonomyMode as typeof autonomyMode;
      checkpoint = state.checkpoint ? mapWorkbenchCheckpoint(state.checkpoint as ConsoleSessionCheckpoint, workspace, true) : undefined;
    } else if (frame.type === "event") {
      if (!EVENTS.has(String(frame.name)) || !Array.isArray(frame.args)) throw new Error("Invalid guest render callback");
      const callback = render?.[frame.name as keyof ConsoleRenderCallbacks] as ((...args: unknown[]) => void) | undefined; callback?.(...frame.args);
    } else if (frame.type === "findings") {
      if (!Array.isArray(frame.findings) || frame.findings.length > 1000) throw new Error("Invalid guest findings");
      findings = frame.findings.map(finding => findingSchema.parse(finding) as Finding);
    } else throw new Error("Unsupported guest controller event");
  };
  return {
    scanId: config.scanId, ready: Promise.resolve(), get execution() { return controller.execution; }, get systemPrompt() { return systemPrompt; }, get tools() { return tools; }, get messages() { return messages; },
    get target() { return target; }, get scope() { return scope; }, get localScopePath() { return localScopePath; }, get autonomyMode() { return autonomyMode; }, scopeEnforcement,
    setAutonomyMode(mode) {
      autonomyMode = mode;
      if (mode === "yolo" && options.workbench.workspaceRoot) { explicitYoloSourceGrant = true; sourceScopePath ??= workspace; }
      queue("autonomy", mode);
    },
    configureEngagement(selection) { if (selection.target !== undefined) target = selection.target; if (selection.scope !== undefined) scope = selection.scope ?? undefined;
      const value = { ...(selection.target === undefined ? {} : { target: mapWorkbenchTarget(selection.target, workspace) }), ...(selection.scope === undefined ? {} : { scope: selection.scope?.raw ?? null }) };
      if (!controller.done) Object.assign(serial, value); else queue("configure", value); },
    configureWorkspace(path) { if (realpathSync(path) !== workspace) throw new Error("The SmolVM workspace grant is fixed for this chat; start a new chat to change it"); },
    reconfigureRuntime(selection) { if (selection.env !== undefined || (selection.provider && selection.provider !== "chatgpt-codex") || (selection.model && !options.provider.models.includes(selection.model)) || Object.values(selection.agentModels ?? {}).some(model => model !== "auto" && !options.provider.models.includes(model))) throw new Error("Runtime selection is outside workbench provider grant");
      Object.assign(options.selection, selection); if (controller.done) queue("reconfigure", selection); },
    clearConversation() { messages = []; checkpoint = undefined; if (!controller.done) { serial.initialMessages = []; delete serial.initialCheckpoint; } else queue("clear"); },
    async send(text, callbacks, sendOptions) {
      if (active) throw new Error("Workbench turn already active"); active = true;
      let partialText = "";
      const partialTools: ConsoleTurnOutcome["toolCalls"] = [];
      const partialUsage = { inputTokens: 0, outputTokens: 0 };
      let usageReport: Parameters<NonNullable<ConsoleRenderCallbacks["onUsage"]>>[0] | undefined;
      render = { ...callbacks,
        onAssistantDelta: text => { partialText += text; callbacks?.onAssistantDelta?.(text); },
        onToolResult: (call, result) => { partialTools.push({ call, result }); callbacks?.onToolResult?.(call, result); },
        onUsage: usage => { partialUsage.inputTokens += usage.inputTokens; partialUsage.outputTokens += usage.outputTokens; usageReport = usage; callbacks?.onUsage?.(usage); },
      };
      const messageCountBeforeTurn = messages.length;
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => { if (controller.execution.status === "pending") { controller.abort.abort(new Error("Operator cancelled workbench startup")); return; } try { controller.write({ type: "cancel" }); } catch { /* VM may be stopping. */ } cancelTimer ??= setTimeout(() => controller.abort.abort(new Error("Operator cancelled workbench turn")), 2000); };
      sendOptions?.signal?.addEventListener("abort", cancel, { once: true });
      try { if (sendOptions?.signal?.aborted) cancel(); await Promise.all(deferred.splice(0)); await controller.start(); sendOptions?.signal?.throwIfAborted(); controller.status("running"); engineWorkStarted = true;
        lastOutcome = await controller.request("send", { text, generateTitle: sendOptions?.generateTitle }) as Awaited<ReturnType<ConsoleSession["send"]>>; await flushSourceContext(); return lastOutcome;
      } catch (error) {
        if (sendOptions?.signal?.aborted) {
          const result = await controller.done;
          if ((!result || !result.cleanupFailed) && controller.abort.signal.aborted) {
            controller.status("stopped");
            if (messages.length === messageCountBeforeTurn) messages.push({ role: "user", content: [{ type: "text", text }] });
            if (partialText && messages.at(-1)?.role !== "assistant") messages.push({ role: "assistant", content: [{ type: "text", text: partialText }] });
            return lastOutcome = { assistantText: partialText, toolCalls: partialTools, usage: partialUsage, budget: { tokensUsed: usageReport?.turnTokensUsed ?? partialUsage.inputTokens + partialUsage.outputTokens, tokenBudget: usageReport?.turnTokenBudget ?? options.config.maxTurnTokens ?? Infinity, iterations: usageReport?.iterations ?? 0, maxToolIterations: usageReport?.maxToolIterations ?? options.config.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS }, stopReason: "cancelled" };
          }
        }
        throw error;
      } finally { clearTimeout(cancelTimer); active = false; render = undefined; sendOptions?.signal?.removeEventListener("abort", cancel); if (!controller.abort.signal.aborted && controller.execution.status !== "stopped" && controller.execution.status !== "failed") controller.status("ready"); }
    },
    async stopPersistentAgent(agentId) { return await controller.request("stopWorker", { agentId }) as boolean; }, async stopPersistentAgents() { if (controller.done) await controller.request("stopWorkers"); },
    exportCheckpoint() { if (active || !checkpoint) throw new Error("No quiescent VM checkpoint is available"); return structuredClone(checkpoint); },
    async prepareHandoff() { if (active) throw new Error("Cannot hand off active VM turn"); if (!controller.done) return {}; return await controller.request("handoff") as { warnings?: string[] }; },
    cleanup() { return cleanupPromise ??= (async () => { await controller.close(flushSourceContext); await flushSourceContext(); if (engineWorkStarted && controller.done) await options.onFindings?.(findings, { outcome: lastOutcome }); })(); },
  };
}

export async function runWorkbenchCli(options: WorkbenchControllerOptions & { args: readonly string[]; signal?: AbortSignal; onStdout?: (data: string) => void; onStderr?: (data: string) => void }): Promise<SmolvmWorkbenchResult> {
  if (options.args.length > 512 || options.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Invalid workbench CLI argv");
  const controller = new Controller(options, { args: options.args }, true); let exitCode: number | undefined;
  controller.receive = frame => {
    if ((frame.type === "stdout" || frame.type === "stderr") && typeof frame.data === "string") (frame.type === "stdout" ? options.onStdout : options.onStderr)?.(Buffer.from(frame.data, "base64").toString("utf8"));
    else if (frame.type === "exit" && Number.isSafeInteger(frame.code)) { exitCode = frame.code as number; }
    else throw new Error("Invalid CLI guest event");
  };
  const cancel = () => controller.abort.abort(); options.signal?.addEventListener("abort", cancel, { once: true });
  try { if (options.signal?.aborted) cancel(); await controller.start(); controller.status("running"); const result = await controller.done!; return { ...result, exitCode: exitCode ?? result.exitCode }; }
  finally { options.signal?.removeEventListener("abort", cancel); }
}
