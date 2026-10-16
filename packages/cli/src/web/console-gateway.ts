import { loadServicePluginConnections } from "./service-plugins.js";
import { matchChat, searchSavedChats, type ChatSearchResult } from "./chat-search.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SecurityWorkflowStore, type LearningStore } from "@0/db";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ScopePolicy, clampOutboundBody, connectMcpServers, connectServicePlugins, eventBus, getScopeEnforcementState, isDangerousLocalRoot, normalizeScopeHostname, parseMcpConfig, sendOperatorMessage,
  type AgentSkillDiscoveryOptions, type ConsoleSession, type ConsoleSessionConfig, type ConsoleSessionCheckpoint, type ConsoleScopeRequest,
  type ConsoleTurnOutcome as EngineTurnOutcome, type LlmApiRuntime, type NativeMessage, type NativeRuntime,
  type McpHost, type OperatorQuestionAnswer, type OperatorQuestionRequest, type ScopeJson, type ToolCall,
} from "@0/core";
import {
  SecurityWorkflowBindingsSchema,
  DEFAULT_AUTONOMY_MODE, DESKTOP_CONSOLE_SCHEMA_VERSION, MODEL_PRICING, estimateCost,
  type ConsoleEventsPage, type ConsoleJsonValue, type ConsoleMessageInput, type ConsolePublicExport,
  type ConsolePublicMessage, type ConsoleQueuedMessage, type ConsoleMessageAuthor, type ConsoleUserAttribution, type ConsoleRuntimeSelection, type ConsoleRuntimeSnapshot,
  type ConsoleSavedSession, type ConsoleSessionConfiguration, type ConsoleSessionSnapshot,
  type ConsoleTodos, type ConsoleExecutionSnapshot, type ConsoleTurnOutcome, type ConsoleWorker, type DesktopConsoleAutonomyMode,
  type DesktopConsoleDecision, type DesktopConsoleDecisionResponse, type DesktopConsoleEvent,
  type DesktopConsoleEventPayload, type DesktopConsoleOperatorAnswer, type DesktopConsoleRole,
  type DesktopConsoleSession, type DesktopConsoleSessionStatus, type DesktopConsoleToolCall, type Finding, type HarnessSnapshot, type HarnessUiEvent,
} from "@0/shared";
import { createLocalConsoleSession } from "../console-session.js";
import { consoleExecutionProfile } from "../console-execution.js";
import { buildFindingChatPrompt, loadFindingFocus, resolveFindingChatIntent } from "../finding-focus.js";
import { exportChatConversation } from "../tui/chat-export.js";
import { getSettings } from "../tui/settings-store.js";
import type { TuiSettings } from "../tui/settings.js";
import { deleteSession, isValidSessionId, listSessions, loadSession, saveSession, setSessionArchived, type StoredConsoleState, type StoredSession } from "../tui/session-store.js";
import { applyWebConsoleRuntimeSelection, reloadWebConsoleRuntimeConnection, createWebConsoleRuntime, describeWebConsoleRuntime, savedWebRuntimeSelection, flushWebConsolePlugins, getWebConsolePluginHostManager } from "./operator-services.js";

const MAX_EVENTS = 2_000;
const MAX_MESSAGE_LENGTH = 1_000_000;
const MAX_TARGET_LENGTH = 4_096;
const MAX_OPERATOR_TEXT_LENGTH = 8_000;
const MAX_QUEUED_MESSAGES = 20;
const ROLES: Record<string, true> = { discovery: true, attack: true, verify: true, report: true, audit: true, review: true };
const MODES: Record<string, true> = { standard: true, recon: true, copilot: true, yolo: true };
const ACTIVE_WORKERS: Record<string, true> = { queued: true, running: true, parked: true };

export class ConsoleGatewayError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); this.name = "ConsoleGatewayError"; }
}

export type ConsoleGatewaySessionFactoryInput = Omit<ConsoleSessionConfig, "db" | "runtime"> & { runtime?: NativeRuntime; scanId: string; target: string; role: DesktopConsoleRole; autonomyMode: DesktopConsoleAutonomyMode };
export interface ConsoleWorkflowLifecycleAdapter {
  invoke(sessionId: string, name: string, args: Record<string, unknown>, capabilities?: { allowApply?: boolean }): unknown | Promise<unknown>;
}
const workflowLaunchSchema = z.object({
  templateId: z.string().trim().min(1).max(160).optional(), workflowId: z.string().trim().min(1).max(160).optional(),
  revision: z.number().int().positive().optional(), target: z.string().trim().min(1).max(4096),
  inputs: SecurityWorkflowBindingsSchema.optional(), allowApply: z.boolean().optional(),
  timeCapMs: z.number().int().positive().max(86_400_000).optional(), costCapUsd: z.number().positive().max(1000).optional(),
  idempotencyKey: z.string().trim().min(1).max(160).optional(),
}).strict();
type QueuedWorkflowRequest = {
  id: string; epoch: number; turnOwner?: string; request: z.infer<typeof workflowLaunchSchema>; abort: AbortController;
  status: "queued" | "awaiting-approval" | "starting" | "launched" | "failed" | "cancelled"; runId?: string; error?: string;
};
export interface ConsoleGatewayOptions {
  createSession?: (input: ConsoleGatewaySessionFactoryInput) => ConsoleSession | Promise<ConsoleSession>;
  now?: () => Date;
  createId?: () => string;
  dbPath?: string;
  homeDir?: string;
  projectPath?: string;
  skillDiscoveryOptions?: (workspaceRoot: string) => AgentSkillDiscoveryOptions;
  skillAuthoring?: (author: ConsoleMessageAuthor | undefined, workspaceRoot: string) => NonNullable<ConsoleSessionConfig["skillAuthoring"]>;
}
export interface ConsoleExecutionContext {
  runtime: NativeRuntime;
  model: string;
  providerId: string;
  agentModels: Record<string, string>;
  singleModel: boolean;
  autoRoute: boolean;
  target: string;
  scope?: ScopePolicy;
  scopeEnforcement: ConsoleSession["scopeEnforcement"];
  localScopePath?: string;
  status: DesktopConsoleSessionStatus;
  role: DesktopConsoleRole;
  autonomyMode: DesktopConsoleAutonomyMode;
  settings: TuiSettings;
  dbPath?: string;
  /** Server-only, current denial memory; never restored from saved messages. */
  authorization: Pick<ConsoleSessionCheckpoint, "deniedHosts" | "deniedLocalPaths"> & { scopedAuditGrants: string[]; scopedAuditDenials: string[] };
}

