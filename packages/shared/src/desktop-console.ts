import type { HarnessSnapshot } from "./live-harness.js";
import type { Finding } from "./types.js";

/**
 * Renderer-neutral contract between the browser and the local console daemon.
 * It contains only JSON-safe values: clients never receive a live tool, scope,
 * credential, or runtime object.
 */
export const DESKTOP_CONSOLE_SCHEMA_VERSION = 1 as const;

export type DesktopConsoleAutonomyMode = "standard" | "recon" | "copilot" | "yolo";

/** Product default autonomy mode: YOLO. Explicit flags/settings win. */
export const DEFAULT_AUTONOMY_MODE: DesktopConsoleAutonomyMode = "yolo";

/** Product default for allowModelSelfExtension in non-verify sessions. */
export const DEFAULT_ALLOW_MODEL_SELF_EXTENSION = true;
export type DesktopConsoleRole = "discovery" | "attack" | "verify" | "report" | "audit" | "review";
export type DesktopConsoleSessionStatus = "ready" | "working" | "waiting" | "closed" | "failed";

export type DesktopCodexAuthPhase = "idle" | "running" | "connected" | "cancelled" | "failed" | "unavailable";

export interface DesktopCodexAuthStatus {
  phase: DesktopCodexAuthPhase;
  message: string;
  lines: readonly string[];
}

export interface DesktopConsoleSession {
  /** Original durable conversation, when this engine resumes saved work. */
  savedId?: string;
  id: string;
  target: string;
  role: DesktopConsoleRole;
  autonomyMode: DesktopConsoleAutonomyMode;
  scopeConfigured: boolean;
  localScopeConfigured: boolean;
  status: DesktopConsoleSessionStatus;
  createdAt: string;
  updatedAt: string;
  title?: string;
  /** Transcript messages plus queued operator messages; 0 means the conversation is still blank. */
  messageCount?: number;
  runtime?: ConsoleRuntimeSnapshot;
  pendingConfiguration?: ConsoleSessionConfiguration;
}

export interface DesktopConsoleToolCall {
  id?: string;
  name: string;
  arguments: unknown;
}

export interface DesktopConsoleUsage {
  inputTokens: number;
  outputTokens: number;
  turnTokensUsed: number;
  /** null explicitly means an unlimited budget. */
  turnTokenBudget: number | null;
  iterations: number;
  maxToolIterations: number;
  kind?: "planner" | "plugin" | "compaction";
}

export interface DesktopConsoleTurnBudget {
  tokensUsed: number;
  /** null explicitly means an unlimited budget. */
  tokenBudget: number | null;
  iterations: number;
  maxToolIterations: number;
}

export interface DesktopConsoleOperatorOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface DesktopConsoleOperatorQuestion {
  header: string;
  question: string;
  options?: DesktopConsoleOperatorOption[];
  multiSelect?: boolean;
  allowCustom?: boolean;
}

export type DesktopConsoleDecisionKind = "tool" | "scope" | "local-scope" | "audit-escalation" | "operator-question";

export interface DesktopConsoleDecision {
  id: string;
  kind: DesktopConsoleDecisionKind;
  title: string;
  detail: string;
  call?: DesktopConsoleToolCall;
  requestedUrls?: string[];
  requestedPath?: string;
  questions?: DesktopConsoleOperatorQuestion[];
  risk?: { level: "destructive" | "unknown"; category?: string };
  reason?: string;
  unresolvedTargets?: string[];
  currentScope?: ConsoleScope | null;
  currentScopePath?: string;
  ownerId?: string;
  context?: {
    target: string;
    role: DesktopConsoleRole;
    autonomyMode: DesktopConsoleAutonomyMode;
    scopeEnforcement: ConsoleScopeEnforcement;
    localScopePath?: string;
  };
}

export interface DesktopConsoleOperatorAnswer {
  header: string;
  selectedLabels?: string[];
  customText?: string;
}

export interface DesktopConsoleDecisionResponse {
  approve: boolean;
  answers?: DesktopConsoleOperatorAnswer[];
}

interface DesktopConsoleEventBase {
  schemaVersion: typeof DESKTOP_CONSOLE_SCHEMA_VERSION;
  sessionId: string;
  sequence: number;
  occurredAt: string;
}

export type DesktopConsoleEventPayload =
  | { type: "session"; session: DesktopConsoleSession }
  | { type: "user"; text: string }
  | { type: "assistant-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-start"; call: DesktopConsoleToolCall }
  | { type: "tool-result"; call: DesktopConsoleToolCall; result: unknown }
  | { type: "usage"; usage: DesktopConsoleUsage }
  | { type: "notice"; text: string }
  | { type: "decision"; decision: DesktopConsoleDecision }
  | { type: "decision-resolved"; decisionId: string; approved: boolean }
  | ({ type: "turn-complete" } & ConsoleTurnOutcome)
  | { type: "error"; message: string }
  | { type: "snapshot"; snapshot: ConsoleSessionSnapshot }
  | { type: "clear" }
  | { type: "worker"; worker: ConsoleWorker; incremental?: boolean }
  | { type: "queued"; messages: ConsoleQueuedMessage[] }
  | { type: "state"; objective: string; todos: ConsoleTodos | null }
  | { type: "harness"; harness: HarnessSnapshot }
  | { type: "compaction"; compaction: ConsoleJsonValue };

