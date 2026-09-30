import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createConsoleRuntime, isAdmittedSmolvmWorkbench, ScopePolicy, withScopeEnforcement } from "@0/core";
import type { ConsoleSession, ConsoleSessionConfig, ScopeEnforcementState } from "@0/core";
import { osecDB } from "@0/db";
import { findingFromRow } from "./tui/findings-data.js";
import { normalizeSettings } from "./tui/settings.js";
import { createLocalConsoleSession } from "./console-session.js";
import { encodeWorkbenchFrame, WorkbenchFrameReader, WORKBENCH_MAX_PENDING, WORKBENCH_FRAME_BYTES } from "./workbench-console-protocol.js";
import type { WorkbenchFrame } from "./workbench-console-protocol.js";

const CALLBACKS = ["requestScope", "requestLocalScope", "approveTool", "escalateScopedAudit", "askOperator"] as const;
const EVENTS = ["onHarnessUpdate", "onAssistantDelta", "onReasoningDelta", "onToolStart", "onToolResult", "onUsage", "onNotice", "onCompaction"] as const;

/**
 * Only the admitted VM entrypoint can create an engine or local provider listener.
 * Parent-turn callbacks cross this transport. Persistent worker bus/roster events
 * remain guest-local and their host UI presentation is not qualified yet; owned
 * worker cancellation and final persistence still run before guest teardown.
 */