type PendingDecision = { decision: DesktopConsoleDecision; resolve: (response: DesktopConsoleDecisionResponse) => void; validate?: (response: DesktopConsoleDecisionResponse) => boolean };
type ManagedSession = {
  id: string; createdAt: string; updatedAt: string; role: DesktopConsoleRole; target: string;
  autonomyMode: DesktopConsoleAutonomyMode; title: string; scope?: ScopePolicy; selection: ConsoleRuntimeSelection;
  runtime: LlmApiRuntime | null; info: ConsoleRuntimeSnapshot | null; session: ConsoleSession | null;
  initialization: Promise<ConsoleSession> | null; status: DesktopConsoleSessionStatus; sequence: number;
  events: DesktopConsoleEvent[]; listeners: Set<(event: DesktopConsoleEvent) => void>;
  pending: Map<string, PendingDecision>; abort: AbortController | null; turn: Promise<void> | null; turnOwner: string | null;
  initialMessages: NativeMessage[]; savedId?: string; workers: Map<string, ConsoleWorker>; ownedIds: Set<string>;
  userAttributions: ConsoleUserAttribution[];
  busUnsubscribe: (() => void) | null; messagingHome?: string; queued: ConsoleQueuedMessage[]; pauseQueue: boolean;
  pendingConfiguration?: ConsoleSessionConfiguration; configuration: Promise<void> | null;
  usage: ConsoleSessionSnapshot["usage"]; contextInputTokens?: number;
  lastOutcome: ConsoleTurnOutcome | null; compaction: ConsoleJsonValue | null; harness: HarnessSnapshot | null;
  objective: string; todos: ConsoleTodos | null; focusedFinding?: Finding; stagedPrompt?: string;
  workflowRequests: Map<string, QueuedWorkflowRequest>; workflowDraining: boolean;
  executionEpoch: number; execution: ConsoleExecutionSnapshot; workspacePath?: string;
};

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!record(value)) throw new ConsoleGatewayError(`${label} must be an object.`, 400);
  return value;
}
function allowedKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new ConsoleGatewayError("Unsupported input field.", 400);
}
function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== "string") throw new ConsoleGatewayError(`${label} must be a string.`, 400);
  const result = value.trim();
  if ((!empty && !result) || result.length > max || result.includes("\u0000")) throw new ConsoleGatewayError(`${label} ${!result ? "cannot be empty" : `must be at most ${max} characters and contain no NUL`}.`, 400);
  return result;
}
function mode(value: unknown): DesktopConsoleAutonomyMode {
  if (typeof value !== "string" || !Object.hasOwn(MODES, value)) throw new ConsoleGatewayError("Unsupported autonomy mode.", 400);
  return value as DesktopConsoleAutonomyMode;
}
function role(value: unknown): DesktopConsoleRole {
  if (typeof value !== "string" || !Object.hasOwn(ROLES, value)) throw new ConsoleGatewayError("Unsupported console role.", 400);
  return value as DesktopConsoleRole;
}
function runtimeSelection(value: unknown): ConsoleRuntimeSelection {
  const raw = object(value, "Runtime selection");
  allowedKeys(raw, ["providerId", "model", "agentModels", "singleModel", "autoRoute", "reasoningEffort"]);
  const result: ConsoleRuntimeSelection = {};
  for (const key of ["providerId", "model", "reasoningEffort"] as const) if (raw[key] !== undefined) result[key] = text(raw[key], key, 256);
  for (const key of ["singleModel", "autoRoute"] as const) if (raw[key] !== undefined) {
    if (typeof raw[key] !== "boolean") throw new ConsoleGatewayError(`${key} must be a boolean.`, 400);
    result[key] = raw[key];
  }
  if (raw.agentModels !== undefined) {
    const models = object(raw.agentModels, "Role models");
    if (Object.keys(models).length > 32) throw new ConsoleGatewayError("Too many role model overrides.", 400);
    result.agentModels = Object.fromEntries(Object.entries(models).map(([key, value]) => [text(key, "Role", 64), text(value, "Role model", 256)]));
  }
  return result;
}
function scopePolicy(value: unknown): ScopePolicy | undefined {
  if (value === null) return undefined;
  const raw = object(value, "Scope");
  allowedKeys(raw, ["in_scope", "out_of_scope", "attribution"]);
  const scope: ScopeJson = {};
  for (const key of ["in_scope", "out_of_scope"] as const) if (raw[key] !== undefined) {
    const rules = raw[key];
    if (!Array.isArray(rules) || rules.length > 1_000) throw new ConsoleGatewayError("Scope rules must be an array of at most 1,000 strings.", 400);
    scope[key] = rules.map((value) => text(value, "Scope rule", 4_096));
  }
  if (raw.attribution !== undefined) {
    const attribution = object(raw.attribution, "Attribution");
    allowedKeys(attribution, ["headers", "user_agent_token"]);
    scope.attribution = {};
    if (attribution.user_agent_token !== undefined) scope.attribution.user_agent_token = text(attribution.user_agent_token, "Attribution token", 1_024);
    if (attribution.headers !== undefined) {
      const headers = object(attribution.headers, "Attribution headers");
      if (Object.keys(headers).length > 32) throw new ConsoleGatewayError("Too many attribution headers.", 400);
      scope.attribution.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof value !== "string" || /[\r\n]/.test(value)) throw new ConsoleGatewayError("Invalid attribution header.", 400);
        return [key, text(value, "Header", 4_096)];
      }));
    }
  }
  try { return ScopePolicy.fromJson(scope); } catch (error) { throw new ConsoleGatewayError(errorMessage(error), 400); }
}
function configuration(value: unknown): ConsoleSessionConfiguration {
  const raw = object(value, "Configuration");
  allowedKeys(raw, ["title", "target", "autonomyMode", "scope", "runtime", "workspacePath"]);
  const result: ConsoleSessionConfiguration = {};
  if (raw.workspacePath !== undefined) result.workspacePath = text(raw.workspacePath, "Workspace folder", MAX_TARGET_LENGTH);
  if (raw.title !== undefined) result.title = text(raw.title, "Title", 200);
  if (raw.target !== undefined) result.target = text(raw.target, "Target", MAX_TARGET_LENGTH, true);
  if (raw.autonomyMode !== undefined) result.autonomyMode = mode(raw.autonomyMode);
  if (raw.scope !== undefined) result.scope = scopePolicy(raw.scope)?.raw ?? null;
  if (raw.runtime !== undefined) result.runtime = runtimeSelection(raw.runtime);
  return result;
}
function json(value: unknown, ancestors = new Set<object>()): ConsoleJsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || ancestors.has(value)) return null;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => json(entry, ancestors));
    return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== "function" && typeof item !== "symbol" && item !== undefined).map(([key, item]) => [key, json(item, ancestors)]));
  } finally { ancestors.delete(value); }
}
function publicMessages(messages: readonly unknown[]): ConsolePublicMessage[] {
  return messages.flatMap((value) => {
    if (!record(value) || (value.role !== "user" && value.role !== "assistant")) return [];
    const blocks = typeof value.content === "string" ? [{ type: "text", text: value.content }] : Array.isArray(value.content) ? value.content : [];
    const content: ConsolePublicMessage["content"] = blocks.flatMap((block): ConsolePublicMessage["content"] => {
      if (!record(block)) return [];
      if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string" && record(block.input)) return [{ type: "tool_use", id: block.id, name: block.name, input: json(block.input) as Record<string, ConsoleJsonValue> }];
      if (block.type === "tool_result" && typeof block.tool_use_id === "string" && typeof block.content === "string") return [{ type: "tool_result", tool_use_id: block.tool_use_id, content: block.content, ...(typeof block.is_error === "boolean" ? { is_error: block.is_error } : {}) }];
      return [];
    });
    return content.length ? [{ role: value.role, content }] : [];
  });
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
const serverAuthorSchema = z.object({ userId: z.string().min(1).max(256), displayName: z.string().min(1).max(256), proposalId: z.string().min(1).max(256).optional() });
/** Match backwards so repeated prompts, including anonymous turns, retain their own author. */
function attributedMessages(messages: readonly unknown[], attributions: readonly ConsoleUserAttribution[]): ConsolePublicMessage[] {
  const projected = publicMessages(messages);
  let before = projected.length;
  for (let index = attributions.length - 1; index >= 0; index--) {
    const attribution = attributions[index]!;
    for (let candidate = before - 1; candidate >= 0; candidate--) {
      const message = projected[candidate]!;
      const blocks = message.content.filter(block => block.type === "text");
      if (message.role === "user" && blocks.length && blocks.map(block => block.text).join("") === attribution.text) {
        if (attribution.author) message.author = structuredClone(attribution.author);
        before = candidate; break;
      }
    }
  }
  return projected;
}
function parseDecisionResponse(value: unknown): DesktopConsoleDecisionResponse {
  const raw = object(value, "Decision response"); allowedKeys(raw, ["approve", "answers"]);
  if (typeof raw.approve !== "boolean") throw new ConsoleGatewayError("Decision response must include an approve boolean.", 400);
  if (raw.answers === undefined) return { approve: raw.approve };
  if (!Array.isArray(raw.answers) || raw.answers.length > 32) throw new ConsoleGatewayError("Decision answers must be an array of at most 32 answers.", 400);
  const answers: DesktopConsoleOperatorAnswer[] = raw.answers.map((value) => {
    const answer = object(value, "Operator answer"); allowedKeys(answer, ["header", "selectedLabels", "customText"]);
    const header = text(answer.header, "Answer header", 200);
    if (answer.selectedLabels !== undefined && (!Array.isArray(answer.selectedLabels) || answer.selectedLabels.length > 100 || !answer.selectedLabels.every((value) => typeof value === "string" && value.length <= 1_024))) throw new ConsoleGatewayError("Selected operator labels must be bounded strings.", 400);
    return { header, ...(answer.selectedLabels !== undefined ? { selectedLabels: answer.selectedLabels as string[] } : {}), ...(answer.customText !== undefined ? { customText: text(answer.customText, "Operator text", MAX_OPERATOR_TEXT_LENGTH, true) } : {}) };
  });
  return { approve: raw.approve, answers };
}
function validOperatorAnswer(request: OperatorQuestionRequest, response: DesktopConsoleDecisionResponse): OperatorQuestionAnswer | null {
  if (!response.approve) return null;
  if (response.answers?.length !== request.questions.length) return null;
  const byHeader = new Map(response.answers.map((answer) => [answer.header, answer]));
  if (byHeader.size !== request.questions.length) return null;
  for (const question of request.questions) {
    const answer = byHeader.get(question.header); if (!answer) return null;
    const labels = answer.selectedLabels ?? [];
    const allowed = new Set(question.options?.map((option) => option.label) ?? []);
    if (new Set(labels).size !== labels.length || labels.some((label) => !allowed.has(label)) || (!question.multiSelect && labels.length > 1)) return null;
    if (answer.customText && question.options?.length && !question.allowCustom) return null;
    if (!labels.length && !answer.customText?.trim()) return null;
  }
  return { requestId: request.requestId, answers: response.answers };
}
function buildScopeResolution(request: ConsoleScopeRequest): { target: string; scope: ScopePolicy } | null {
  const raw = request.currentScope?.raw ?? {};
  const inScope = new Set(raw.in_scope ?? []);
  let target = request.target;
  for (const requestedUrl of request.requestedUrls) {
    try { const url = new URL(requestedUrl); inScope.add(url.hostname); target ||= url.origin; } catch { return null; }
  }
  const scope = ScopePolicy.fromJson({ ...raw, in_scope: [...inScope] });
  if (request.requestedUrls.some((url) => !scope.match(url).allowed)) return null;
  // Unresolved shell destinations authorize this exact call, not an invented host.
  if (!request.requestedUrls.length && !request.unresolvedTargets?.length) return null;
  return { target, scope };
}
function publicExport(messages: readonly unknown[]): ConsolePublicExport {
  const exported = exportChatConversation(messages);
  try { return { text: exported.text, messages: JSON.parse(readFileSync(exported.path, "utf8")) as ConsolePublicMessage[] }; }
  finally { rmSync(dirname(exported.path), { recursive: true, force: true }); }
}
function messageInput(value: unknown): ConsoleMessageInput {
  if (typeof value === "string") return { text: text(value, "Message", MAX_MESSAGE_LENGTH) };
  const raw = object(value, "Message"); allowedKeys(raw, ["text", "mode", "workerId", "attachments"]);
  const result: ConsoleMessageInput = { text: text(raw.text ?? "", "Message", MAX_MESSAGE_LENGTH, true) };
  if (raw.mode !== undefined) {
    if (raw.mode !== "send" && raw.mode !== "queue" && raw.mode !== "steer") throw new ConsoleGatewayError("Unsupported message mode.", 400);
    result.mode = raw.mode;
  }
  if (raw.workerId !== undefined) result.workerId = text(raw.workerId, "Worker ID", 256);
  if (raw.attachments !== undefined) {
    if (!Array.isArray(raw.attachments) || raw.attachments.length > 20) throw new ConsoleGatewayError("Attachments must be an array of at most 20 references.", 400);
    result.attachments = raw.attachments.map((value) => {
      const attachment = object(value, "Attachment"); allowedKeys(attachment, ["kind", "value"]);
      if (attachment.kind !== "path" && attachment.kind !== "text") throw new ConsoleGatewayError("Attachments support explicit local path or text references only.", 400);
      return { kind: attachment.kind, value: text(attachment.value, "Attachment reference", MAX_MESSAGE_LENGTH) };
    });
  }
  const expanded = [result.text, ...(result.attachments ?? []).map((item) => item.kind === "path" ? `Local path reference: ${item.value}` : item.value)].filter(Boolean).join("\n\n");
  result.text = text(expanded, "Message", MAX_MESSAGE_LENGTH);
  return result;
}

export class ConsoleGateway {
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #options: ConsoleGatewayOptions;
  readonly #skillActor = new AsyncLocalStorage<ConsoleMessageAuthor | undefined>();
  #workflowLifecycle?: ConsoleWorkflowLifecycleAdapter;
  #sourceLearningStore?: LearningStore;
  #learningRecorder?: (event: { id: string; project: string; outcome: string }) => void;
  readonly #callIds = new WeakMap<object, string>();
  constructor(options: ConsoleGatewayOptions = {}) { this.#options = options; this.#now = options.now ?? (() => new Date()); this.#createId = options.createId ?? randomUUID; }

  attachWorkflowLifecycle(adapter: ConsoleWorkflowLifecycleAdapter): void {
    if (this.#workflowLifecycle) throw new ConsoleGatewayError("Workflow lifecycle is already attached.", 409);
    this.#workflowLifecycle = adapter;
  }
  list(): DesktopConsoleSession[] { return [...this.#sessions.values()].map((managed) => this.#summary(managed)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  hasActiveTurns(): boolean {
    for (const managed of this.#sessions.values()) {
      if (managed.turn || managed.initialization || managed.workflowDraining) return true;
      for (const worker of managed.workers.values()) if (worker.status === "queued" || worker.status === "running") return true;
    }
    return false;
  }
  create(value: unknown = {}): DesktopConsoleSession {
    const created = this.#createRecord(value);
    this.#save(this.#require(created.id));
    return created;
  }
  #createRecord(value: unknown): DesktopConsoleSession {
    const raw = object(value, "Session"); allowedKeys(raw, ["target", "role", "autonomyMode", "title", "scope", "runtime", "findingId", "findingIntent"]);
    const id = this.#createId();
    if (!isValidSessionId(id) || this.#sessions.has(id)) throw new ConsoleGatewayError("Generated session ID is invalid or already in use.", 500);
    const now = this.#now().toISOString();
    let focusedFinding: Finding | undefined;
    let stagedPrompt: string | undefined;
    if (raw.findingId !== undefined) {
      try {
        const focus = loadFindingFocus(text(raw.findingId, "Finding ID", 256), { dbPath: this.#options.dbPath });
        const intent = resolveFindingChatIntent(raw.findingIntent === undefined ? undefined : text(raw.findingIntent, "Finding intent", 32));
        focusedFinding = focus.finding;
        stagedPrompt = buildFindingChatPrompt(focus, intent);
      } catch (error) { throw new ConsoleGatewayError(errorMessage(error), 400); }
    } else if (raw.findingIntent !== undefined) throw new ConsoleGatewayError("Finding intent requires a finding ID.", 400);
    const managed: ManagedSession = {
      id, createdAt: now, updatedAt: now, target: raw.target === undefined ? "" : text(raw.target, "Target", MAX_TARGET_LENGTH, true),
      role: raw.role === undefined ? "audit" : role(raw.role), autonomyMode: raw.autonomyMode === undefined ? DEFAULT_AUTONOMY_MODE : mode(raw.autonomyMode),
      title: raw.title === undefined ? "New chat" : text(raw.title, "Title", 200),
      scope: raw.scope === undefined ? undefined : scopePolicy(raw.scope), selection: raw.runtime === undefined ? {} : runtimeSelection(raw.runtime),
      runtime: null, info: null, session: null, initialization: null, status: "ready", sequence: 0, events: [], listeners: new Set(), pending: new Map(),
      abort: null, turn: null, turnOwner: null, initialMessages: [], userAttributions: [], workers: new Map(), ownedIds: new Set([id]), busUnsubscribe: null,
      queued: [], pauseQueue: false, configuration: null, usage: { inputTokens: 0, outputTokens: 0, costUnavailable: true }, lastOutcome: null, compaction: null, harness: null, objective: "", todos: null,
      workflowRequests: new Map(), workflowDraining: false,
      executionEpoch: 0, execution: { backend: consoleExecutionProfile(this.#options.homeDir), status: "pending", workspacePath: this.#projectPath },
      ...(focusedFinding ? { focusedFinding } : {}), ...(stagedPrompt ? { stagedPrompt } : {}),
    };
    this.#sessions.set(id, managed); this.#emitSession(managed); return this.#summary(managed);
  }
  get(id: string): ConsoleSessionSnapshot {
    const managed = this.#require(id); const session = managed.session;
    return {
      session: this.#summary(managed), title: managed.title, cursor: managed.sequence,
      messages: attributedMessages(session?.messages ?? managed.initialMessages, managed.userAttributions), events: structuredClone(managed.events),
      pendingDecisions: [...managed.pending.values()].map((pending) => structuredClone(pending.decision)),
      execution: structuredClone(managed.execution), workers: this.workers(id), queuedMessages: structuredClone(managed.queued), runtime: managed.info ? structuredClone(managed.info) : null,
      scope: structuredClone(session?.scope?.raw ?? managed.scope?.raw ?? null), scopeEnforcement: { ...(session?.scopeEnforcement ?? getScopeEnforcementState(this.#projectPath, this.#options.homeDir)) },
      workspacePath: managed.workspacePath ?? this.#projectPath,
      ...(session?.localScopePath ? { localScopePath: session.localScopePath } : {}), usage: { ...managed.usage },
      ...(managed.contextInputTokens !== undefined ? { contextInputTokens: managed.contextInputTokens } : {}),
      ...(managed.info?.contextWindowTokens != null ? { contextWindowTokens: managed.info.contextWindowTokens } : {}),
      lastOutcome: structuredClone(managed.lastOutcome), compaction: structuredClone(managed.compaction), harness: session?.harness?.snapshot() ?? structuredClone(managed.harness),
      objective: managed.objective, todos: structuredClone(managed.todos),
      tools: (session?.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: json({ type: "object", properties: tool.parameters, required: tool.required ?? [] }) })),
      ...(managed.pendingConfiguration ? { pendingConfiguration: structuredClone(managed.pendingConfiguration) } : {}),
      ...(managed.focusedFinding ? { focusedFinding: structuredClone(managed.focusedFinding) } : {}), ...(managed.stagedPrompt ? { stagedPrompt: managed.stagedPrompt } : {}),
    };
  }
  eventsAfter(id: string, after = 0): ConsoleEventsPage {
    const managed = this.#require(id);
    if (!Number.isSafeInteger(after) || after < 0) throw new ConsoleGatewayError("Event cursor must be a nonnegative safe integer.", 400);
    const gap = after > managed.sequence || after < (managed.events[0]?.sequence ?? managed.sequence + 1) - 1;
    return { events: structuredClone(managed.events.filter((event) => event.sequence > after)), cursor: managed.sequence, gap, ...(gap ? { snapshot: this.get(id) } : {}) };
  }
  subscribe(id: string, listener: (event: DesktopConsoleEvent) => void): () => void {
    const managed = this.#require(id); managed.listeners.add(listener); return () => managed.listeners.delete(listener);
  }
  async send(id: string, value: unknown, author?: ConsoleMessageAuthor): Promise<DesktopConsoleSession> {
    const managed = this.#requireOpen(id);
    if (managed.workflowDraining) throw new ConsoleGatewayError("Wait for the queued workflow launch and decisions to finish.", 409);
    const input = messageInput(value);
    const attribution = author === undefined ? undefined : serverAuthorSchema.parse(author);
    if (input.workerId) return this.sendWorker(id, input.workerId, input.text, attribution);
    if (managed.turn || managed.initialization || managed.configuration || managed.status === "working" || managed.pending.size) {
      if (input.mode !== "queue" && input.mode !== "steer") throw new ConsoleGatewayError("Console session is already processing a turn; choose queue or steer.", 409);
      if (managed.queued.length >= MAX_QUEUED_MESSAGES) throw new ConsoleGatewayError("The message queue is full.", 409);
      managed.queued.push({ id: this.#createId(), text: input.text, createdAt: this.#now().toISOString(), ...(attribution ? { author: attribution } : {}) }); managed.pauseQueue = false;
      this.#emit(managed, { type: "queued", messages: structuredClone(managed.queued) });
      if (input.mode === "steer" && managed.abort) this.#cancelTurn(managed);
      return this.#summary(managed);
    }
    await this.#startTurn(managed, input.text, attribution); return this.#summary(managed);
  }
  async cancel(id: string): Promise<DesktopConsoleSession> {
    const managed = this.#requireOpen(id);
    if (!managed.abort || !managed.turn) throw new ConsoleGatewayError("Console session has no active turn to cancel.", 409);
    managed.pauseQueue = true; this.#cancelTurn(managed); return this.#summary(managed);
  }
  removeQueued(id: string, value?: unknown): DesktopConsoleSession {
    const managed = this.#requireOpen(id);
    if (value === undefined) managed.queued = [];
    else {
      const messageId = text(value, "Queued message ID", 256);
      const index = managed.queued.findIndex((message) => message.id === messageId);
      if (index < 0) throw new ConsoleGatewayError("Queued message has already started or was removed.", 404);
      managed.queued.splice(index, 1);
    }
    this.#emit(managed, { type: "queued", messages: structuredClone(managed.queued) }); this.#save(managed);
    void this.#processIdleWork(managed);
    return this.#summary(managed);
  }
  resolveDecision(id: string, decisionId: string, raw: unknown): DesktopConsoleSession {
    const managed = this.#requireOpen(id); const pending = managed.pending.get(decisionId);
    if (!pending) throw new ConsoleGatewayError("Approval request is no longer pending.", 404);
    const response = parseDecisionResponse(raw);
    if (response.approve && pending.validate && !pending.validate(response)) throw new ConsoleGatewayError("The answer does not satisfy the pending request.", 400);
    managed.pending.delete(decisionId); pending.resolve(response);
    this.#emit(managed, { type: "decision-resolved", decisionId, approved: response.approve }); this.#refreshStatus(managed);
    void this.#processIdleWork(managed);
    return this.#summary(managed);
  }
  async clear(id: string): Promise<DesktopConsoleSession> {
    const managed = this.#requireOpen(id); this.#assertIdle(managed);
    managed.executionEpoch++;
    managed.session?.clearConversation(); managed.initialMessages = []; managed.userAttributions = []; managed.queued = []; managed.objective = ""; managed.todos = null;
    managed.lastOutcome = null; managed.compaction = null; managed.contextInputTokens = undefined;
    // clear is a conversation operation, not revocation of granted/denied authorization or worker cleanup.
    managed.events = []; this.#emit(managed, { type: "clear" }); this.#save(managed); this.#emitSession(managed); return this.#summary(managed);
  }
  async continue(id: string, value: unknown = {}, author?: ConsoleMessageAuthor): Promise<DesktopConsoleSession> {
    const managed = this.#requireOpen(id); this.#assertIdle(managed);
    if (managed.lastOutcome?.stopReason !== "output_cap") throw new ConsoleGatewayError("This session has no output-capped turn to continue.", 409);
    const raw = object(value, "Continuation"); allowedKeys(raw, ["text"]);
    const remaining = raw.text === undefined
      ? "Continue the remaining task from the retained observations and plan. Do not replay completed tool calls or incomplete function calls. Keep the next answer concise."
      : text(raw.text, "Remaining task", MAX_MESSAGE_LENGTH);
    return this.send(id, remaining, author);
  }
  async harness(id: string, value: unknown): Promise<{ snapshot: HarnessSnapshot; requestedPrompt?: string }> {
    const managed = this.#requireOpen(id); this.#assertIdle(managed);
    const raw = object(value, "Harness interaction"); allowedKeys(raw, ["generationId", "providerId", "event"]);
    const event = object(raw.event, "Harness event");
    const eventId = text(event.id, "Harness event ID", 200);
    let input: HarnessUiEvent;
    if (event.kind === "command") { allowedKeys(event, ["kind", "id"]); input = { kind: "command", id: eventId }; }
    else if (event.kind === "setting") {
      allowedKeys(event, ["kind", "id", "value"]);
      if (typeof event.value !== "boolean" && typeof event.value !== "string") throw new ConsoleGatewayError("Harness setting must be a boolean or string.", 400);
      input = { kind: "setting", id: eventId, value: typeof event.value === "string" ? text(event.value, "Harness setting value", 8_000, true) : event.value };
    } else throw new ConsoleGatewayError("Unsupported harness event.", 400);
    const session = await this.#ensureSession(managed);
    if (!session.harness) throw new ConsoleGatewayError("This session has no active harness.", 409);
    this.#assertIdle(managed);
    const operation = session.harness.interact({ generationId: text(raw.generationId, "Harness generation ID", 200), providerId: text(raw.providerId, "Harness provider ID", 200), event: input });
    managed.configuration = operation.then(() => undefined);
    try {
      const response = await operation;
      managed.harness = response.snapshot; this.#emit(managed, { type: "harness", harness: response.snapshot });
      return response;
    } catch (error) { throw new ConsoleGatewayError(errorMessage(error), 409); }
    finally { managed.configuration = null; }
  }
  async configure(id: string, value: unknown): Promise<DesktopConsoleSession> {
    const managed = this.#requireOpen(id); const input = configuration(value);
    if (input.workspacePath !== undefined) {
      this.#assertIdle(managed);
      if ([...managed.workers.values()].some(worker => Object.hasOwn(ACTIVE_WORKERS, worker.status))) throw new ConsoleGatewayError("Stop active agents before changing the workspace folder.", 409);
      let directory: string;
      try { directory = realpathSync(resolve(managed.workspacePath ?? this.#projectPath, input.workspacePath)); }
      catch { throw new ConsoleGatewayError("Choose an existing local folder.", 400); }
      if (!statSync(directory).isDirectory() || isDangerousLocalRoot(directory)) throw new ConsoleGatewayError("Choose a project folder, rather than a protected root or home directory.", 400);
      if (managed.session && managed.execution.backend === "smolvm" && directory !== (managed.execution.workspacePath ?? managed.workspacePath ?? this.#projectPath)) throw new ConsoleGatewayError("The SmolVM workspace grant is fixed for this chat. Start a new chat to select a different folder; this chat was not changed.", 409);
      input.workspacePath = directory;
    }
    if (input.runtime && managed.session && managed.execution.backend === "smolvm") {
      if (managed.turn || managed.initialization || managed.configuration || managed.pending.size || managed.session.messages.length) {
        throw new ConsoleGatewayError("The SmolVM model and account grant is fixed for this run. Start a new chat or resume saved work with the new model; this session was not changed.", 409);
      }
      await managed.session.cleanup(); managed.session = null; managed.runtime = null; managed.info = null;
      managed.selection = { ...managed.selection, ...input.runtime };
    }
    if (input.title !== undefined) managed.title = input.title;
    const execution = { ...input }; delete execution.title;
    // Local approval policy is mutable during a turn; runtime, scope and folder
    // changes still wait for the safe turn boundary. Guest requests are serialized.
    if (input.autonomyMode !== undefined && managed.execution.backend === "local" && !managed.initialization && !managed.configuration) {
      managed.session?.setAutonomyMode(input.autonomyMode);
      managed.autonomyMode = input.autonomyMode;
      delete execution.autonomyMode;
      if (managed.pendingConfiguration?.autonomyMode !== undefined) {
        delete managed.pendingConfiguration.autonomyMode;
        if (!Object.keys(managed.pendingConfiguration).length) managed.pendingConfiguration = undefined;
      }
    }
    if (!Object.keys(execution).length) { this.#emitSession(managed); this.#save(managed); return this.#summary(managed); }
    managed.executionEpoch++;
    managed.pendingConfiguration = { ...managed.pendingConfiguration, ...execution, ...(execution.runtime ? { runtime: { ...managed.pendingConfiguration?.runtime, ...execution.runtime } } : {}) };
    if (managed.turn || managed.initialization || managed.configuration || managed.pending.size) { this.#emitSession(managed); return this.#summary(managed); }
    if (input.workspacePath !== undefined) {
      void this.#applyPendingConfiguration(managed).catch(error => {
        managed.pendingConfiguration = undefined;
        this.#emit(managed, { type: "error", message: errorMessage(error) }); this.#refreshStatus(managed);
      }).finally(() => { void this.#processIdleWork(managed); });
      return this.#summary(managed);
    }
    await this.#applyPendingConfiguration(managed); return this.#summary(managed);
  }
  async reloadConnection(id: string): Promise<DesktopConsoleSession> {
    const managed = this.#requireOpen(id); this.#assertIdle(managed);
    if (managed.pendingConfiguration || managed.workflowDraining || [...managed.workflowRequests.values()].some(request => ["queued", "awaiting-approval", "starting"].includes(request.status)) || [...managed.workers.values()].some(worker => Object.hasOwn(ACTIVE_WORKERS, worker.status))) throw new ConsoleGatewayError("Finish active agents and queued configuration changes before reconnecting this conversation.", 409);
    if (managed.execution.backend === "smolvm" && managed.session) throw new ConsoleGatewayError("The SmolVM account grant is fixed for this run. Resume saved work in a new chat to use a reconnected account.", 409);
    const operation = (async () => {
      // A failed initialization has no runtime; ensureSession retries with fresh stored credentials.
      const hadRuntime = managed.runtime !== null;
      await this.#ensureSession(managed);
      if (hadRuntime && managed.runtime) {
        managed.info = await reloadWebConsoleRuntimeConnection(managed.runtime);
        managed.session?.reconfigureRuntime({ contextWindowTokens: managed.info.contextWindowTokens });
      }
      if (managed.status !== "closed") managed.status = "ready";
      this.#emitSession(managed); this.#save(managed);
    })();
    managed.configuration = operation;
    try { await operation; return this.#summary(managed); }
    finally { if (managed.configuration === operation) managed.configuration = null; }
  }
  async setRuntime(id: string, value: unknown): Promise<DesktopConsoleSession> { return this.configure(id, { runtime: value }); }
  async setAutonomy(id: string, value: unknown): Promise<DesktopConsoleSession> { return this.configure(id, { autonomyMode: value }); }
  async setTarget(id: string, value: unknown): Promise<DesktopConsoleSession> { return this.configure(id, { target: value }); }
  async setScope(id: string, value: unknown): Promise<DesktopConsoleSession> { return this.configure(id, { scope: value }); }
  save(id: string): ConsoleSavedSession {
    const managed = this.#require(id); if (!this.#save(managed)) throw new ConsoleGatewayError("The private transcript could not be saved.", 500);
    return this.loadSaved(managed.savedId ?? managed.id).meta;
  }
  async archive(id: string): Promise<ConsoleSavedSession> {
    const managed = this.#require(id);
    await this.close(id);
    return this.archiveSaved(managed.savedId ?? managed.id, { archived: true });
  }
  archiveSaved(id: string, value: unknown): ConsoleSavedSession {
    const raw = object(value, "Archive configuration"); allowedKeys(raw, ["archived"]);
    if (typeof raw.archived !== "boolean") throw new ConsoleGatewayError("archived must be a boolean.", 400);
    for (const managed of this.#sessions.values()) if (managed.status !== "closed" && (managed.id === id || managed.savedId === id)) throw new ConsoleGatewayError("Close the active chat before changing its saved archive state.", 409);
    this.#stored(id);
    if (!setSessionArchived(id, raw.archived, this.#options.homeDir)) throw new ConsoleGatewayError("The archive state could not be saved.", 500);
    return this.loadSaved(id).meta;
  }
  listSaved(value: unknown = {}): ConsoleSavedSession[] {
    const raw = object(value, "Saved session query"); allowedKeys(raw, ["cwd", "limit"]);
    if (raw.limit !== undefined && (!Number.isSafeInteger(raw.limit) || (raw.limit as number) < 1 || (raw.limit as number) > 1_000)) throw new ConsoleGatewayError("Saved session limit must be 1–1,000.", 400);
    return listSessions(this.#options.homeDir, { ...(raw.cwd !== undefined ? { cwd: text(raw.cwd, "Working directory", MAX_TARGET_LENGTH) } : {}), ...(raw.limit !== undefined ? { limit: raw.limit as number } : {}) });
  }
  async search(value: unknown = {}): Promise<{ results: ChatSearchResult[]; hasMore: boolean; nextOffset: number | null; truncated: boolean }> {
    const raw = object(value, "Chat search"); allowedKeys(raw, ["q", "limit", "offset"]);
    const query = raw.q === undefined ? "" : text(raw.q, "Search query", 200, true).trim();
    const limit = raw.limit ?? 30; const offset = raw.offset ?? 0;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new ConsoleGatewayError("Search limit must be 1–100.", 400);
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 10_000) throw new ConsoleGatewayError("Search offset must be 0–10,000.", 400);
    const excluded = new Set<string>(); const live: ChatSearchResult[] = [];
    for (const managed of this.#sessions.values()) {
      // Closed transcripts come from disk so their archive state stays authoritative.
      if (managed.status === "closed") continue;
      excluded.add(managed.id); if (managed.savedId) excluded.add(managed.savedId);
      const messages = [...(managed.session?.messages ?? managed.initialMessages), ...managed.queued.map(message => ({ role: "user", content: message.text }))];
      if (!messages.length) continue;
      const result = matchChat({ id: managed.id, ...(managed.savedId ? { savedId: managed.savedId } : {}), title: managed.title, updatedAt: managed.updatedAt, archived: false, status: managed.status, source: "live", messages }, query);
      if (result) live.push(result);
    }
    const saved = await searchSavedChats(this.#options.homeDir, query, excluded);
    const all = [...live, ...saved.results].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const end = (offset as number) + (limit as number); const hasMore = all.length > end;
    return { results: all.slice(offset as number, end), hasMore, nextOffset: hasMore ? end : null, truncated: saved.truncated };
  }
  loadSaved(id: string): { meta: ConsoleSavedSession; messages: ConsolePublicMessage[] } {
    const stored = this.#stored(id); const { messages, consoleState: _displayOnly, ...meta } = stored; return { meta, messages: attributedMessages(messages, stored.consoleState?.userAttributions ?? []) };
  }
  async resume(id: string, value: unknown = {}): Promise<DesktopConsoleSession> {
    const stored = this.#stored(id);
    const raw = object(value, "Resume configuration"); allowedKeys(raw, ["title", "role", "runtime", "autonomyMode", "target", "scope"]);
    if (raw.title !== undefined) text(raw.title, "Title", 200);
    if (raw.target !== undefined) text(raw.target, "Target", MAX_TARGET_LENGTH, true);
    if (raw.role !== undefined) role(raw.role);
    if (raw.autonomyMode !== undefined) mode(raw.autonomyMode);
    if (raw.runtime !== undefined) runtimeSelection(raw.runtime);
    if (raw.scope !== undefined) scopePolicy(raw.scope);
    const initialMessages = this.#nativeSavedMessages(stored.messages);
    const existing = [...this.#sessions.values()].find((managed) => managed.status !== "closed" && (managed.savedId === id || managed.id === id));
    if (existing) {
      if (!existing.session) { await this.#ensureSession(existing); existing.status = "ready"; this.#emitSession(existing); }
      return this.#summary(existing);
    }
    // Restore validated working context, never infer permissions from transcript text.
    // Scope grants, approvals and executable worker handles belong to the old engine.
    const configuration = stored.consoleState?.configuration;
    const defaults = {
      autonomyMode: "standard",
      target: configuration?.target ?? stored.target ?? "",
      ...(configuration ? { role: configuration.role, runtime: configuration.runtime } : stored.model ? { runtime: { model: stored.model } } : {}),
    };
    const created = this.#createRecord({ ...defaults, ...raw }); const managed = this.#require(created.id);
    managed.initialMessages = initialMessages; managed.workspacePath = stored.cwd; managed.savedId = id; managed.title = raw.title === undefined ? stored.summary ?? stored.preview ?? "Resumed chat" : managed.title;
    managed.objective = stored.summary ?? "";
    if (stored.consoleState) {
      const state = stored.consoleState;
      managed.userAttributions = state.userAttributions ?? [];
      managed.title = raw.title === undefined ? state.title : managed.title;
      managed.objective = state.objective; managed.todos = state.todos; managed.usage = state.usage;
      managed.lastOutcome = state.lastOutcome; managed.compaction = state.compaction; managed.contextInputTokens = state.contextInputTokens;
      // Old worker handles died with the prior engine. Their retained transcripts
      // remain readable, but no record is made live or addressable by resuming.
      managed.workers = new Map(state.workers.map((worker) => [worker.id, { ...worker, status: Object.hasOwn(ACTIVE_WORKERS, worker.status) ? "stopped" as const : worker.status }]));
      managed.queued = state.queuedMessages; managed.pauseQueue = true; managed.stagedPrompt = state.stagedPrompt;
      if (state.focusedFindingId) {
        try { managed.focusedFinding = loadFindingFocus(state.focusedFindingId, { dbPath: this.#options.dbPath }).finding; } catch { /* Evidence can be removed independently of this transcript. */ }
      }
    }
    await this.#ensureSession(managed); this.#emitSession(managed); return this.#summary(managed);
  }
  deleteSaved(id: string): void {
    this.#stored(id);
    const protectedIds = new Set([...this.#sessions.values()].filter((managed) => managed.status !== "closed").flatMap((managed) => [managed.id, ...(managed.savedId ? [managed.savedId] : [])]));
    if (protectedIds.has(id)) throw new ConsoleGatewayError("Close the live conversation before deleting its saved transcript.", 409);
    if (!deleteSession(id, this.#options.homeDir, { protectedIds })) throw new ConsoleGatewayError("Saved transcript could not be deleted.", 500);
  }
  export(id: string): ConsolePublicExport { const managed = this.#require(id); return { ...publicExport(managed.session?.messages ?? managed.initialMessages), source: "canonical-root-history" }; }
  exportSaved(id: string): ConsolePublicExport { return publicExport(this.#stored(id).messages); }
  exportWorker(id: string, workerId: string): ConsolePublicExport {
    const worker = this.worker(id, workerId);
    const timeline: Array<{ at: number; messages: ConsolePublicMessage[] }> = worker.transcript.map((turn) => {
      const assistant: ConsolePublicMessage["content"] = [];
      if (turn.assistant) assistant.push({ type: "text", text: turn.assistant });
      const results: ConsolePublicMessage["content"] = [];
      for (const tool of turn.tools ?? []) {
        const toolId = tool.call.id ?? `${worker.id}-turn-${turn.turn}-call-${tool.callIndex}`;
        if (!record(tool.call.arguments)) continue;
        assistant.push({ type: "tool_use", id: toolId, name: tool.call.name, input: json(tool.call.arguments) as Record<string, ConsoleJsonValue> });
        if (!tool.running) results.push({ type: "tool_result", tool_use_id: toolId, content: JSON.stringify(tool.result), ...(record(tool.result) && tool.result.success === false ? { is_error: true } : {}) });
      }
      return { at: turn.ts, messages: [...(assistant.length ? [{ role: "assistant" as const, content: assistant }] : []), ...(results.length ? [{ role: "user" as const, content: results }] : [])] };
    });
    for (const message of worker.operatorMessages ?? []) timeline.push({ at: Date.parse(message.createdAt), messages: [{ role: "user", content: [{ type: "text", text: message.text }] }] });
    const messages: ConsolePublicMessage[] = [
      ...(worker.task ? [{ role: "user" as const, content: [{ type: "text" as const, text: worker.task }] }] : []),
      ...timeline.sort((a, b) => a.at - b.at).flatMap((entry) => entry.messages),
    ];
    return { ...publicExport(messages), source: "published-worker-trace" };
  }
  workers(id: string): ConsoleWorker[] { return [...this.#require(id).workers.values()].map((worker) => structuredClone(worker)); }
  worker(id: string, workerId: string): ConsoleWorker {
    const worker = this.#require(id).workers.get(workerId); if (!worker) throw new ConsoleGatewayError("Worker does not belong to this session.", 404); return structuredClone(worker);
  }
  sendWorker(id: string, workerId: string, value: unknown, author?: ConsoleMessageAuthor): DesktopConsoleSession {
    const managed = this.#requireOpen(id); const body = text(value, "Worker message", MAX_OPERATOR_TEXT_LENGTH); const worker = managed.workers.get(workerId);
    const attribution = author === undefined ? undefined : serverAuthorSchema.parse(author);
    if (!worker || !Object.hasOwn(ACTIVE_WORKERS, worker.status)) throw new ConsoleGatewayError("Worker is not reachable in this session.", 404);
    if (managed.execution.backend === "smolvm") throw new ConsoleGatewayError("Worker messages must be delivered inside the isolated workspace. Host mailbox delivery is refused until the guest messaging bridge is available.", 409);
    const settings = getSettings();
    const result = sendOperatorMessage({ selfId: "Main", selfRole: "operator", siblingChannelEnabled: false, operatorChannelEnabled: settings.allowSubagentOperatorMessaging, projectPath: managed.workspacePath ?? this.#projectPath, homeDir: managed.messagingHome, knownPeerIds: [...managed.workers.values()].filter((worker) => Object.hasOwn(ACTIVE_WORKERS, worker.status)).map((worker) => worker.id) }, workerId, body, this.#now().getTime());
    if (!result.ok) throw new ConsoleGatewayError(result.reason ?? "Worker message could not be delivered.", 409);
    worker.operatorMessages ??= [];
    worker.operatorMessages.push({ id: this.#createId(), text: clampOutboundBody(body).body, createdAt: this.#now().toISOString(), ...(attribution ? { author: attribution } : {}) });
    this.#emitWorker(managed, worker, undefined, worker.operatorMessages.at(-1));
    this.#emit(managed, { type: "notice", text: `Message delivered to ${worker.name}${result.truncated ? " (truncated by the mailbox limit)" : ""}.` }); return this.#summary(managed);
  }
  async stopWorker(id: string, workerId: string): Promise<ConsoleWorker> {
    const managed = this.#requireOpen(id); this.worker(id, workerId);
    if (!managed.session || !await managed.session.stopPersistentAgent(workerId)) throw new ConsoleGatewayError("Worker is no longer running.", 409);
    const subtree = new Set([workerId]); let added: boolean;
    do { added = false; for (const worker of managed.workers.values()) if (subtree.has(worker.parentId) && !subtree.has(worker.id)) { subtree.add(worker.id); added = true; } } while (added);
    for (const worker of managed.workers.values()) if (subtree.has(worker.id)) { worker.status = "stopped"; this.#emitWorker(managed, worker); }
    return this.worker(id, workerId);
  }
  async drainWorkers(id: string): Promise<DesktopConsoleSession> {
    const managed = this.#requireOpen(id); await managed.session?.stopPersistentAgents();
    for (const worker of managed.workers.values()) if (Object.hasOwn(ACTIVE_WORKERS, worker.status)) { worker.status = "stopped"; this.#emitWorker(managed, worker); }
    if (managed.pendingConfiguration && !managed.turn) await this.#applyPendingConfiguration(managed);
    return this.#summary(managed);
  }
  /** Reopen working context for a durable schedule without restoring old grants or sending saved messages. */
  async prepareScheduledWorkflowOwner(id: string): Promise<string> {
    const existing = [...this.#sessions.values()].find(managed => managed.status !== "closed" && (managed.id === id || managed.savedId === id));
    if (existing) return existing.id;
    return (await this.resume(id)).id;
  }
  async getExecutionContext(id: string): Promise<ConsoleExecutionContext> {
    const managed = this.#requireOpen(id); this.#assertIdle(managed);
    if (managed.execution.backend === "smolvm" || consoleExecutionProfile(this.#options.homeDir) === "smolvm") throw new ConsoleGatewayError("This workflow has not been qualified inside the SmolVM controller. Use the isolated chat; host execution is refused.", 409);
    if (managed.pendingConfiguration || managed.queued.length) throw new ConsoleGatewayError("Apply staged configuration and send or remove queued messages before starting a workflow.", 409);
    for (const worker of managed.workers.values()) if (Object.hasOwn(ACTIVE_WORKERS, worker.status)) throw new ConsoleGatewayError("Drain owned workers before starting a workflow with a stable authorization snapshot.", 409);
    const session = await this.#ensureSession(managed); const runtime = managed.runtime;
    this.#assertIdle(managed);
    if (!runtime?.forkForSubagent) throw new ConsoleGatewayError("The selected runtime cannot safely fork an independent workflow account.", 409);
    const checkpoint = session.exportCheckpoint();
    const epoch = managed.executionEpoch;
    const info = describeWebConsoleRuntime(runtime); const fork = await runtime.forkForSubagent(900_000);
    this.#assertIdle(managed);
    if (managed.executionEpoch !== epoch || managed.pendingConfiguration) throw new ConsoleGatewayError("The owner session changed while preparing this workflow. Retry with the current configuration.", 409);
    return { runtime: fork, model: info.model, providerId: info.providerId, agentModels: { ...info.agentModels }, singleModel: info.singleModel, autoRoute: info.autoRoute, target: session.target, scope: session.scope ? ScopePolicy.fromJson(structuredClone(session.scope.raw)) : undefined, scopeEnforcement: getScopeEnforcementState(this.#projectPath, this.#options.homeDir), localScopePath: session.localScopePath, status: managed.status, role: managed.role, autonomyMode: session.autonomyMode, settings: { ...getSettings() }, dbPath: this.#options.dbPath,
      authorization: { deniedHosts: [...checkpoint.deniedHosts], deniedLocalPaths: [...checkpoint.deniedLocalPaths], scopedAuditGrants: [...checkpoint.executor.scopedAuditGrants], scopedAuditDenials: [...checkpoint.executor.scopedAuditDenials] },
    };
  }
  async authorizeWorkflowTarget(id: string, value: { target: string; kind: string }, signal?: AbortSignal, ownerId?: string, options: { interactive?: boolean } = {}): Promise<ConsoleExecutionContext> {
    const managed = this.#requireOpen(id); const raw = object(value, "Workflow target"); allowedKeys(raw, ["target", "kind"]);
    const target = text(raw.target, "Workflow target", MAX_TARGET_LENGTH); const kind = text(raw.kind, "Workflow kind", 32);
    if (!["web", "source", "package"].includes(kind)) throw new ConsoleGatewayError("Unsupported workflow target kind.", 400);
    const context = await this.getExecutionContext(id);
    if (signal?.aborted) throw new ConsoleGatewayError("Workflow was cancelled.", 409);
    const epoch = managed.executionEpoch;
    const verifyOwner = () => {
      this.#requireOpen(id);
      if (signal?.aborted || managed.executionEpoch !== epoch || managed.pendingConfiguration) throw new ConsoleGatewayError("The workflow owner changed or was cancelled while awaiting approval. Retry after the session reaches its safe boundary.", 409);
    };
    if (!context.scopeEnforcement.enabled) return { ...context, target };
    const call: ToolCall = { name: "launch_run", arguments: { target, kind } };
    const remoteGit = /^git@([^:]+):(.+)$/.exec(target);
    if ((context.role === "audit" || context.role === "review") && context.localScopePath && context.autonomyMode !== "yolo" && (kind !== "source" || remoteGit || /^[a-z][a-z0-9+.-]*:\/\//i.test(target))) {
      if (context.authorization.scopedAuditDenials.includes("launch_run")) throw new ConsoleGatewayError("This workflow action was previously declined by the source-audit gate.", 403);
      if (!context.authorization.scopedAuditGrants.includes("launch_run")) {
        if (options.interactive === false) throw new ConsoleGatewayError("Target approval required. Run this workflow manually to review its permissions.", 403);
        const response = await this.#requestDecision(managed, { kind: "audit-escalation", title: "Authorize a non-source workflow", detail: "The current audit/review engagement is restricted to its local source subtree. This permits only this workflow; other authorization controls remain in force.", reason: "A web/package or remote-source workflow falls outside the scoped source-audit capability allow-list.", call: this.#withCallId(call) }, ownerId ?? "workflow", signal);
        verifyOwner();
        if (!response.approve) throw new ConsoleGatewayError("Source-audit workflow escalation was declined.", 403);
      }
    }
    if (kind === "source" && !remoteGit && !/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
      let canonical: string;
      try { canonical = realpathSync(resolve(this.#projectPath, target)); } catch { throw new ConsoleGatewayError("Source target is not an existing local path.", 400); }
      if (!statSync(canonical).isDirectory() || isDangerousLocalRoot(canonical)) throw new ConsoleGatewayError("A source workflow requires a non-root project directory, not the filesystem or home root.", 403);
      if (context.authorization.deniedLocalPaths.some((denied) => { const path = relative(denied, canonical); return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); })) throw new ConsoleGatewayError("This source directory is covered by an earlier declined local-scope decision.", 403);
      const current = context.localScopePath;
      const rel = current ? relative(current, canonical) : "..";
      if (!current || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        if (options.interactive === false) throw new ConsoleGatewayError("Target approval required. Run this workflow manually to review its permissions.", 403);
        const response = await this.#requestDecision(managed, { kind: "local-scope", title: "Authorize workflow directory", detail: "Authorize this canonical directory subtree for this workflow only; this does not change the chat's authorization.", call: this.#withCallId(call), requestedPath: canonical, ...(current ? { currentScopePath: current } : {}) }, ownerId ?? "workflow", signal);
        if (!response.approve) throw new ConsoleGatewayError("Workflow directory authorization was declined.", 403);
        verifyOwner();
      }
      return { ...context, target: canonical, localScopePath: current && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? current : canonical };
    }
    let url: URL | undefined;
    try { url = new URL(remoteGit ? `https://${remoteGit[1]}/${remoteGit[2]}` : target); } catch { /* Package ecosystem selectors are not URLs. */ }
    if (url && (url.protocol === "https:" || url.protocol === "http:")) {
      if (context.authorization.deniedHosts.includes(normalizeScopeHostname(url.hostname))) throw new ConsoleGatewayError("This network host was declined earlier in the owner session.", 403);
      if (context.scope?.match(url.href).allowed) return { ...context, target };
      const request: ConsoleScopeRequest = { call, target: context.target, currentScope: context.scope, requestedUrls: [url.href] };
      const resolution = buildScopeResolution(request);
      if (!resolution) throw new ConsoleGatewayError("The workflow target is explicitly excluded by the current scope.", 403);
      if (options.interactive === false) throw new ConsoleGatewayError("Target approval required. Run this workflow manually to review its permissions.", 403);
      const response = await this.#requestDecision(managed, { kind: "scope", title: "Authorize workflow target", detail: "Authorize this network target for this workflow only; existing exclusions still apply.", call: this.#withCallId(call), requestedUrls: [url.href], currentScope: context.scope?.raw ?? null }, ownerId ?? "workflow", signal);
      if (!response.approve) throw new ConsoleGatewayError("Workflow target authorization was declined.", 403);
      verifyOwner();
      return { ...context, target, scope: resolution.scope };
    }
    if (options.interactive === false) throw new ConsoleGatewayError("Target approval required. Run this workflow manually to review its permissions.", 403);
    const response = await this.#requestDecision(managed, { kind: "tool", title: "Authorize package workflow", detail: "Authorize resolution and analysis of this package ecosystem selector. This does not grant arbitrary network or filesystem access.", call: this.#withCallId(call), reason: "Package selectors do not identify a network host until the current resolver resolves them." }, ownerId ?? "workflow", signal);
    if (!response.approve) throw new ConsoleGatewayError("Package workflow authorization was declined.", 403);
    verifyOwner();
    return { ...context, target };
  }
  async close(id: string): Promise<void> {
    const managed = this.#require(id); if (managed.status === "closed") return;
    for (const request of managed.workflowRequests.values()) if (request.status !== "launched") { request.abort.abort(); request.status = "cancelled"; }
    managed.status = "closed"; managed.pauseQueue = true; managed.queued = []; managed.abort?.abort(); this.#denyDecisions(managed);
    this.#emitSession(managed); await managed.initialization?.catch(() => undefined); await managed.configuration?.catch(() => undefined); await managed.turn;
    this.#save(managed); managed.busUnsubscribe?.(); managed.busUnsubscribe = null;
    try { await managed.session?.cleanup(); } finally { if (managed.messagingHome) rmSync(managed.messagingHome, { recursive: true, force: true }); }
  }
  async delete(id: string): Promise<{ sessionId: string; savedId?: string }> {
    const managed = this.#require(id); const savedId = managed.savedId ?? managed.id;
    for (const other of this.#sessions.values()) if (other !== managed && other.status !== "closed" && (other.id === savedId || other.savedId === savedId)) throw new ConsoleGatewayError("Another live session owns this saved transcript. Close that session before deleting it.", 409);
    await this.close(id);
    const saved = loadSession(savedId, this.#options.homeDir);
    if (saved) this.deleteSaved(savedId);
    this.#sessions.delete(id);
    return { sessionId: id, ...(saved ? { savedId } : {}) };
  }
  async closeAll(): Promise<void> { await Promise.all([...this.#sessions.keys()].map((id) => this.close(id))); }
  get #projectPath(): string { return this.#options.projectPath ?? process.cwd(); }
  #assertIdle(managed: ManagedSession): void {
    if (managed.status === "closed") throw new ConsoleGatewayError("Console session is closed.", 410);
    if (managed.turn || managed.initialization || managed.configuration || managed.pending.size) throw new ConsoleGatewayError("Wait for the current turn and decisions to finish.", 409);
  }
  async #ensureSession(managed: ManagedSession): Promise<ConsoleSession> {
    if (managed.session) {
      if (!this.#options.createSession && managed.execution.backend !== consoleExecutionProfile(this.#options.homeDir)) throw new ConsoleGatewayError("The execution profile changed. Start a new chat or resume its checkpoint with the selected profile before running more work.", 409);
      return managed.session;
    }
    if (managed.initialization) return managed.initialization;
    this.#subscribeBus(managed);
    const initialize = (async () => {
      let session: ConsoleSession | undefined;
      try {
        managed.messagingHome ??= mkdtempSync(join(tmpdir(), "0-web-messaging-"));
        const settings = getSettings();
        const callbacks = this.#decisionCallbacks(managed);
        const skillAuthoring = this.#options.skillAuthoring ? () => { const adapter = this.#options.skillAuthoring!(this.#skillActor.getStore(), managed.workspacePath ?? this.#projectPath ?? process.cwd()); return typeof adapter === "function" ? adapter() : adapter; } : undefined;
        const skillDiscoveryOptions = this.#options.skillDiscoveryOptions ? () => this.#options.skillDiscoveryOptions!(managed.workspacePath ?? this.#projectPath ?? process.cwd()) : undefined;
        if (this.#options.createSession) {
          session = await this.#options.createSession({ scanId: managed.id, target: managed.target, role: managed.role, autonomyMode: managed.autonomyMode, scope: managed.scope, skillDiscoveryOptions, skillAuthoring, workspaceRoot: managed.workspacePath ?? this.#projectPath, initialMessages: managed.initialMessages, codebaseLearning: true, ...(this.#sourceLearningStore ? { learningStore: this.#sourceLearningStore } : {}), ...(this.#workflowLifecycle ? { workflowLifecycle: this.#workflowCallbacks(managed) } : {}), ...callbacks });
        } else if (consoleExecutionProfile(this.#options.homeDir) === "smolvm") {
          if (!managed.runtime) { const created = await createWebConsoleRuntime(managed.selection); managed.runtime = created.runtime; managed.info = created.info; }
          session = createLocalConsoleSession({
            runtime: managed.runtime, costModel: managed.runtime.resolvedModel(), contextWindowTokens: managed.info?.contextWindowTokens ?? undefined,
            scanId: managed.id, target: managed.target, role: managed.role, autonomyMode: managed.autonomyMode, scope: managed.scope,
            initialMessages: managed.initialMessages, workspaceRoot: managed.workspacePath ?? this.#projectPath, codebaseLearning: true,
            ...(this.#sourceLearningStore ? { learningStore: this.#sourceLearningStore } : {}),
            allowModelSelfExtension: settings.allowModelSelfExtension, compaction: { enabled: settings.autoCompaction, thresholdFraction: Number.parseFloat(settings.compactionThreshold) / 100 },
            onHarnessUpdate: (harness) => { managed.harness = harness; this.#emit(managed, { type: "harness", harness }); }, ...callbacks,
          }, this.#options.dbPath, { homeDir: this.#options.homeDir, workspaceRoot: managed.workspacePath ?? this.#projectPath,
            onExecution: (execution) => { managed.execution = structuredClone(execution); this.#emitSession(managed); },
          });
        } else {
          managed.execution = { backend: "local", status: "ready", workspacePath: this.#projectPath };
          if (!managed.runtime) { const created = await createWebConsoleRuntime(managed.selection); managed.runtime = created.runtime; managed.info = created.info; }
          const manager = await getWebConsolePluginHostManager(); await manager.refresh(); const lease = manager.acquire();
          let mcpHost: McpHost | undefined;
          try {
            mcpHost = await connectServicePlugins(loadServicePluginConnections(), await connectMcpServers(parseMcpConfig(process.env["ZERO_MCP"])));
            session = createLocalConsoleSession({ runtime: managed.runtime, costModel: managed.runtime.resolvedModel(), contextWindowTokens: managed.info?.contextWindowTokens ?? undefined,
              compaction: { enabled: settings.autoCompaction, thresholdFraction: Number.parseFloat(settings.compactionThreshold) / 100 },
              scanId: managed.id, target: managed.target, role: managed.role, autonomyMode: managed.autonomyMode, scope: managed.scope,
              initialMessages: managed.initialMessages, codebaseLearning: true, skillDiscoveryOptions, skillAuthoring,
              ...(this.#sourceLearningStore ? { learningStore: this.#sourceLearningStore } : {}),
              ...(this.#workflowLifecycle ? { workflowLifecycle: this.#workflowCallbacks(managed) } : {}),
              workflowAuthoring: {
                list: () => { const store = new SecurityWorkflowStore(this.#options.dbPath); try { return store.list(); } finally { store.close(); } },
                save: input => { const store = new SecurityWorkflowStore(this.#options.dbPath); try { return store.save(input); } finally { store.close(); } },
              },
              allowModelSelfExtension: settings.allowModelSelfExtension, workspaceRoot: managed.workspacePath ?? this.#projectPath, pluginHost: lease.host, ...(mcpHost ? { mcpHost } : {}),
              agentMessaging: { selfId: "Main", selfRole: "parent", siblingChannelEnabled: settings.allowSubagentPeerMessaging, operatorChannelEnabled: settings.allowSubagentOperatorMessaging, projectPath: managed.workspacePath ?? this.#projectPath, homeDir: managed.messagingHome },
              onHarnessUpdate: (harness) => { managed.harness = harness; this.#emit(managed, { type: "harness", harness }); }, ...callbacks,
            }, this.#options.dbPath);
          } catch (error) { lease.release(); await mcpHost?.closeAll(); throw error; }
          const cleanup = session.cleanup; let cleanupPromise: Promise<void> | undefined;
          session.cleanup = () => cleanupPromise ??= cleanup().finally(() => lease.release());
        }
        if (this.#options.createSession) managed.execution = { backend: "local", status: "ready", workspacePath: this.#projectPath };
        await session.ready;
        if (managed.status === "closed") { await session.cleanup(); throw new ConsoleGatewayError("Console session is closed.", 410); }
        managed.session = session;
        if (managed.status === "failed") managed.status = "ready";
        managed.initialMessages = [];
        return session;
      } catch (error) {
        await session?.cleanup().catch(() => undefined);
        if (!managed.session) { managed.runtime = null; managed.info = null; }
        managed.execution = { ...managed.execution, status: "failed", message: errorMessage(error) };
        if (managed.status !== "closed") { managed.status = "failed"; this.#emit(managed, { type: "error", message: errorMessage(error) }); this.#emitSession(managed); }
        throw error instanceof ConsoleGatewayError ? error : new ConsoleGatewayError(errorMessage(error), 409);
      }
    })();
    managed.initialization = initialize;
    try { return await initialize; } finally { if (managed.initialization === initialize) managed.initialization = null; }
  }
  #decisionCallbacks(managed: ManagedSession): Pick<ConsoleSessionConfig, "requestScope" | "requestLocalScope" | "approveTool" | "escalateScopedAudit" | "askOperator"> {
    return {
      requestScope: async (request) => {
        const resolution = buildScopeResolution(request);
        const response = await this.#requestDecision(managed, { kind: "scope", title: "Authorize scope expansion", detail: request.unresolvedTargets?.length ? "The destination cannot be resolved. Read the exact command; approval applies to this call, not to an invented destination." : "Authorize the requested network targets without overriding any explicit exclusions.", call: this.#withCallId(request.call), requestedUrls: [...request.requestedUrls], unresolvedTargets: request.unresolvedTargets ? [...request.unresolvedTargets] : undefined, currentScope: request.currentScope?.raw ?? null }, managed.turnOwner ?? "session", managed.abort?.signal, (response) => !response.approve || resolution !== null);
        return response.approve ? resolution : null;
      },
      requestLocalScope: async (request) => {
        const response = await this.#requestDecision(managed, { kind: "local-scope", title: "Authorize local directory", detail: "This grants the exact canonical directory subtree for this session only. Nothing is persisted as authorization.", call: this.#withCallId(request.call), requestedPath: request.requestedPath, currentScopePath: request.currentScopePath }, managed.turnOwner ?? "session", managed.abort?.signal);
        return response.approve ? { scopePath: request.requestedPath } : null;
      },
      approveTool: async (call, risk) => (await this.#requestDecision(managed, { kind: "tool", title: "Confirm tool action", detail: "Standard mode requires explicit confirmation before this action runs. Risk classification is advisory, never an authorization bypass.", call: this.#withCallId(call), ...(risk ? { risk } : {}) }, managed.turnOwner ?? "session", managed.abort?.signal)).approve,
      escalateScopedAudit: async (request) => (await this.#requestDecision(managed, { kind: "audit-escalation", title: "Lift source-audit restriction", detail: "This lifts only the source-audit tool allow-list. Scope, local-directory, credential, and per-tool rules remain in force.", reason: request.reason, call: this.#withCallId(request.call) }, managed.turnOwner ?? "session", managed.abort?.signal)).approve,
      askOperator: async (request) => {
        const response = await this.#requestDecision(managed, { kind: "operator-question", title: "Operator input requested", detail: "Answering provides information only; it authorizes no tool or scope change.", questions: request.questions.map((question) => ({ ...question, allowCustom: question.allowCustom || !question.options?.length, options: question.options?.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}), ...(option.recommended ? { recommended: true } : {}) })) })) }, managed.turnOwner ?? "session", managed.abort?.signal, (response) => !response.approve || validOperatorAnswer(request, response) !== null);
        return validOperatorAnswer(request, response);
      },
    };
  }
  /** Records lifecycle metadata only; conversation text and tool output stay out of learning. */
  attachSourceLearning(store: LearningStore): void { this.#sourceLearningStore = store; }

  attachLearningRecorder(recorder: (event: { id: string; project: string; outcome: string }) => void): void { this.#learningRecorder = recorder; }
  async #startTurn(managed: ManagedSession, body: string, author?: ConsoleMessageAuthor): Promise<void> {
    managed.executionEpoch++;
    managed.status = "working"; this.#emitSession(managed);
    let session: ConsoleSession;
    try { session = await this.#ensureSession(managed); if (managed.pendingConfiguration) await this.#applyPendingConfiguration(managed); session = managed.session ?? session; }
    catch (error) { managed.status = (managed.status as DesktopConsoleSessionStatus) === "closed" ? "closed" : "failed"; throw error; }
    if ((managed.status as DesktopConsoleSessionStatus) === "closed") throw new ConsoleGatewayError("Console session is closed.", 410);
    const abort = new AbortController(); managed.abort = abort; managed.pauseQueue = false; managed.turnOwner = `turn:${this.#createId()}`; managed.lastOutcome = null;
    managed.stagedPrompt = undefined;
    const generateTitle = managed.title === "New chat" || managed.title === "New conversation" || managed.title === "New session";
    if (generateTitle) {
      managed.title = body.replace(/\s+/g, " ").trim().slice(0, 80);
    }
    const fallbackTitle = managed.title;
    managed.userAttributions.push({ text: body, ...(author ? { author: structuredClone(author) } : {}) });
    if (managed.userAttributions.length > 10000) managed.userAttributions.splice(0, managed.userAttributions.length - 10000);
    this.#emitSession(managed); this.#emit(managed, { type: "user", text: body, ...(author ? { author: structuredClone(author) } : {}) });
    const turn = (async () => {
      try {
        const outcome = await this.#skillActor.run(author, () => session.send(body, {
          onAssistantDelta: (text) => this.#emit(managed, { type: "assistant-delta", text }), onReasoningDelta: (text) => this.#emit(managed, { type: "reasoning-delta", text }),
          onToolStart: (call) => this.#emit(managed, { type: "tool-start", call: this.#withCallId(call) }),
          onToolResult: (call, result) => this.#emit(managed, { type: "tool-result", call: this.#withCallId(call), result: json(result) }),
          onUsage: (usage) => {
            managed.usage.inputTokens += usage.inputTokens; managed.usage.outputTokens += usage.outputTokens;
            const model = managed.runtime?.resolvedModel() ?? managed.info?.model;
            if (model && Object.hasOwn(MODEL_PRICING, model)) {
              if (managed.usage.inputTokens === usage.inputTokens && managed.usage.outputTokens === usage.outputTokens) managed.usage.costUnavailable = false;
              managed.usage.costUsd = (managed.usage.costUsd ?? 0) + estimateCost(usage, model);
              managed.usage.costKind = "estimated";
            } else managed.usage.costUnavailable = true;
            if (usage.kind === "planner") managed.contextInputTokens = usage.inputTokens;
            this.#emit(managed, { type: "usage", usage: { ...usage, turnTokenBudget: Number.isFinite(usage.turnTokenBudget) ? usage.turnTokenBudget : null } });
          },
          onNotice: (text) => this.#emit(managed, { type: "notice", text }),
          onCompaction: (event) => { managed.compaction = json({ ...event, preCompactionMessages: publicMessages(event.preCompactionMessages) }); this.#emit(managed, { type: "compaction", compaction: managed.compaction }); },
          onHarnessUpdate: (harness) => { managed.harness = harness; this.#emit(managed, { type: "harness", harness }); },
        }, { signal: abort.signal, generateTitle }));
        if (outcome.stopReason === "end_turn" && outcome.conversationTitle && managed.title === fallbackTitle) {
          managed.title = outcome.conversationTitle;
          this.#emitSession(managed);
        }
        managed.lastOutcome = this.#outcome(outcome); managed.contextInputTokens = outcome.contextInputTokens ?? managed.contextInputTokens;
        this.#emit(managed, { type: "turn-complete", ...managed.lastOutcome });
        if (outcome.stopReason === "cancelled" && managed.execution.backend === "smolvm" && managed.execution.status === "stopped") {
          await session.cleanup();
          managed.initialMessages = structuredClone(session.messages);
          managed.session = null;
        }
      } catch (error) { if (managed.status !== "closed") managed.status = "failed"; this.#emit(managed, { type: "error", message: errorMessage(error) }); }
      finally {
        try {
          this.#learningRecorder?.({ id: `${managed.id}:${managed.turnOwner}`, project: managed.workspacePath ?? this.#projectPath,
            outcome: abort.signal.aborted ? "cancelled" : managed.status === "failed" ? "failed" : managed.lastOutcome?.stopReason === "end_turn" ? "completed" : "inconclusive" });
        } catch { this.#emit(managed, { type: "notice", text: "Learning activity could not be retained for this turn." }); }
        this.#denyDecisions(managed, managed.turnOwner ?? undefined); managed.abort = null; managed.turnOwner = null; managed.turn = null;
        if (managed.status !== "closed") {
          if (managed.status !== "failed") managed.status = "ready";
          try { if (managed.pendingConfiguration) await this.#applyPendingConfiguration(managed); if (!this.#options.createSession && managed.execution.backend === "local") await flushWebConsolePlugins(); }
          catch (error) { this.#emit(managed, { type: "error", message: errorMessage(error) }); }
          this.#save(managed); this.#refreshStatus(managed);
          await this.#processIdleWork(managed);
        } else this.#save(managed);
      }
    })();
    managed.turn = turn;
  }
  #workflowCallbacks(managed: ManagedSession): NonNullable<ConsoleSessionConfig["workflowLifecycle"]> {
    return { invoke: async (name, args) => {
      this.#requireOpen(managed.id);
      const adapter = this.#workflowLifecycle;
      if (!adapter) throw new ConsoleGatewayError("Workflow lifecycle is unavailable.", 409);
      if (name === "start_run") {
        const epoch = managed.executionEpoch;
        const turnOwner = managed.turnOwner ?? undefined;
        const turnSignal = managed.abort?.signal;
        if (managed.autonomyMode === "recon") throw new ConsoleGatewayError("Recon mode cannot start workflows.", 403);
        const request = workflowLaunchSchema.parse(args);
        if (Boolean(request.templateId) === Boolean(request.workflowId)) throw new ConsoleGatewayError("Select exactly one template or saved workflow.", 400);
        if (request.workflowId && !request.revision) throw new ConsoleGatewayError("Saved workflow runs require a pinned revision.", 400);
        if (request.templateId && !request.revision) {
          const response = await adapter.invoke(managed.id, "get_template", { id: request.templateId });
          const template = record(response) && record(response.template) ? response.template : response;
          if (!record(template) || !Number.isSafeInteger(template.revision)) throw new ConsoleGatewayError("Template revision is unavailable.", 409);
          request.revision = template.revision as number;
        }
        this.#requireOpen(managed.id);
        if (turnSignal?.aborted || managed.executionEpoch !== epoch) throw new ConsoleGatewayError("The workflow owner changed or cancelled while preparing this request.", 409);
        if (request.idempotencyKey) {
          const previous = [...managed.workflowRequests.values()].find(item => item.request.idempotencyKey === request.idempotencyKey);
          if (previous) {
            if (JSON.stringify(previous.request) !== JSON.stringify(request)) throw new ConsoleGatewayError("Idempotency key belongs to a different workflow request.", 409);
            return this.#workflowRequestView(previous);
          }
        }
        if ([...managed.workflowRequests.values()].filter(item => ["queued", "awaiting-approval", "starting"].includes(item.status)).length >= 4) throw new ConsoleGatewayError("The workflow launch queue is full.", 409);
        while (managed.workflowRequests.size >= 40) {
          const terminal = [...managed.workflowRequests.values()].find(item => ["launched", "failed", "cancelled"].includes(item.status));
          if (!terminal) break;
          managed.workflowRequests.delete(terminal.id);
        }
        const queued: QueuedWorkflowRequest = { id: `workflow-request-${randomUUID()}`, epoch, turnOwner, request: structuredClone(request), abort: new AbortController(), status: "queued" };
        managed.workflowRequests.set(queued.id, queued);
        this.#emit(managed, { type: "notice", text: `Workflow request ${queued.id} queued. Launch awaits the end of this turn and operator approval.` });
        return this.#workflowRequestView(queued);
      }
      if (["get_run", "get_run_results", "cancel_run"].includes(name)) {
        const page = z.object({ runId: z.string().trim().min(1).max(160), cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict().parse(args);
        const queued = managed.workflowRequests.get(page.runId);
        if (queued) {
          if (name === "cancel_run" && !queued.runId) { queued.abort.abort(); queued.status = "cancelled"; return this.#workflowRequestView(queued); }
          if (!queued.runId) return { ...this.#workflowRequestView(queued), ...(name === "get_run_results" ? { findings: [], pending: ["queued", "awaiting-approval", "starting"].includes(queued.status) } : {}) };
          const result = await adapter.invoke(managed.id, name, { ...page, runId: queued.runId });
          return { requestId: queued.id, runId: queued.runId, ...(record(result) ? result : { result }) };
        }
        return adapter.invoke(managed.id, name, page);
      }
      return adapter.invoke(managed.id, name, args);
    } };
  }
  #workflowRequestView(request: QueuedWorkflowRequest) {
    return { requestId: request.id, status: request.status, target: request.request.target, templateId: request.request.templateId, workflowId: request.request.workflowId, revision: request.request.revision, ...(request.runId ? { runId: request.runId } : {}), ...(request.error ? { error: request.error } : {}) };
  }
  async #drainWorkflowRequest(managed: ManagedSession, request: QueuedWorkflowRequest): Promise<void> {
    managed.workflowDraining = true;
    try {
      this.#assertIdle(managed);
      if (managed.executionEpoch !== request.epoch || managed.pendingConfiguration) throw new ConsoleGatewayError("The chat configuration changed after this workflow was queued. Queue it again using the current context.", 409);
      if (request.abort.signal.aborted) { request.status = "cancelled"; return; }
      request.status = "awaiting-approval";
      const response = await this.#requestDecision(managed, {
        kind: "tool", title: request.request.allowApply ? "Launch workflow and permit reviewed changes?" : "Launch queued workflow?",
        detail: `Run ${request.request.templateId ?? request.request.workflowId} revision ${request.request.revision} against ${request.request.target}.${request.request.allowApply ? " This request permits the workflow's apply step to write inside its approved source workspace." : " Apply capability is disabled."}`,
        call: this.#withCallId({ name: "start_run", arguments: request.request }),
      }, request.id, request.abort.signal);
      if (!response.approve || request.abort.signal.aborted) { request.status = "cancelled"; return; }
      this.#assertIdle(managed);
      if (managed.executionEpoch !== request.epoch || managed.pendingConfiguration) throw new ConsoleGatewayError("The workflow owner changed while awaiting launch approval.", 409);
      request.status = "starting";
      const started = await this.#workflowLifecycle!.invoke(managed.id, "start_run", request.request, { allowApply: request.request.allowApply === true });
      if (!record(started) || typeof started.runId !== "string") throw new ConsoleGatewayError("Workflow launch did not return a run ID.", 500);
      request.runId = started.runId;
      if (request.abort.signal.aborted || managed.status === "closed" || managed.executionEpoch !== request.epoch) {
        await this.#workflowLifecycle!.invoke(managed.id, "cancel_run", { runId: request.runId });
        request.status = "cancelled";
        return;
      }
      request.status = "launched";
      this.#emit(managed, { type: "notice", text: `Workflow request ${request.id} started run ${request.runId}.` });
    } catch (error) {
      request.status = request.abort.signal.aborted ? "cancelled" : "failed";
      request.error = errorMessage(error);
      if (managed.status !== "closed") this.#emit(managed, { type: "notice", text: `Workflow request ${request.id} ${request.status}: ${request.error}` });
    } finally {
      managed.workflowDraining = false;
      this.#refreshStatus(managed);
      void this.#processIdleWork(managed);
    }
  }
  async #processIdleWork(managed: ManagedSession): Promise<void> {
    if (managed.status === "closed" || managed.status === "working" || managed.turn || managed.initialization || managed.configuration || managed.pending.size || managed.workflowDraining) return;
    try {
      if (managed.pendingConfiguration) await this.#applyPendingConfiguration(managed);
      if (!managed.pendingConfiguration && !managed.queued.length) {
        const request = [...managed.workflowRequests.values()].find(item => item.status === "queued");
        if (request) { await this.#drainWorkflowRequest(managed, request); return; }
      }
      if (managed.pauseQueue || managed.pendingConfiguration || !managed.queued.length) return;
      const next = managed.queued.shift()!;
      this.#emit(managed, { type: "queued", messages: structuredClone(managed.queued) });
      try { await this.#startTurn(managed, next.text, next.author); }
      catch (error) {
        managed.queued.unshift(next); managed.pauseQueue = true;
        this.#emit(managed, { type: "queued", messages: structuredClone(managed.queued) });
        this.#emit(managed, { type: "error", message: errorMessage(error) });
      }
    } catch (error) { this.#emit(managed, { type: "error", message: errorMessage(error) }); }
  }
  #outcome(outcome: EngineTurnOutcome): ConsoleTurnOutcome {
    return { assistantText: outcome.assistantText, stopReason: outcome.stopReason, budget: { ...outcome.budget, tokenBudget: Number.isFinite(outcome.budget.tokenBudget) ? outcome.budget.tokenBudget : null }, usage: { ...outcome.usage }, ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.contextInputTokens !== undefined ? { contextInputTokens: outcome.contextInputTokens } : {}), ...(outcome.outputCap ? { outputCap: { ...outcome.outputCap, checkpoint: json(outcome.outputCap.checkpoint) } } : {}) };
  }
  #cancelTurn(managed: ManagedSession): void {
    for (const request of managed.workflowRequests.values()) if (request.turnOwner === managed.turnOwner && request.status === "queued") { request.abort.abort(); request.status = "cancelled"; }
    managed.abort?.abort(); this.#denyDecisions(managed, managed.turnOwner ?? undefined);
    this.#emit(managed, { type: "notice", text: managed.execution.backend === "smolvm" ? "Cancellation requested. The VM run is being stopped; results and teardown status will be retained." : "Cancellation requested. An executing tool finishes at its next safe boundary; the conversation and authorization remain intact." }); this.#refreshStatus(managed);
  }
  async #applyPendingConfiguration(managed: ManagedSession): Promise<void> {
    if (managed.configuration) return managed.configuration;
    const input = managed.pendingConfiguration; if (!input) return;
    const operation = (async () => {
      if ((input.target !== undefined || input.scope !== undefined) && [...managed.workers.values()].some((worker) => Object.hasOwn(ACTIVE_WORKERS, worker.status))) throw new ConsoleGatewayError("Drain owned workers before changing the engagement target or scope.", 409);
      if (input.workspacePath !== undefined) {
        const session = await this.#ensureSession(managed);
        const directory = input.workspacePath;
        const response = await this.#requestDecision(managed, { kind: "local-scope", title: "Use this workspace folder?", detail: "0 will run from this folder and have access to its contents for this session.", requestedPath: directory, currentScopePath: session.localScopePath }, "workspace");
        if (response.approve && managed.status !== "closed") {
          if ([...managed.workers.values()].some(worker => Object.hasOwn(ACTIVE_WORKERS, worker.status))) throw new ConsoleGatewayError("Stop active agents before changing the workspace folder.", 409);
          // Revalidate after approval: the folder may have changed while the prompt was open.
          if (realpathSync(directory) !== directory || !statSync(directory).isDirectory() || isDangerousLocalRoot(directory)) throw new ConsoleGatewayError("The workspace folder changed. Choose it again.", 409);
          session.configureWorkspace(directory);
          managed.workspacePath = directory;
        }
      }
      if (!managed.session) {
        if (input.target !== undefined) managed.target = input.target;
        if (input.scope !== undefined) managed.scope = input.scope === null ? undefined : ScopePolicy.fromJson(input.scope);
        if (input.autonomyMode) managed.autonomyMode = input.autonomyMode;
      }
      if (managed.session && (input.target !== undefined || input.scope !== undefined)) {
        managed.session.configureEngagement({
          ...(input.target !== undefined ? { target: input.target } : {}),
          ...(input.scope !== undefined ? { scope: input.scope === null ? null : ScopePolicy.fromJson(input.scope) } : {}),
        });
      }
      if (input.runtime) {
        if (!managed.session) managed.selection = { ...managed.selection, ...input.runtime };
        await this.#ensureSession(managed);
        if (managed.runtime) {
          const info = await applyWebConsoleRuntimeSelection(managed.runtime, input.runtime); managed.info = info;
          managed.session?.reconfigureRuntime({ contextWindowTokens: info.contextWindowTokens });
          managed.selection = { ...managed.selection, ...input.runtime };
        } else managed.session?.reconfigureRuntime({ ...input.runtime, ...(input.runtime.providerId ? { provider: input.runtime.providerId } : {}) });
      }
      if (input.target !== undefined) managed.target = input.target;
      if (input.scope !== undefined) managed.scope = input.scope === null ? undefined : ScopePolicy.fromJson(input.scope);
      if (input.autonomyMode) { managed.autonomyMode = input.autonomyMode; managed.session?.setAutonomyMode(input.autonomyMode); }
      if (managed.pendingConfiguration === input) managed.pendingConfiguration = undefined;
      if (managed.status !== "closed" && !managed.turn) managed.status = "ready";
      this.#emitSession(managed); this.#save(managed);
    })();
    managed.configuration = operation;
    try { await operation; } finally { if (managed.configuration === operation) managed.configuration = null; }
  }
  #requestDecision(managed: ManagedSession, input: Omit<DesktopConsoleDecision, "id" | "context" | "ownerId">, ownerId: string, signal?: AbortSignal, validate?: PendingDecision["validate"]): Promise<DesktopConsoleDecisionResponse> {
    if (managed.status === "closed" || signal?.aborted) return Promise.resolve({ approve: false });
    const deferred = Promise.withResolvers<DesktopConsoleDecisionResponse>();
    const decision: DesktopConsoleDecision = { ...input, id: this.#createId(), ownerId, context: { target: managed.session?.target ?? managed.target, role: managed.role, autonomyMode: managed.session?.autonomyMode ?? managed.autonomyMode, scopeEnforcement: { ...(ownerId === managed.turnOwner && managed.session ? managed.session.scopeEnforcement : getScopeEnforcementState(this.#projectPath, this.#options.homeDir)) }, ...(managed.session?.localScopePath ? { localScopePath: managed.session.localScopePath } : {}) } };
    const onAbort = () => { const pending = managed.pending.get(decision.id); if (!pending) return; managed.pending.delete(decision.id); pending.resolve({ approve: false }); this.#emit(managed, { type: "decision-resolved", decisionId: decision.id, approved: false }); this.#refreshStatus(managed); };
    managed.pending.set(decision.id, { decision, ...(validate ? { validate } : {}), resolve: (response) => { signal?.removeEventListener("abort", onAbort); deferred.resolve(response); } });
    signal?.addEventListener("abort", onAbort, { once: true }); managed.status = "waiting"; this.#emitSession(managed); this.#emit(managed, { type: "decision", decision });
    return deferred.promise;
  }
  #denyDecisions(managed: ManagedSession, ownerId?: string): void {
    for (const [id, pending] of managed.pending) if (ownerId === undefined || pending.decision.ownerId === ownerId) { managed.pending.delete(id); pending.resolve({ approve: false }); this.#emit(managed, { type: "decision-resolved", decisionId: id, approved: false }); }
  }
  #refreshStatus(managed: ManagedSession): void {
    if (managed.status !== "closed") managed.status = managed.pending.size ? "waiting" : managed.turn || managed.initialization ? "working" : managed.status === "failed" ? "failed" : "ready";
    this.#emitSession(managed);
  }
  #subscribeBus(managed: ManagedSession): void {
    if (managed.busUnsubscribe) return;
    managed.busUnsubscribe = eventBus.subscribe({ emit: (type, payload) => {
      if (managed.status === "closed" || !record(payload)) return;
      const parent = payload.parent_scan_id; const producer = payload.scan_id ?? payload.scanId;
      if (typeof parent === "string") { if (!managed.ownedIds.has(parent)) return; }
      else if (typeof producer !== "string" || !managed.ownedIds.has(producer)) return;
      if (typeof producer === "string" && !managed.ownedIds.has(producer)) return;
      if (["subagent_lifecycle", "subagent_progress", "subagent_message"].includes(type)) {
        const id = payload.agent_id; if (typeof id !== "string" || typeof parent !== "string") return;
        let worker = managed.workers.get(id);
        if (!worker) { worker = { id, parentId: parent, name: typeof payload.name === "string" ? payload.name : "Worker", status: "queued", task: typeof payload.task === "string" ? payload.task : "", transcript: [] }; managed.workers.set(id, worker); managed.ownedIds.add(id); }
        worker.telemetry = { ...worker.telemetry, ...(json(payload) as Record<string, ConsoleJsonValue>) };
        if (type === "subagent_lifecycle") {
          if (typeof payload.status === "string" && ["queued", "running", "parked", "completed", "failed"].includes(payload.status)) worker.status = payload.status as ConsoleWorker["status"];
          for (const [source, key] of [["name", "name"], ["task", "task"], ["summary", "summary"], ["error", "error"], ["model", "model"], ["role", "role"]] as const) if (typeof payload[source] === "string") worker[key] = payload[source];
          if (worker.summary || worker.error) {
            const final = worker.error ?? worker.summary!;
            if (!worker.transcript.some((entry) => entry.assistant === final)) worker.transcript.push({ turn: typeof payload.turns === "number" ? payload.turns : worker.transcript.length + 1, ts: this.#now().getTime(), assistant: final });
          }
        } else if (type === "subagent_message" && typeof payload.turn === "number" && typeof payload.ts === "number") {
          const index = worker.transcript.findIndex((entry) => entry.turn === payload.turn);
          if (index >= 0 && !worker.transcript[index]!.partial && payload.partial) return;
          const entry = { turn: payload.turn, ts: payload.ts, ...(typeof payload.assistant === "string" ? { assistant: payload.assistant } : {}), ...(typeof payload.reasoning_summary === "string" ? { reasoning_summary: payload.reasoning_summary } : {}), ...(typeof payload.partial === "boolean" ? { partial: payload.partial } : {}), ...(Array.isArray(payload.tools) ? { tools: payload.tools.flatMap((tool) => {
            if (!record(tool) || !record(tool.call) || typeof tool.call.name !== "string" || !record(tool.call.arguments) || typeof tool.callIndex !== "number") return [];
            return [{ callIndex: tool.callIndex, call: this.#withCallId(tool.call as unknown as ToolCall), result: json(tool.result), ...(typeof tool.running === "boolean" ? { running: tool.running } : {}) }];
          }) } : {}) };
          if (index >= 0) worker.transcript[index] = entry; else worker.transcript.push(entry);
        }
        this.#emitWorker(managed, worker, type === "subagent_progress" ? undefined : typeof payload.turn === "number" ? payload.turn : worker.transcript.at(-1)?.turn);
      } else if (type === "session_objective" && producer === managed.id && typeof payload.objective === "string") {
        managed.objective = payload.objective; this.#emit(managed, { type: "state", objective: managed.objective, todos: structuredClone(managed.todos) });
      } else if (type === "todos" && producer === managed.id && Array.isArray(payload.todos)) {
        const todos = payload.todos.flatMap((todo) => record(todo) && typeof todo.id === "string" && typeof todo.content === "string" && typeof todo.status === "string" ? [{ id: todo.id, content: todo.content, status: todo.status, ...(typeof todo.group === "string" ? { group: todo.group } : {}) }] : []);
        managed.todos = { todos, done: typeof payload.done === "number" ? payload.done : todos.filter((todo) => todo.status === "completed").length, total: todos.length, line: typeof payload.line === "string" ? payload.line : "", revision: typeof payload.revision === "number" ? payload.revision : 0 };
        this.#emit(managed, { type: "state", objective: managed.objective, todos: structuredClone(managed.todos) });
      }
    } });
  }
  #nativeSavedMessages(messages: unknown[]): NativeMessage[] {
    for (const message of messages) {
      if (!record(message) || (message.role !== "user" && message.role !== "assistant") || !Array.isArray(message.content)) throw new ConsoleGatewayError("Saved transcript contains an invalid native message.", 400);
      for (const block of message.content) {
        if (!record(block) ||
          (block.type === "text" ? typeof block.text !== "string" :
            block.type === "tool_use" ? typeof block.id !== "string" || typeof block.name !== "string" || !record(block.input) :
              block.type === "tool_result" ? typeof block.tool_use_id !== "string" || typeof block.content !== "string" || (block.is_error !== undefined && typeof block.is_error !== "boolean") : true)) {
          throw new ConsoleGatewayError("Saved transcript contains an invalid native content block.", 400);
        }
      }
    }
    // Private provider envelopes are retained for faithful runtime replay, but
    // neither messages nor providerRaw are ever interpreted as authorization.
    return structuredClone(messages) as NativeMessage[];
  }
  #emitWorker(managed: ManagedSession, worker: ConsoleWorker, turn?: number, operatorMessage?: ConsoleQueuedMessage): void {
    const { transcript, operatorMessages: _messages, ...roster } = worker;
    const latest = turn === undefined ? undefined : transcript.find((entry) => entry.turn === turn);
    this.#emit(managed, { type: "worker", incremental: true, worker: structuredClone({ ...roster, transcript: latest ? [latest] : [], ...(operatorMessage ? { operatorMessages: [operatorMessage] } : {}) }) });
  }
  #stored(id: string): StoredSession {
    if (!isValidSessionId(id)) throw new ConsoleGatewayError("Invalid saved session ID.", 400);
    const stored = loadSession(id, this.#options.homeDir); if (!stored) throw new ConsoleGatewayError("Saved transcript was not found.", 404); return stored;
  }
  #save(managed: ManagedSession): boolean {
    const messages = managed.session?.messages ?? managed.initialMessages;
    const id = managed.savedId ?? managed.id;
    const consoleState: StoredConsoleState = {
      configuration: {
        target: managed.session?.target ?? managed.target, role: managed.role,
        runtime: savedWebRuntimeSelection(managed.selection, managed.info),
      },
      version: 1, title: managed.title, objective: managed.objective, usage: { ...managed.usage },
      ...(managed.contextInputTokens !== undefined ? { contextInputTokens: managed.contextInputTokens } : {}),
      lastOutcome: managed.lastOutcome as StoredConsoleState["lastOutcome"], todos: managed.todos,
      workers: this.workers(managed.id) as StoredConsoleState["workers"], compaction: managed.compaction,
      queuedMessages: structuredClone(managed.queued),
      userAttributions: structuredClone(managed.userAttributions),
      ...(managed.focusedFinding ? { focusedFindingId: managed.focusedFinding.id } : {}),
      ...(managed.stagedPrompt ? { stagedPrompt: managed.stagedPrompt } : {}),
    };
    const saved = saveSession({ id, savedAt: this.#now().getTime(), cwd: managed.workspacePath ?? this.#projectPath, target: managed.session?.target ?? managed.target, ...(managed.info ? { model: managed.info.model } : {}), mode: managed.session?.autonomyMode ?? managed.autonomyMode, messageCount: messages.length, preview: "", summary: managed.title, messages: [...messages], consoleState }, this.#options.homeDir);
    if (!saved) this.#emit(managed, { type: "notice", text: "Private transcript could not be saved; the live conversation is still intact." });
    return saved;
  }
  #withCallId(call: ToolCall): DesktopConsoleToolCall { let id = this.#callIds.get(call); if (!id) { id = this.#createId(); this.#callIds.set(call, id); } return { id, name: call.name, arguments: json(call.arguments) }; }
  #summary(managed: ManagedSession): DesktopConsoleSession {
    return { id: managed.id, ...(managed.savedId ? { savedId: managed.savedId } : {}), target: managed.session?.target ?? managed.target, role: managed.role, autonomyMode: managed.session?.autonomyMode ?? managed.autonomyMode, scopeConfigured: Boolean(managed.session?.scope ?? managed.scope), localScopeConfigured: Boolean(managed.session?.localScopePath), status: managed.status, createdAt: managed.createdAt, updatedAt: managed.updatedAt, title: managed.title, messageCount: (managed.session?.messages ?? managed.initialMessages).length + managed.queued.length, execution: structuredClone(managed.execution), ...(managed.info ? { runtime: structuredClone(managed.info) } : {}), ...(managed.pendingConfiguration ? { pendingConfiguration: structuredClone(managed.pendingConfiguration) } : {}) };
  }
  #emitSession(managed: ManagedSession): void { this.#emit(managed, { type: "session", session: this.#summary(managed) }); }
  #emit(managed: ManagedSession, payload: DesktopConsoleEventPayload): void {
    const event: DesktopConsoleEvent = { ...payload, schemaVersion: DESKTOP_CONSOLE_SCHEMA_VERSION, sessionId: managed.id, sequence: ++managed.sequence, occurredAt: this.#now().toISOString() };
    managed.updatedAt = event.occurredAt; managed.events.push(event); if (managed.events.length > MAX_EVENTS) managed.events.splice(0, managed.events.length - MAX_EVENTS);
    for (const listener of managed.listeners) { try { listener(structuredClone(event)); } catch { /* A disconnected client cannot interrupt an engine turn. */ } }
  }
  #require(id: string): ManagedSession { if (typeof id !== "string" || !isValidSessionId(id)) throw new ConsoleGatewayError("Invalid console session ID.", 400); const managed = this.#sessions.get(id); if (!managed) throw new ConsoleGatewayError("Console session was not found.", 404); return managed; }
  #requireOpen(id: string): ManagedSession { const managed = this.#require(id); if (managed.status === "closed") throw new ConsoleGatewayError("Console session is closed.", 410); return managed; }
}