export type DesktopConsoleEvent = DesktopConsoleEventBase & DesktopConsoleEventPayload;

export type ConsoleJsonValue = null | boolean | number | string | ConsoleJsonValue[] | { [key: string]: ConsoleJsonValue };

export interface ConsoleRuntimeSelection {
  reasoningEffort?: string;
  providerId?: string;
  model?: string;
  agentModels?: Record<string, string>;
  singleModel?: boolean;
  autoRoute?: boolean;
}

export interface ConsoleRuntimeSnapshot {
  reasoning?: { effort: string; options: string[] } | null;
  providerId: string;
  providerLabel: string;
  model: string;
  configured: boolean;
  connectionIdentity: string | null;
  diagnostics: { valid: boolean; reason: string | null; message: string | null };
  agentModels: Record<string, string>;
  singleModel: boolean;
  autoRoute: boolean;
  contextWindowTokens: number | null;
}

export interface ConsoleScope {
  in_scope?: string[];
  out_of_scope?: string[];
  attribution?: { headers?: Record<string, string>; user_agent_token?: string };
}

export interface ConsoleScopeEnforcement {
  pluginId: string;
  enabled: boolean;
  projectPath: string;
  message: string;
}

export interface ConsoleSessionConfiguration {
  workspacePath?: string;
  title?: string;
  target?: string;
  autonomyMode?: DesktopConsoleAutonomyMode;
  scope?: ConsoleScope | null;
  runtime?: ConsoleRuntimeSelection;
}

export interface ConsolePublicMessage {
  role: "user" | "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, ConsoleJsonValue> }
    | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  >;
}

export interface ConsoleTurnOutcome {
  assistantText: string;
  stopReason: string;
  budget: DesktopConsoleTurnBudget;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
  contextInputTokens?: number;
  outputCap?: { checkpoint: ConsoleJsonValue; continuations: number; message: string };
}

export interface ConsoleQueuedMessage {
  id: string;
  text: string;
  createdAt: string;
}

export interface ConsoleWorkerTurn {
  turn: number;
  ts: number;
  assistant?: string;
  reasoning_summary?: string;
  partial?: boolean;
  tools?: Array<{ callIndex: number; call: DesktopConsoleToolCall; result: ConsoleJsonValue; running?: boolean }>;
}

export interface ConsoleWorker {
  id: string;
  parentId: string;
  name: string;
  status: "queued" | "running" | "parked" | "completed" | "failed" | "stopped";
  task: string;
  transcript: ConsoleWorkerTurn[];
  operatorMessages?: ConsoleQueuedMessage[];
  telemetry?: Record<string, ConsoleJsonValue>;
  summary?: string;
  error?: string;
  model?: string;
  role?: string;
}

export interface ConsoleTodos {
  todos: Array<{ id: string; content: string; status: string; group?: string }>;
  done: number;
  total: number;
  line: string;
  revision: number;
}

export interface ConsoleSavedSession {
  archived?: boolean;
  id: string;
  savedAt: number;
  cwd: string;
  messageCount: number;
  preview: string;
  target?: string;
  model?: string;
  mode?: string;
  summary?: string;
}

export interface ConsoleSessionSnapshot {
  session: DesktopConsoleSession;
  title: string;
  cursor: number;
  messages: ConsolePublicMessage[];
  events: DesktopConsoleEvent[];
  pendingDecisions: DesktopConsoleDecision[];
  workers: ConsoleWorker[];
  queuedMessages: ConsoleQueuedMessage[];
  runtime: ConsoleRuntimeSnapshot | null;
  scope: ConsoleScope | null;
  scopeEnforcement: ConsoleScopeEnforcement;
  localScopePath?: string;
  workspacePath?: string;
  usage: { inputTokens: number; outputTokens: number; costUsd?: number; costKind?: "estimated" | "reported"; costUnavailable?: boolean };
  contextInputTokens?: number;
  contextWindowTokens?: number;
  lastOutcome: ConsoleTurnOutcome | null;
  compaction: ConsoleJsonValue | null;
  harness: HarnessSnapshot | null;
  objective: string;
  todos: ConsoleTodos | null;
  tools: Array<{ name: string; description: string; inputSchema: ConsoleJsonValue }>;
  pendingConfiguration?: ConsoleSessionConfiguration;
  focusedFinding?: Finding;
  stagedPrompt?: string;
}

export interface ConsoleEventsPage {
  events: DesktopConsoleEvent[];
  cursor: number;
  gap: boolean;
  snapshot?: ConsoleSessionSnapshot;
}

export interface ConsoleCreateSessionInput {
  target?: string;
  role?: DesktopConsoleRole;
  autonomyMode?: DesktopConsoleAutonomyMode;
  title?: string;
  scope?: ConsoleScope;
  runtime?: ConsoleRuntimeSelection;
  findingId?: string;
  findingIntent?: "investigate" | "verify" | "draft_fix" | "impact";
}

export interface ConsoleMessageInput {
  text: string;
  mode?: "send" | "queue" | "steer";
  workerId?: string;
  /** References to daemon-local paths or text, not browser uploads or multimodal bytes. */
  attachments?: Array<{ kind: "path" | "text"; value: string }>;
}

export interface ConsolePublicExport {
  text: string;
  messages: ConsolePublicMessage[];
  source?: "canonical-root-history" | "published-worker-trace";
}