async function runGuest(cli: boolean): Promise<number> {
  if (!isAdmittedSmolvmWorkbench()) throw new Error("Workbench controller requires admitted Linux VM execution");
  const emit = (frame: WorkbenchFrame) => { if (!process.stdout.write(encodeWorkbenchFrame(frame))) process.stdin.pause(); };
  process.stdout.on("drain", () => process.stdin.resume());
  let session: ConsoleSession | undefined;
  let initialized = false;
  let closing = false;
  let turn: AbortController | undefined;
  const decisions = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const providers = new Map<string, import("node:http").ServerResponse>();
  let policy: ScopeEnforcementState;
  const callback = (name: string, args: unknown[]): Promise<unknown> => {
    if (decisions.size >= WORKBENCH_MAX_PENDING) return Promise.reject(new Error("Workbench decision limit reached"));
    const id = randomUUID();
    emit({ type: "decision", id, name, args });
    return new Promise((resolve, reject) => decisions.set(id, { resolve, reject }));
  };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/provider/request" || providers.size >= 4) { response.writeHead(403).end(); return; }
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > WORKBENCH_FRAME_BYTES / 2) throw new Error("Provider request too large"); chunks.push(chunk); }
      const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("Invalid provider request");
      const id = randomUUID(); providers.set(id, response);
      response.once("close", () => { if (providers.delete(id)) emit({ type: "provider-cancel", id }); });
      emit({ type: "provider", id, envelope });
    } catch { response.writeHead(400).end("Invalid provider request"); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider listener unavailable");
  process.env.ZERO_WORKBENCH_PROVIDER_PROXY = `http://127.0.0.1:${address.port}/provider/request`;
  const state = async () => {
    if (!session) return;
    let checkpoint;
    try { checkpoint = session.exportCheckpoint(); } catch { /* Active workers prevent safe handoff. */ }
    const snapshot = { scanId: session.scanId, systemPrompt: session.systemPrompt, tools: session.tools, messages: session.messages,
      autonomyMode: session.autonomyMode, target: session.target, scope: session.scope?.raw, localScopePath: session.localScopePath, checkpoint };
    await mkdir("/home/zero/.0/controller", { recursive: true, mode: 0o700 });
    await writeFile("/home/zero/.0/controller/session.json", JSON.stringify(snapshot), { mode: 0o600 });
    emit({ type: "state", snapshot: checkpoint?.harnessRoot ? { ...snapshot, checkpoint: undefined } : snapshot });
    const db = new osecDB("/home/zero/.0/controller.sqlite");
    try { const rows = db.getFindings(session.scanId); if (rows.length > 1000) throw new Error("Finding export limit reached"); emit({ type: "findings", findings: rows.map(findingFromRow) }); } finally { db.close(); }
  };
  const finish = async () => {
    if (closing) return; closing = true; turn?.abort();
    for (const pending of decisions.values()) pending.reject(new Error("Workbench closed")); decisions.clear();
    for (const response of providers.values()) response.destroy(); providers.clear();
    if (session) { await session.stopPersistentAgents(); await state(); await session.cleanup(); }
    server.close(); process.stdin.destroy();
  };
  let chain = Promise.resolve();
  const receive = (frame: WorkbenchFrame) => {
    if (frame.type === "decision-result") { const pending = decisions.get(frame.id!); decisions.delete(frame.id!); if (frame.error) pending?.reject(new Error(String(frame.error))); else pending?.resolve(frame.value); return; }
    if (frame.type === "provider-headers") { const response = providers.get(frame.id!); if (!response || typeof frame.status !== "number" || frame.status < 100 || frame.status > 599) throw new Error("Invalid provider headers"); response.writeHead(frame.status, { "content-type": typeof frame.contentType === "string" ? frame.contentType : "text/event-stream" }); return; }
    if (frame.type === "provider-chunk") { const response = providers.get(frame.id!); if (!response || typeof frame.data !== "string" || frame.data.length > 131072) throw new Error("Invalid provider chunk"); if (response.writableLength > 4 * 1024 * 1024) throw new Error("Provider consumer exceeded buffer limit"); response.write(Buffer.from(frame.data, "base64")); return; }
    if (frame.type === "provider-end" || frame.type === "provider-error") { const response = providers.get(frame.id!); providers.delete(frame.id!); if (frame.type === "provider-error") response?.destroy(new Error("Host provider unavailable")); else response?.end(); return; }
    if (frame.type === "cancel") { turn?.abort(); return; }
    chain = chain.then(async () => {
      try {
        if (frame.type === "init") {
          if (initialized) throw new Error("Workbench already initialized"); initialized = true;
          if (frame.guestSettings) { const settings = normalizeSettings(frame.guestSettings);
            if (settings.executionProfile !== "local" || settings.updatePolicy !== "off") throw new Error("Invalid guest preferences");
            await mkdir("/home/zero/.0", { recursive: true, mode: 0o700 });
            await writeFile("/home/zero/.0/tui-settings.json", JSON.stringify(settings), { mode: 0o600, flag: "wx" });
          }
          const selection = frame.selection as Record<string, unknown>;
          if (!selection || selection.provider !== "chatgpt-codex" || typeof selection.model !== "string") throw new Error("Unsupported workbench provider");
          process.env.ZERO_PROVIDER = "chatgpt-codex"; process.env.ZERO_WORKBENCH_PROVIDER_MODEL = selection.model;
          if (cli) {
            if (!Array.isArray(frame.args) || frame.args.length > 512 || frame.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Invalid CLI argv");
            emit({ type: "ready", platform: process.platform, workspace: process.cwd() });
            const child = spawn(process.execPath, [process.argv[1]!, "--workbench-inner", ...frame.args as string[]], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
            child.stdout.on("data", data => emit({ type: "stdout", data: Buffer.from(data).toString("base64") }));
            child.stderr.on("data", data => emit({ type: "stderr", data: Buffer.from(data).toString("base64") }));
            child.once("error", async () => { emit({ type: "exit", code: 1 }); await finish(); });
            child.once("exit", async code => { emit({ type: "exit", code: code ?? 1 }); await finish(); });
            return;
          }
          const config = frame.config as Record<string, unknown>;
          const approvedPolicy = frame.scopeEnforcement as ScopeEnforcementState;
          if (!approvedPolicy || typeof approvedPolicy.enabled !== "boolean" || typeof approvedPolicy.pluginId !== "string") throw new Error("Missing scope approval snapshot");
          policy = { ...approvedPolicy, projectPath: "/workspace" };
          const callbacks: Record<string, unknown> = {};
          for (const name of CALLBACKS) if ((frame.callbacks as string[]).includes(name)) callbacks[name] = async (...args: unknown[]) => {
            const value = await callback(name, args);
            if (name === "requestScope" && value && typeof value === "object") { const resolution = value as { target: string; scope: ConstructorParameters<typeof ScopePolicy>[0] }; return { ...resolution, scope: new ScopePolicy(resolution.scope) }; }
            return value;
          };
          if ((frame.callbacks as string[]).includes("historyList")) callbacks.conversationHistory = { list: (...args: unknown[]) => callback("historyList", args), read: (...args: unknown[]) => callback("historyRead", args) };
          session = withScopeEnforcement(policy, () => createLocalConsoleSession({ ...config, ...callbacks,
            ...(config.scope ? { scope: new ScopePolicy(config.scope as ConstructorParameters<typeof ScopePolicy>[0]) } : {}),
            runtime: createConsoleRuntime({ ...selection, env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) }), workspaceRoot: "/workspace",
          } as unknown as Omit<ConsoleSessionConfig, "db">, "/home/zero/.0/controller.sqlite"));
          await session.ready; await state(); emit({ type: "ready", platform: process.platform, workspace: process.cwd() }); return;
        }
        if (!session || closing || frame.type !== "request" || typeof frame.op !== "string") throw new Error("Invalid controller request");
        let value: unknown;
        switch (frame.op) {
          case "send": {
            if (typeof frame.text !== "string") throw new Error("Invalid operator message"); turn = new AbortController();
            const callbacks = Object.fromEntries(EVENTS.map(name => [name, (...args: unknown[]) => emit({ type: "event", name, args })]));
            const result = withScopeEnforcement(policy, () => session!.send(frame.text as string, callbacks, { signal: turn!.signal, generateTitle: frame.generateTitle === true })); await state(); value = await result; turn = undefined; break;
          }
          case "autonomy": session.setAutonomyMode(frame.value as Parameters<ConsoleSession["setAutonomyMode"]>[0]); break;
          case "configure": { const value = frame.value as { target?: string; scope?: ConstructorParameters<typeof ScopePolicy>[0] | null }; session.configureEngagement({ target: value.target, ...(value.scope === undefined ? {} : { scope: value.scope ? new ScopePolicy(value.scope) : null }) }); break; }
          case "clear": session.clearConversation(); break;
          case "reconfigure": { const value = frame.value as Record<string, unknown>; if (value.env !== undefined || (value.provider !== undefined && value.provider !== "chatgpt-codex")) throw new Error("Unsupported runtime configuration"); session.reconfigureRuntime(value); break; }
          case "stopWorker": value = await session.stopPersistentAgent(String(frame.agentId)); break;
          case "stopWorkers": await session.stopPersistentAgents(); break;
          case "handoff": value = await session.prepareHandoff(); break;
          case "close": await finish(); emit({ type: "result", id: frame.id }); return;
          default: throw new Error("Unsupported controller operation");
        }
        await state(); emit({ type: "result", id: frame.id, value });
      } catch (error) { emit({ type: "error", id: frame.id, error: error instanceof Error ? error.message : "Guest operation failed" }); }
    });
  };
  const reader = new WorkbenchFrameReader();
  process.stdin.setEncoding("utf8"); process.stdin.on("data", (data: string) => { try { reader.push(data, receive); } catch { void finish(); } });
  process.stdin.once("end", () => { void finish(); });
  await new Promise<void>(resolve => process.stdin.once("close", resolve));
  await chain; return 0;
}
async function completeGuest(cli: boolean): Promise<number> {
  const code = await runGuest(cli);
  await new Promise<void>(resolve => { process.stdout.write("", () => resolve()); });
  // This admitted, dedicated entry owns the process; imported engine timers must not outlive it.
  process.exit(code);
}
export function runWorkbenchConsoleGuest(): Promise<number> { return completeGuest(false); }
export function runWorkbenchCliGuest(): Promise<number> { return completeGuest(true); }
