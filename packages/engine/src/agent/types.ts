import type { WorkerPolicy } from "../workflow-execution-policy.js";
import type { WorkspaceIdentity } from "./workspace-identity.js";
import type { ApprovalsChoice } from "../shared/approvals.js";
import type { Finding, AttackResult, TargetInfo, AuthConfig } from "../shared/index.js";
import type { LootLedger } from "./loot.js";
import type { ScanCostLedger } from "./cost-ledger.js";
import type { ToolHealthTracker } from "./tool-health.js";

// ── Agent Roles ──

export type AgentRole = "discovery" | "attack" | "verify" | "report" | "audit" | "review";

// ── Tool Definitions ──

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParam>;
  required?: string[];
}

export interface ToolParam {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  enum?: string[];
  /** Nested JSON-schema object contracts, forwarded unchanged to the runtime. */
  properties?: Record<string, ToolParam>;
  required?: string[];
  additionalProperties?: boolean;
  /**
   * JSON-schema `items` for `type: "array"` params (e.g. `spawn_agents`'
   * `tasks` list). Passed through verbatim into the tool's `input_schema` so
   * the model receives a properly typed array-of-objects. Omit for scalar
   * params.
   */
  items?: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * A bounded, static classification of a destructive operation. The
 * operator-facing label for each is a fixed string derived from this enum, so
 * the approval surface can name the danger WITHOUT echoing the command text
 * (which may carry secrets). New members are added deliberately, never derived
 * from free text.
 */
export type DestructiveCategory =
  | "recursive-delete"
  | "disk-write"
  | "filesystem-format"
  | "process-kill"
  | "repo-history-rewrite";

/**
 * The risk levels the classifier emits. There is deliberately NO `"safe"`:
 * an arbitrary shell invocation whose effect cannot be POSITIVELY verified as
 * destructive stays `"unknown"`, never downgraded to a safety claim. Only a
 * positively-matched destructive operation is `"destructive"`. `"unknown"` is
 * therefore the honest default, distinct from safe.
 */
export type ToolRiskLevel = "destructive" | "unknown";

/**
 * A risk assessment carried ALONGSIDE a {@link ToolCall} at the approval
 * boundary — a sibling value, never a mutation of the call. It is
 * PRESENTATION-ONLY: it changes how an approval is surfaced to the operator
 * (a distinct tone + glyph, a deny-first selection) and NEVER whether the gate
 * is raised or what is authorized. A `"destructive"` result is a
 * cue to look carefully, not a claim that every destructive command is caught
 * — obfuscated or unrecognized commands remain `"unknown"` and still gate
 * normally.
 */
export interface ToolRisk {
  level: ToolRiskLevel;
  /** Set only when `level === "destructive"`; identifies the matched category. */
  category?: DestructiveCategory;
}

export interface ToolResult {
  success: boolean;
  output: unknown;
  error?: string;
  /**
   * OPTIONAL display-only sidecar for a rich UI (the TUI command/edit cards).
   *
   * This field is NEVER serialized back into the model's `tool_result` content:
   * both loop serializers read only `output`/`error` — `native-loop.ts` does
   * `JSON.stringify(toolResult.output)` (or `Error: ${error}`) and the console
   * `turn-engine.ts`'s `stringifyToolResult` likewise touches only
   * `output`/`error`. `meta` therefore cannot change what the model sees; it
   * exists purely so the operator-facing surface can draw a richer card than
   * the model-facing string carries. Every existing caller is unaffected
   * because the field is optional.
   */
  meta?: ToolResultMeta;
}

/**
 * Display-only metadata a tool may attach to its {@link ToolResult} so the TUI
 * can render a rich card. NOT seen by the model (see {@link ToolResult.meta}).
 */
export interface ToolResultMeta {
  /** Action-time browser state. A captured frame is a snapshot, not a video feed. */
  browser?: {
    sessionId: string;
    pageId?: string;
    tab: string;
    url?: string;
    title?: string;
    capturedAt: string;
    closed?: boolean;
    tabs: Array<{ pageId: string; tab: string; url: string }>;
  };
  /**
   * Which card the UI should draw. `command` → bash; `edit` → str_replace;
   * `web` → web_search; `image` → an inline screenshot.
   */
  kind?: "command" | "edit" | "web" | "task" | "code" | "image";
  // ── command card ──
  /** The command that was executed (header line `$ <command>`). */
  command?: string;
  /** Process exit code; `null` when unknown (timed out / killed by signal). */
  exitCode?: number | null;
  /** Wall-clock duration of the call, in milliseconds. */
  durationMs?: number;
  /** The timeout ceiling applied to the call, in milliseconds. */
  timeoutMs?: number;
  /** True when the call was terminated by the wallclock timeout. */
  timedOut?: boolean;
  /** The (possibly truncated) combined stdout/stderr, for the card body. */
  stdout?: string;
  // ── edit card ──
  /** Path(s) edited (header line `✎ Edit: <path>`). */
  path?: string;
  /** Lines added by the edit. */
  added?: number;
  /** Lines removed by the edit. */
  removed?: number;
  /** A diff body (hunk lines) for the card, when available. */
  diff?: string;
  // ── image card (kind: "image") ──
  /**
   * An inline image the tool captured — a browser screenshot, chiefly. The
   * base64 payload is display-only (like the whole `meta` sidecar) and is
   * NEVER serialized into the model's tool_result, so the full-resolution PNG
   * can ride here without inflating the model-facing string. The TUI renders
   * it as an ImageCard (dimensions + inline draw where the terminal supports
   * it, a compact caption placeholder otherwise).
   */
  image?: {
    /** Base64 PNG/image bytes, no `data:` prefix. */
    imageBase64: string;
    /** Media type, e.g. "image/png". */
    mimeType: string;
    /** Pixel width, decoded from the image header. */
    width: number;
    /** Pixel height, decoded from the image header. */
    height: number;
    /** Optional caption (e.g. the page URL the shot was taken on). */
    caption?: string;
  };
  // ── web card ──
  /** Search provider name (header line `⌕ Web Search: <provider>`). */
  provider?: string;
  /** The search query that was run. */
  query?: string;
  /** A short answer/summary, when the provider returns one. Absent otherwise. */
  answer?: string;
  /** The result sources: title (optional), url, and an optional relative age. */
  sources?: Array<{ title?: string; url: string; age?: string }>;
  // ── task card (subagent launch: spawn_agents) ──
  /**
   * Card title suffix — e.g. the batch label or single agent name. Rendered
   * after the `Task` headline as `Task • <label>`.
   */
  taskLabel?: string;
  /**
   * Batch shared-context Markdown — the model-authored `# Goal / # Constraints
   * / # Contract` headings (mirrors OMP's freeform `context` string). Stored
   * verbatim; the renderer splits it on those H1 headings into sections.
   */
  taskContext?: string;
  /**
   * Optional pre-split sections when a producer already parsed them out. When
   * present the renderer draws these instead of re-parsing {@link taskContext}.
   */
  goal?: string;
  constraints?: string;
  contract?: string;
  /**
   * Per-agent assignment brief Markdown (single-agent `# Target / # Change /
   * # Acceptance`). Mirrors OMP's freeform `task` string.
   */
  assignment?: string;
  /** The dispatched sub-reports — one bullet each (mirrors OMP's task item rows). */
  subReports?: Array<{
    /** e.g. "ExtensionReadiness" — rendered bold/accent. */
    name: string;
    /** e.g. "scout" — rendered as a `(…)` badge. */
    agent?: string;
    /** Task first line, rendered muted after the name. */
    brief?: string;
    /** True → `[isolated]` suffix (dedicated worktree). */
    isolated?: boolean;
  }>;
  // ── code card (js_eval / python_eval) ──
  /** Highlighter language for the code block. */
  language?: "javascript" | "python";
  /** The source that was evaluated (rendered as a syntax-highlighted block). */
  code?: string;
  /** The evaluated program's combined stdout/stderr (the Output section). */
  output?: string;
  // `durationMs` (execution time, header badge) and `exitCode` above are reused.
}

// ── Operator question channel (`ask_operator`) ──

/**
 * One selectable option offered alongside an {@link OperatorQuestion}.
 *
 * The model authors these (they are not attacker-influenced) so the operator
 * gets concrete, low-friction choices instead of a free-text prompt. `label` is
 * the short choice text; `description` optionally elaborates; `recommended`
 * marks the option the model would pick, purely as a display hint.
 */
export interface OperatorQuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

/**
 * A single structured question the model puts to the human operator via the
 * `ask_operator` tool. `header` is a short title for the prompt; `question` is
 * the full prose. When `options` are present the operator picks from them
 * (`multiSelect` allows more than one); `allowCustom` additionally permits a
 * free-text answer. This is an INFORMATION-GATHERING structure only — answering
 * it grants no authority and approves no tool.
 */
export interface OperatorQuestion {
  header: string;
  question: string;
  options?: OperatorQuestionOption[];
  multiSelect?: boolean;
  allowCustom?: boolean;
}

/**
 * Typed request handed to {@link ToolContext.askOperator}. Built by the
 * `ask_operator` handler from validated model input, stamped with a generated
 * {@link requestId} so the UI can correlate the answer back to the pending ask.
 * Modeled on OpenCode's `QuestionRequest` and Claude Code's `AskUserQuestion`.
 */
export interface OperatorQuestionRequest {
  /** Correlation id for this ask (generated; injectable factory in tests). */
  requestId: string;
  /** 1–4 questions to put to the operator. */
  questions: OperatorQuestion[];
}

/** One question's answer, correlated back to its {@link OperatorQuestion.header}. */
export interface OperatorQuestionAnswerItem {
  /** The `header` of the question this answers. */
  header: string;
  /** Option labels the operator selected (omitted / empty when none). */
  selectedLabels?: string[];
  /** Free-text the operator typed (only when the question allowed custom input). */
  customText?: string;
}

/**
 * Answer returned by {@link ToolContext.askOperator}. `requestId` echoes the
 * request. `answers` is index-aligned-by-`header` with the asked questions. A
 * `null` return from the callback means the operator dismissed the ask without
 * answering — the tool renders that as a graceful "no answer" result, never a
 * block.
 */
export interface OperatorQuestionAnswer {
  requestId: string;
  answers: OperatorQuestionAnswerItem[];
}

// ── Agent Messages (multi-turn) ──

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface AgentMessage {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: Array<{ name: string; result: ToolResult }>;
}

// ── Agent Configuration ──

export interface AgentConfig {
  /** Operator-owned mandatory ceiling for every delegated descendant. */
  workerPolicy?: WorkerPolicy;
  role: AgentRole;
  systemPrompt: string;
  tools: ToolDefinition[];
  maxTurns: number;
  /**
   * Hard cost ceiling in USD for the whole loop. When set, the loop reprices
   * running token usage after every turn (via `estimateCost`) and stops cleanly
   * once the estimate reaches the ceiling — mirroring the native loop
   * (`native-loop.ts`). `maxTurns` stays the runaway backstop. When unset, only
   * the turn cap applies.
   */
  costCeilingUsd?: number;
  /** Shared estimated inference accounting across legacy scan stages. */
  costLedger?: ScanCostLedger;
  /** Pricing model id for `estimateCost`; defaults to the shared default rates. */
  costModel?: string;
  signal?: AbortSignal;
  requirePricedUsage?: boolean;
  target: string;
  scanId: string;
  scopePath?: string;
  sessionId?: string;
  attachTargetToolsMcp?: boolean;
  dbPath?: string;
  authConfig?: AuthConfig;
  /** Built-in web search only; does not restrict other network tools. */
  webSearchEnabled?: boolean;
  /**
   * Tool-call dispatch protocol (0#232). When unset or `"json"`, the
   * legacy `TOOL_CALL: <name> {...}` line format is used. When `"xml"`,
   * the loop drives the model with the `<command>` / `<flag>` /
   * `<finding>` / `<note>` XML protocol from `xml-dispatch.ts`. `"auto"`
   * picks XML for cheap providers (gemini / deepseek / openrouter /
   * qwen / mistral / llama) and JSON otherwise. Consulted only by the
   * legacy text-based `runAgentLoop` — `runNativeAgentLoop` always uses
   * provider-native tool_use blocks.
   */
  dispatchMode?: DispatchMode;
  /**
   * Optional model identifier used by `dispatchMode: "auto"` substring
   * matching. When omitted, `resolveDispatchMode` falls back to JSON.
   */
  modelHint?: string;
}

// ── Agent State ──

export interface AgentState {
  messages: AgentMessage[];
  turnCount: number;
  findings: Finding[];
  attackResults: AttackResult[];
  targetInfo: Partial<TargetInfo>;
  done: boolean;
  summary: string;
  /** True when the loop stopped because the cost ceiling was reached (vs `done` or max turns). */
  costCeilingExceeded?: boolean;
  totalUsage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  estimatedCostUsd?: number;
  errorExit?: { error: string; turn: number };
}

// ── Tool Execution Context ──

export type DelegatedFindingPersistenceResult =
  | { status: "created"; findingId: string }
  | { status: "duplicate"; findingId: string }
  | { status: "rejected"; reason: string };

export type DelegatedFindingUpdateResult =
  | { success: true; message: string }
  | { success: false; error: string };

/**
 * What the bash tool asks before it runs a command: is this a script of an enabled, approved extension, and which
 * variables does it get? `null` means the command is not an extension's. Implemented by the extension runtime.
 */
export interface ExtensionRunPort {
  prepare(command: string, options?: { cwd?: string }): { ok: true; env: Record<string, string>; secrets: readonly string[] } | { ok: false; error: string } | null;
}

export interface ToolContext {
  /** Set by the host when extensions may run scripts. Absent: no extension variables are ever added. */
  extensionRuns?: ExtensionRunPort;
  /** Operator-owned ceiling; task prose and tool arguments cannot expand it. */
  workerPolicy?: WorkerPolicy;
  target: string;
  scanId: string;
  /** Shared audit-owned worker lifetimes; child executors borrow this tree. */
  workerTree?: import("./worker-tree.js").AuditWorkerTree;
  /** Audit-level sink for detached results whose parent invocation has ended. */
  workerFindings?: Finding[];
  /** Root-owned writer for validated child findings; never opens a child database. */
  persistDelegatedFinding?: (finding: Finding) => DelegatedFindingPersistenceResult;
  /** Root-owned status updater for child finding state mutations; never opens a child database. */
  updateDelegatedFinding?: (findingId: string, status: Finding["status"]) => DelegatedFindingUpdateResult;
  findings: Finding[];
  attackResults: AttackResult[];
  targetInfo: Partial<TargetInfo>;
  /**
   * Agent role this executor is serving. Used by the `done`-tool coverage
   * gate (#audit-laziness) to enforce minimum source inspection before a
   * sub-agent of role `audit`/`review` can declare itself complete. Other
   * roles short-circuit the gate. Optional for back-compat with the many
   * test fixtures that construct `ToolContext` literals directly.
   */
  role?: AgentRole;
  /** A bounded diff review must not satisfy whole-repository coverage quotas. */
  diffScopedReview?: boolean;
  /** The exact base commit of a diff-scoped review, used to ground replacement lines. */
  reviewDiffBase?: string;
  /** Parent-advertised built-ins; delegated agents cannot widen this capability set. */
  delegationTools?: readonly ToolDefinition[];
  /** Current parent instructions, inherited by delegated agent sessions. */
  delegationSystemPrompt?: string;
  scopePath?: string;
  /** Immutable parent-observed Git identity for delegated source reviews. */
  workspaceIdentity?: WorkspaceIdentity;
  /** Host-bound Memory tool (remember, update or forget one note); absent during verification or when Memory is off. */
  memory?: (args: { action: "remember" | "update" | "forget"; note?: string; kind?: string; scope?: "folder" | "global"; id?: string }) => { id?: string; removed?: boolean; saved?: boolean; status?: "live" | "proposed"; message: string };
  /**
   * True only for the interactive console executor. This explicit marker keeps
   * console-only source-acquisition identity checks out of native scan callers,
   * whose acquisition contract is unchanged.
   */
  consoleSession?: boolean;
  /** The "Ask before running commands" setting; `ask` gates effectful tools through approvals. */
  approvals?: ApprovalsChoice;
  /**
   * Operator question channel for the `ask_operator` tool.
   *
   * When wired, the tool builds a typed {@link OperatorQuestionRequest} and
   * awaits this callback; the UI renders the structured question(s), collects
   * the operator's selections / free text, and resolves the promise with an
   * {@link OperatorQuestionAnswer} (or `null` if the operator dismissed the ask
   * without answering). The handler returns that answer as a NORMAL tool result
   * so the model treats it as the operator's input/data.
   *
   * This is an INFORMATION-GATHERING gate ONLY — distinct from
   * `approveTool`. It authorizes
   * NOTHING: it never approves a tool.
   * `ask_operator` is in `READ_ONLY_TOOLS` for exactly this reason.
   *
   * When ABSENT — every non-console caller, including the scan pipeline — the
   * tool returns a graceful "operator questions are not available in this
   * session" result rather than blocking forever, mirroring every other gate's
   * "no callback → defer" contract.
   */
  askOperator?: (req: OperatorQuestionRequest) => Promise<OperatorQuestionAnswer | null>;
  /**
   * Agent-to-agent messaging identity and policy for this executor.
   *
   * Absent means messaging is unavailable — the child tools report that
   * rather than failing obscurely. Typed as `unknown` here because the
   * concrete shape lives in `agent-messaging.ts`, which imports from this
   * module; importing it back would be a cycle. `tools.ts` narrows it.
   */
  agentMessaging?: unknown;
  persistFindings?: boolean;
  authConfig?: AuthConfig;
  /** Built-in web search only; does not restrict other network tools. */
  webSearchEnabled?: boolean;
  /**
   * Recent tool result texts for JIT skill trigger matching (#457).
   * Populated by the agent loop with the last N tool result strings so
   * `list_skills` can compute `suggested` flags via `matchTriggers()`.
   */
  recentToolResultTexts?: string[];
  /**
   * Set of skill IDs already loaded in this session (#457). Prevents
   * double-loading the same skill and lets `load_skill` return a
   * "Skill already loaded" message instead of burning tokens.
   */
  loadedSkills?: Set<string>;
  /**
   * Typed loot / foothold ledger (0#567). When set, `finding`
   * harvests reusable artifacts (credentials, tokens, cookies, hashes,
   * endpoints, paths) from the finding's evidence into it, and the `use_loot`
   * tool reads from it so the agent can replay a captured artifact in a
   * follow-up request to chain to higher impact. The agent loop also harvests
   * from evidence-bearing tool results and re-injects a compact "known
   * footholds" block each turn. Created only when `features.lootLedger` is on;
   * undefined otherwise so the default scan path is unchanged.
   */
  loot?: LootLedger;
  /**
   * The agent turn currently executing. Kept fresh by the loop so tools can
   * stamp turn numbers on state they create (the plan ledger records the turn
   * a task was added and last touched, which is what makes a stale task
   * visible). Undefined outside the native loop, in which case turn stamps
   * fall back to 0.
   */
  currentTurn?: number;
  /**
   * Captured canonical workspace root for trust/enablement decisions. Used
   * by root-model and child-agent loops to evaluate workspace trust
   * consistently; set to the configured workspaceRoot or the default
   * process.cwd() at session creation time.
   */
  workspaceRoot?: string;
  /** Explicit Agent Skills roots; homeDir:null keeps shared workspaces isolated. */
  skillDiscoveryOptions?: import("./skills/agent-skills.js").AgentSkillDiscoveryOptions | (() => import("./skills/agent-skills.js").AgentSkillDiscoveryOptions);
  /** Server-issued skill editing capability, resolved for the current author. */
  skillAuthoring?: import("./skills/skill-authoring.js").SkillAuthoringAdapter | (() => import("./skills/skill-authoring.js").SkillAuthoringAdapter | undefined);
  /**
   * Shared per-scan cost ledger (see agent/cost-ledger.ts). Threaded onto the
   * ToolContext so the `spawn_agent` / `spawn_agents` handlers can pass it into
   * the child `runNativeAgentLoop` config — otherwise every subagent session
   * charges only its own session-local usage and escapes the scan-wide ceiling
   * (the off-ledger gap the ledger exists to close). Mirrors
   * `NativeAgentConfig.costLedger`. Undefined outside a native loop.
   */
  costLedger?: ScanCostLedger;
  /**
   * Hard per-scan cost ceiling in USD, mirrored from
   * `NativeAgentConfig.costCeilingUsd` onto the ToolContext so spawned
   * subagents inherit and enforce the SAME ceiling as the parent, priced
   * against the shared {@link costLedger}.
   */
  costCeilingUsd?: number;
  requirePricedUsage?: boolean;
  /**
   * Model id used to price token usage against the ceiling, mirrored from
   * `NativeAgentConfig.costModel`. Passed through to spawned subagents so
   * their ledger contributions price identically to the parent.
   */
  costModel?: string;
  /**
   * Tool-health recorder (0#tool-reliability). When present, the executor
   * routes structured tool-failure / skip events (missing binary, buffer
   * limit, wrong lockfile, policy denial) into it so the run can surface
   * a concise "N tool issues" summary and the CLI /doctor path can explain WHY
   * a tool didn't run. Absent for callers that don't care — the executor then
   * creates its own private tracker so recording is always safe; only the
   * shared summary is unavailable. Fail-soft: recording never aborts a tool
   * call.
   */
  toolHealth?: ToolHealthTracker;
}

// ── Dispatch Mode (0#232) ──

/**
 * How tool calls flow between the model and the harness in `runAgentLoop`.
 *
 * - `"json"` (default): the legacy `TOOL_CALL: <name> {...}` line format.
 *   Models that emit JSON correctly should keep using this.
 * - `"xml"`: an XML-tag protocol (`<command>`, `<flag>`, `<finding>`,
 *   `<note>`) parsed by regex. Cheap models (DeepSeek, Gemini-flash,
 *   Qwen, etc.) emit malformed JSON under load; XML survives that. See
 *   `agent/xml-dispatch.ts` and 0#232.
 * - `"auto"`: pick by model substring (gemini / deepseek / openrouter /
 *   qwen / mistral / llama → xml; otherwise json). Resolved by
 *   `resolveDispatchMode()` in `xml-dispatch.ts`.
 */
export type DispatchMode = "json" | "xml" | "auto";
