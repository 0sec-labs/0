import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { getScopeEnforcementState, runSmolvmWorkbench, ScopePolicy } from "@0/core";
import type { ConsoleSession, ConsoleSessionConfig, ConsoleSessionCheckpoint, ConsoleRenderCallbacks, SmolvmWorkbenchResult, SmolvmWorkbenchOptions } from "@0/core";
import { findingSchema, type Finding } from "@0/shared";
import type { WorkbenchConfig } from "./workbench.js";
import { encodeWorkbenchFrame, WorkbenchFrameReader, WORKBENCH_MAX_PENDING, guestWorkspacePath, hostWorkspacePath, mapWorkbenchTarget, mapWorkbenchCheckpoint, serializeWorkbenchConfig } from "./workbench-console-protocol.js";
import type { WorkbenchFrame } from "./workbench-console-protocol.js";

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
}
export interface WorkbenchConsoleSessionOptions extends WorkbenchControllerOptions {
  config: Omit<ConsoleSessionConfig, "runtime" | "db">;
  onFindings?: (findings: Finding[]) => void | Promise<void>;
}
const EVENTS = new Set(["onHarnessUpdate", "onAssistantDelta", "onReasoningDelta", "onToolStart", "onToolResult", "onUsage", "onNotice", "onCompaction"]);
const DECISIONS = new Set(["requestScope", "requestLocalScope", "approveTool", "escalateScopedAudit", "askOperator", "historyList", "historyRead"]);
function validateOptions(options: WorkbenchControllerOptions): void {
  if (options.provider.provider !== "chatgpt-codex" || (options.selection.provider && options.selection.provider !== "chatgpt-codex") || !options.provider.models.includes(options.selection.model)) throw new Error("Workbench requires an explicit host provider/model grant");
  for (const model of Object.values(options.selection.agentModels ?? {})) if (!options.provider.models.includes(model)) throw new Error("Workbench worker model is outside the host provider grant");
  for (const [name, value, max] of [["lifetimeMs", options.lifetimeMs ?? 30 * 60_000, 60 * 60_000], ["idleMs", options.idleMs ?? 5 * 60_000, 15 * 60_000]] as const) if (!Number.isSafeInteger(value) || value < 1000 || value > max) throw new Error(`Invalid workbench ${name}`);
}
function guestCommand(options: WorkbenchControllerOptions, cli: boolean): { command: readonly string[]; mounts?: SmolvmWorkbenchOptions["readOnlyMounts"] } {
  if (options.guestCommand) return { command: options.guestCommand };
  const entry = cli ? "run-agent" : "console-agent";
  if (!options.assets) return { command: ["/usr/local/bin/0", "--workbench-inner", "workbench", entry] };
  // Current compiled code is copied inside the guest; host asset grants remain read-only.
  const dependencies = options.assets.dependencies ? "/opt/0-controller-deps/node_modules" : "/opt/0/node_modules";
  const script = `const fs=require('node:fs');const path='/tmp/0-controller-cli';fs.cpSync('/opt/0-controller-cli',path,{recursive:true});fs.symlinkSync(${JSON.stringify(dependencies)},path+'/node_modules');process.argv=[process.execPath,path+'/0.js','--workbench-inner','workbench',${JSON.stringify(entry)}];import(path+'/0.js').catch(e=>{console.error(e.message);process.exitCode=1});`;
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
    if (this.started) return this.ready; this.started = true; this.status("pending", "Starting isolated workbench");
    this.lifetime = setTimeout(() => this.abort.abort(new Error("Workbench lifetime expired")), this.options.lifetimeMs ?? 30 * 60_000); this.lifetime.unref();
    try {
      const root = join(this.options.workbench.stateRoot, "controller-results"); await mkdir(root, { recursive: true, mode: 0o700 });
      const artifacts = this.options.artifactDirectory ?? await realpath(await mkdtemp(join(root, "run-")));
      const reader = new WorkbenchFrameReader(); const launch = guestCommand(this.options, this.cli);
      this.done = runSmolvmWorkbench({ image: this.options.workbench.image, stateRoot: this.options.workbench.stateRoot, workspaceRoot: this.workspace,
        command: launch.command, environment: { ZERO_PROVIDER: "chatgpt-codex", ZERO_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" }, network: this.options.network,
        tty: false, cpus: this.options.workbench.cpus, memoryMb: this.options.workbench.memoryMb, storageGb: this.options.workbench.storageGb,
        approvedImages: this.options.workbench.approvedImages, signal: this.abort.signal, workspaceMode: "snapshot", artifactDirectory: artifacts,
        readOnlyMounts: launch.mounts, transport: { initialInput: encodeWorkbenchFrame({ type: "init", ...this.init, selection: { ...this.options.selection, provider: "chatgpt-codex" } }), onReady: input => { this.input = input; }, onStdout: data => reader.push(data, frame => this.dispatch(frame)), onStderr: () => {} },
      });
      void this.done.then(async result => {
        const error = new Error(result.error ?? "Workbench VM exited");
        if (!this.guestReady) this.rejectReady(error);
        for (const pending of this.pending.values()) pending.reject(error); this.pending.clear();
        clearTimeout(this.idle); clearTimeout(this.lifetime);
        for (const pending of this.providers.values()) pending.abort(); this.providers.clear();
        await this.options.provider.close?.();
        this.status(result.cleanupFailed || (result.exitCode !== 0 && !this.abort.signal.aborted) ? "failed" : "stopped", result.error);
      });
      this.touch(); await this.ready;
    } catch (error) { this.abort.abort(); this.rejectReady(error instanceof Error ? error : new Error("Workbench startup failed")); this.status("failed", error instanceof Error ? error.message : "Workbench startup failed"); throw error; }
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
      if (frame.type === "error") { const error = new Error(typeof frame.error === "string" ? frame.error : "Guest operation failed"); if (!this.guestReady) this.rejectReady(error); pending?.reject(error); }
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
  async close(): Promise<void> {
    if (!this.started) return;
    let exited = false;
    try {
      await Promise.race([this.request("close"), new Promise(resolve => setTimeout(resolve, 1000))]);
      await Promise.race([this.done?.then(() => { exited = true; }), new Promise(resolve => setTimeout(resolve, 1000))]);
    } catch { /* A terminated guest still requires native teardown confirmation. */ }
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
  const scopeEnforcement = getScopeEnforcementState(workspace);
  const controller = new Controller({ ...options, workbench: { ...options.workbench, workspaceRoot: workspace } }, { config: serial, callbacks, scopeEnforcement }, false);
  let messages = structuredClone(config.initialMessages ?? config.initialCheckpoint?.messages ?? []);
  let checkpoint = config.initialCheckpoint;
  let target = config.target ?? ""; let scope = config.scope; let localScopePath = config.initialCheckpoint?.localScopePath ?? undefined;
  let autonomyMode = config.autonomyMode ?? "standard";
  let systemPrompt = config.systemPrompt ?? ""; let tools = config.tools ?? [];
  let render: ConsoleRenderCallbacks | undefined; let active = false; let findings: Finding[] = [];
  const deferred: Promise<unknown>[] = [];
  const queue = (op: string, value?: unknown) => { if (!controller.done) { serial[op === "autonomy" ? "autonomyMode" : op] = value; return; } const pending = controller.request(op, { value }); deferred.push(pending); void pending.catch(() => {}); };
  controller.decision = async (name, args) => {
    if (name === "historyList") return config.conversationHistory!.list(...args as Parameters<NonNullable<ConsoleSessionConfig["conversationHistory"]>["list"]>);
    if (name === "historyRead") return config.conversationHistory!.read(...args as Parameters<NonNullable<ConsoleSessionConfig["conversationHistory"]>["read"]>);
    const callback = (config as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name];
    if (!callback || !callbacks.includes(name)) return null;
    if (name === "requestLocalScope") {
      const request = structuredClone(args[0]) as Record<string, unknown>;
      for (const key of ["requestedPath", "currentScopePath"]) if (typeof request[key] === "string") request[key] = hostWorkspacePath(request[key] as string, workspace);
      const value = await callback(request); if (!value) return null; const resolution = value as { scopePath: string }; return { scopePath: guestWorkspacePath(resolution.scopePath, workspace) };
    }
    if (name === "requestScope") {
      const request = args[0] as Record<string, unknown>;
      const value = await callback({ ...request, target: mapWorkbenchTarget(String(request.target ?? ""), workspace, true), ...(request.currentScope ? { currentScope: new ScopePolicy((request.currentScope as { raw: ConstructorParameters<typeof ScopePolicy>[0] }).raw) } : {}) });
      if (!value) return null; const resolution = value as { target: string; scope: ScopePolicy }; return { target: mapWorkbenchTarget(resolution.target, workspace), scope: resolution.scope.raw };
    }
    return callback(...args);
  };
  controller.receive = frame => {
    if (frame.type === "state") {
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
    setAutonomyMode(mode) { autonomyMode = mode; queue("autonomy", mode); },
    configureEngagement(selection) { if (selection.target !== undefined) target = selection.target; if (selection.scope !== undefined) scope = selection.scope ?? undefined;
      const value = { ...(selection.target === undefined ? {} : { target: mapWorkbenchTarget(selection.target, workspace) }), ...(selection.scope === undefined ? {} : { scope: selection.scope?.raw ?? null }) };
      if (!controller.done) Object.assign(serial, value); else queue("configure", value); },
    reconfigureRuntime(selection) { if (selection.env !== undefined || (selection.provider && selection.provider !== "chatgpt-codex") || (selection.model && !options.provider.models.includes(selection.model)) || Object.values(selection.agentModels ?? {}).some(model => !options.provider.models.includes(model))) throw new Error("Runtime selection is outside workbench provider grant");
      Object.assign(options.selection, selection); if (controller.done) queue("reconfigure", selection); },
    clearConversation() { messages = []; checkpoint = undefined; if (!controller.done) { serial.initialMessages = []; delete serial.initialCheckpoint; } else queue("clear"); },
    async send(text, callbacks, sendOptions) {
      if (active) throw new Error("Workbench turn already active"); active = true; render = callbacks;
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => { try { controller.write({ type: "cancel" }); } catch { /* May still be booting. */ } cancelTimer = setTimeout(() => controller.abort.abort(new Error("Operator cancelled workbench turn")), 2000); };
      sendOptions?.signal?.addEventListener("abort", cancel, { once: true });
      try { await Promise.all(deferred.splice(0)); await controller.start(); if (sendOptions?.signal?.aborted) cancel(); controller.status("running");
        return await controller.request("send", { text, generateTitle: sendOptions?.generateTitle }) as Awaited<ReturnType<ConsoleSession["send"]>>;
      } finally { clearTimeout(cancelTimer); active = false; render = undefined; sendOptions?.signal?.removeEventListener("abort", cancel); if (!controller.abort.signal.aborted && controller.execution.status !== "stopped" && controller.execution.status !== "failed") controller.status("ready"); }
    },
    async stopPersistentAgent(agentId) { return await controller.request("stopWorker", { agentId }) as boolean; }, async stopPersistentAgents() { if (controller.done) await controller.request("stopWorkers"); },
    exportCheckpoint() { if (active || !checkpoint) throw new Error("No quiescent VM checkpoint is available"); return structuredClone(checkpoint); },
    async prepareHandoff() { if (active) throw new Error("Cannot hand off active VM turn"); if (!controller.done) return {}; return await controller.request("handoff") as { warnings?: string[] }; },
    async cleanup() { await controller.close(); await options.onFindings?.(findings); },
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
