import { type WorkerPolicy } from "../../workflow-execution-policy.js";
import { type HarnessSnapshot, type SecurityWorkflowInput, type SecurityWorkflow, type TokenUsageForPricing } from "@0/shared";
import type { NativeMessage, NativeRuntime, NativeRuntimeResult } from "../../runtime/types.js";
import { type ExecutablePluginConfiguration } from "../../agent/executable-plugins.js";
import { LiveHarnessHost } from "../../plugins/live-harness.js";
import type { EvolutionConfig } from "../../improvement/types.js";
import type { McpHost } from "../../agent/mcp-host.js";
import { LearningStore, type osecDB } from "@0/db";
import { HuntMemoryStore } from "../../memory/hunt-memory.js";
import type { PluginHost } from "../../plugins/loader.js";
import type { AgentRole, OperatorQuestionAnswer, OperatorQuestionRequest, ScopedAuditEscalationRequest, ToolCall, ToolContext, ToolDefinition, ToolResult, ToolRisk } from "../../agent/types.js";
import { ScopePolicy } from "../../scope/scope.js";
import type { ScopeEnforcementState } from "../../scope/activation.js";
import type { ConsoleSessionCheckpoint } from "../session-checkpoint.js";
import { type RunCapture } from "../../telemetry/run-contribution.js";
import type { ToolContextJevRuntime } from "../jev-runtime.js";
import { type ConsoleConversationHistory } from "./console-tools.js";

/**
 * Emitted once each time the console loop compacts its conversation history at a
 * turn boundary (context-window management, mirroring the autonomous scan loop's
 * `context_compacted` event). Stream B renders this and back-fills `tokensAfter`
 * from the next planner usage sample. This EXACT shape is a contract with the
 * renderer — do not reshape it.
 */
export interface ConsoleCompactionEvent {
  /** Estimated current prompt occupancy, anchored to usage when available. */
  tokensBefore: number;
  /**
   * Local post-compaction prompt estimate. A later planner usage sample can
   * replace it with measured occupancy. Undefined when history was not reduced.
   */
  tokensAfter?: number;
  /** The model's context window in tokens, when known. */
  contextWindowTokens?: number;
  /** Message count before the rewrite. */
  messagesBefore: number;
  /** Message count after the rewrite. */
  messagesAfter: number;
  /** The `[COMPACTED CONVERSATION SUMMARY]` body produced. */
  summaryText: string;
  /** Deep copy of the pre-compaction history, so a renderer can offer "expand". */
  preCompactionMessages: NativeMessage[];
  /** 1-based index of this compaction within the session. */
  compactionNumber: number;
  /** True when the summary degraded to regex extraction / hard-trim. */
  degraded: boolean;
}

/** Streaming + activity callbacks a renderer (CLI REPL, product UI) hooks into. */
export interface ConsoleRenderCallbacks {
  onHarnessUpdate?: (snapshot: HarnessSnapshot) => void;
  /** Incremental visible assistant text (SSE delta fragments, not cumulative). */
  onAssistantDelta?: (text: string) => void;
  /** Incremental hidden reasoning-summary text. */
  onReasoningDelta?: (text: string) => void;
  /** Fired just before a tool call is dispatched to the executor. */
  onToolStart?: (call: ToolCall) => void;
  /** Fired after a tool call resolves, with its result. */
  onToolResult?: (call: ToolCall, result: ToolResult) => void;
  /**
   * Live token accounting, fired ONCE PER MODEL CALL inside a turn (not only at
   * the end of the turn), so a renderer can show consumption ticking up against
   * the per-turn budget while the model is still working. See
   * {@link ConsoleUsageReport}.
   */
  onUsage?: (usage: ConsoleUsageReport) => void;
  /** Non-fatal operational notice (e.g. the turn ran out of token budget). */
  onNotice?: (message: string) => void;
  /**
   * Fired once when the console loop compacts its history at a turn boundary.
   * See {@link ConsoleCompactionEvent}.
   */
  onCompaction?: (event: ConsoleCompactionEvent) => void;
}

/**
 * One live usage sample, emitted after every model call within a turn.
 *
 * `inputTokens`/`outputTokens` are the DELTA billed by the model call that just
 * completed (0 when the runtime reported no usage at all); the `turn*` fields
 * are the running totals for the whole turn measured against the budget in
 * force. Keeping the two delta fields first and required preserves structural
 * compatibility with the previous `{ inputTokens, outputTokens }` payload, so
 * an existing handler typed against the old shape still type-checks.
 */
export interface ConsoleUsageReport extends TokenUsageForPricing {
  /** Input tokens billed by the model call that just completed. */
  inputTokens: number;
  /** Output tokens billed by the model call that just completed. */
  outputTokens: number;
  /** Turn-cumulative input + output tokens, including this call. */
  turnTokensUsed: number;
  /** The per-turn token budget in force (`maxTurnTokens`). */
  turnTokenBudget: number;
  /** Tool-call rounds COMPLETED so far in this turn (0 on the first call). */
  iterations: number;
  /** The runaway iteration backstop in force (`maxToolIterations`). */
  maxToolIterations: number;
  /** Only planner input describes conversation occupancy. Plugin and worker
   * input belongs to separate prompts. */
  kind: "planner" | "plugin" | "compaction" | "worker";
  /** Actual worker request model; omitted for the parent planner. */
  model?: string;
  /** The runtime completed without a usage receipt; zero is not known free. */
  usageUnavailable?: boolean;
}

// ── Console autonomy / scope resolution (0 console) ──

/**
 * Operator engagement mode controls approval friction and capability policy.
 * The authorization behavior below applies only while the scope plugin is
 * enabled; turning that plugin off skips host/path/local-scope authorization.
 * Credential, private-network, sandbox and resource controls remain independent.
 *
 * - `"standard"`: the MOST-PROMPTING mode. Every effectful
 *   (non-read-only) action is put to the operator via `approveTool` before it
 *   runs and is dispatched only on an explicit yes — approval is never assumed.
 *   Out-of-scope network targets still go through scope-on-demand
 *   (`requestScope`), and uncovered local paths through `requestLocalScope`.
 * - `"copilot"`: full autonomy WITHIN the engagement. No per-action prompts.
 *   Scope-on-demand is AUTO-APPROVED for newly-discovered targets that belong
 *   to the engagement (the current target's host / its sub-domains, or paths
 *   adjacent to an established local scope) — the scope grows without asking,
 *   and the expansion is recorded. A target OUTSIDE the established engagement
 *   is not auto-authorized: it defers to the operator (`requestScope`) or, with
 *   no approval channel, is refused. Copilot only ever operates against the
 *   target/scope the operator established.
 * - `"yolo"` (default): no per-action prompts or preconfigured scope required.
 *   Target-related hosts and local paths are authorized automatically. A new
 *   unrelated network target asks the operator through `requestScope`; without
 *   an approval channel it is refused. Explicit exclusions, denied-decision
 *   memory, dangerous-local-root restrictions and SSRF protections remain.
 * - `"recon"`: passive, in-scope reconnaissance — the MOST capability-restricted
 *   mode. For AUTHORIZATION it behaves like standard: it operates strictly
 *   within the configured scope / target anchor and NEVER auto-expands scope
 *   (out-of-anchor targets are prompted via `requestScope`, or fall through to
 *   the executor's same-origin validation — never silently widened). For
 *   CAPABILITY it is stricter than any other mode: only non-exploitative work is
 *   permitted — read-only tools plus a conservative set of passive network-recon
 *   tools (see {@link RECON_PASSIVE_NETWORK_TOOLS}). Every effectful / mutating /
 *   exploitation tool (apply_patch, run_command, browser, exploit-class
 *   scanners, spawn_agent, raw http_request, …) is REFUSED with a clear reason —
 *   never prompted, never auto-lifted. Because it never runs effectful tools,
 *   recon does not use the per-action approval prompt at all. The target anchor
 *   and the absolute SSRF rail still bound the passive tools it does allow.
 */
export type ConsoleAutonomyMode = "standard" | "copilot" | "yolo" | "recon";

/**
 * Request payload passed to `ConsoleSessionConfig.requestScope` when a
 * network-capable tool call references URLs outside the current scope.
 * The callback may return a resolution (new target + scope) or null to deny.
 */
export interface ConsoleScopeRequest {
  /** The pending tool call that triggered this request. */
  call: ToolCall;
  /** URLs extracted from the tool call's arguments. */
  requestedUrls: string[];
  /**
   * Descriptions of network-reaching shell constructs whose destination could
   * NOT be resolved to a URL (`curl "$H"`, `… | sh`, `eval …`). Present only
   * for shell-payload tools. When this is non-empty the operator is being asked
   * to approve a call whose destination is UNKNOWN — the request carries the
   * full `call`, so the surface should show the actual command, not just
   * `requestedUrls` (which may be empty). Approving such a call means "I read
   * the command and I accept it", not "the scope covers it": nothing here can
   * be checked against `ScopePolicy`.
   */
  unresolvedTargets?: string[];
  /** Current session target (may be empty). */
  target: string;
  /** Current scope policy, if any. */
  currentScope?: ScopePolicy;
}

/**
 * Operator approval of an expanded scope.
 * Returned by `requestScope` to authorise the tool call.
 */
export interface ConsoleScopeResolution {
  /** Updated target (may be the same as the current one). */
  target: string;
  /** Scope policy covering the requested URLs. Never undefined on approval. */
  scope: ScopePolicy;
}

/**
 * Request payload passed to `ConsoleSessionConfig.requestLocalScope` when a
 * filesystem-scoped tool call (read_file/list_files/search_files/…) is issued
 * with no local scope covering the path it wants to touch. The local-scope
 * analogue of {@link ConsoleScopeRequest}: the operator approves an in-memory,
 * session-only directory subtree, or the callback returns null to deny.
 */
export interface ConsoleLocalScopeRequest {
  /** The pending tool call that triggered this request. */
  call: ToolCall;
  /**
   * The concrete filesystem path the tool asked to touch, already resolved to
   * an ABSOLUTE, symlink-resolved real path. This is exactly the path the
   * approval decision is made against — what the operator sees is what the
   * engine authorizes.
   */
  requestedPath: string;
  /** Current in-memory local scope directory, if any (absolute real path). */
  currentScopePath?: string;
}

/**
 * Operator approval of a local filesystem scope.
 * Returned by `requestLocalScope` to authorise the tool call. The approved
 * directory authorises that directory SUBTREE only; it is applied to the
 * session's in-memory tool context and NEVER written to disk.
 */
export interface ConsoleLocalScopeResolution {
  /** Absolute directory path the operator authorized (its subtree becomes readable). */
  scopePath: string;
}

/**
 * Why a single operator turn stopped.
 *
 * - `end_turn` — the model finished and handed control back (the normal path).
 * - `max_turn_tokens` — the turn's TOKEN BUDGET is exhausted. This is the
 *   primary cost guard and is NOT an error: the conversation is intact and the
 *   operator can simply send another message to continue (see
 *   {@link ConsoleTurnOutcome.budget} for the numbers to show them).
 * - `max_tool_iterations` — an explicitly configured tool-round limit was
 *   reached. Interactive sessions impose no tool-round limit by default.
 * - `output_cap` — a restored legacy turn paused at an output limit. Observations and
 *   plan remain intact; the operator can resume with a concise remaining task.
 * - `cancelled` — the operator interrupted the turn via an {@link AbortSignal}
 *   (see {@link ConsoleSendOptions.signal}). Like the budget stops, this is NOT
 *   an error: the conversation is left intact and resumable — every dispatched
 *   `tool_use` still has a matching `tool_result` — so the operator can send
 *   another message to continue. What it does and does NOT interrupt is spelled
 *   out on {@link ConsoleSendOptions.signal}.
 * - `error` — the LLM runtime failed.
 */
export type ConsoleStopReason =
  | "end_turn"
  | "max_tool_iterations"
  | "max_turn_tokens"
  | "output_cap"
  | "no_progress"
  | "cancelled"
  | "error";

/**
 * What a turn consumed, against the limits that were in force for it. Carried
 * on every {@link ConsoleTurnOutcome} — including successful ones — so a
 * surface can render "used 780,000 of 2,000,000 tokens over 30 rounds" instead
 * of a bare stop message, and so a budget stop is a reportable, resumable state
 * rather than a dead end.
 */
export interface ConsoleTurnBudget {
  /** Total tokens (input + output) this turn consumed. */
  tokensUsed: number;
  /** The per-turn token budget that was in force (`maxTurnTokens`). */
  tokenBudget: number;
  /** Tool-call rounds completed in this turn. */
  iterations: number;
  /** The runaway iteration backstop that was in force (`maxToolIterations`). */
  maxToolIterations: number;
}

/** Outcome of one operator message (the model's reply + every tool it ran). */
export interface ConsoleTurnOutcome {
  /** Optional metadata generated by the planner, never a separate model request. */
  conversationTitle?: string;
  assistantText: string;
  toolCalls: Array<{ call: ToolCall; result: ToolResult }>;
  usage: { inputTokens: number; outputTokens: number };
  /**
   * The most recent / current planner-model-call input tokens — the actual
   * conversation occupancy passed to the model. Distinct from the cumulative
   * `usage.inputTokens`, which sums every model call (planner + plugin) across
   * the turn. Undefined when no planner call reported usage.
   */
  contextInputTokens?: number;
  /**
   * Consumption vs. the limits in force. Always present, whatever the stop
   * reason — the operator needs the numbers to decide whether to continue.
   */
  budget: ConsoleTurnBudget;
  stopReason: ConsoleStopReason;
  error?: string;
  outputCap?: { checkpoint: NonNullable<NativeRuntimeResult["checkpoint"]>; continuations: number; message: string };
}

/**
 * Per-call options for {@link ConsoleSession.send}. A dedicated options bag —
 * NOT a field on {@link ConsoleRenderCallbacks} — because cancellation is a
 * different concern from rendering: `callbacks` are output hooks a *renderer*
 * owns (deltas, tool start/result, usage), whereas an `AbortSignal` is turn
 * *control* a *controller* owns. A headless caller with no renderer must still
 * be able to cancel, and a renderer must not have to become a cancellation
 * authority to draw output. Keeping them separate also matches the platform
 * `{ signal }` convention (fetch, addEventListener, node streams). The whole
 * bag is optional and every field within it is optional, so every existing
 * `send(text)` / `send(text, callbacks)` caller compiles and behaves
 * identically.
 */
export interface ConsoleSendOptions {
  images?: Array<{ mediaType: string; data: string; name?: string }>;
  /** Request a concise model-generated title within the existing accounted turn. */
  generateTitle?: boolean;
  /**
   * Operator interrupt for this turn. When it fires (or is already aborted on
   * entry), the turn stops at the next checkpoint and returns a
   * {@link ConsoleTurnOutcome} with `stopReason: "cancelled"`, still carrying
   * the {@link ConsoleTurnOutcome.budget} spent so far.
   *
   * WHAT IT INTERRUPTS — and only these, checked at the points where a check
   * can actually take effect:
   *   - before the FIRST model call (already-aborted signal ⇒ immediate return,
   *     no model call, no history mutation);
   *   - between rounds / before issuing the NEXT model call;
   *   - before dispatching each tool in a round.
   *
   * WHAT IT CANNOT INTERRUPT — stated plainly so no one is misled:
   *   - a tool already executing. Same-process JavaScript cannot be hard-
   *     killed; a tool in `executor.execute(...)` runs to completion and the
   *     signal takes effect only at the NEXT checkpoint (the next tool, or the
   *     next round).
   *   - an OAuth token refresh already in flight. `executeNative` now takes
   *     the signal and aborts an in-flight model call, but a ChatGPT/Codex
   *     token refresh issued inside `ensureFreshHeaders` takes no signal, so
   *     an abort during that one refresh waits it out — the model fetch then
   *     aborts immediately and the pre-attempt guard stops any retry.
   *
   * An in-flight MODEL call IS interruptible: the runtime composes the
   * operator signal with its own timeout and idle watchdog, and reports the
   * result structurally via `cancelled` so a cancellation is never mistaken
   * for a transport failure. A cancelled call is also never retried and never
   * fails over to another provider — retrying a request the operator just
   * cancelled would defeat the cancellation.
   *
   * CONVERSATION INTEGRITY is preserved regardless of when the signal fires:
   * if it fires mid-round after tool calls were already dispatched, every
   * outstanding `tool_use` still receives a matching `tool_result` (a synthetic
   * "cancelled by operator" result) before the turn returns, so history is
   * never left with an unmatched `tool_use` and the next `send()` resumes
   * cleanly. Cancelling a turn NEVER clears or bypasses authorization state —
   * denied-host / denied-path memory and granted scope are untouched.
   */
  signal?: AbortSignal;
}

export interface ConsoleSessionConfig {
  /** Mandatory operator-owned ceiling for delegated workers, independent of model task fields. */
  workerPolicy?: WorkerPolicy;
  /**
   * LLM client. Any `NativeRuntime` works (tests inject a stub); production
   * passes an `LlmApiRuntime`. Build one with {@link createConsoleRuntime}.
   */
  runtime: NativeRuntime;
  /** Explicit fixture capture; ordinary console runs require configured enrollment. */
  contribution?: RunCapture;
  /**
   * Prior conversation to seed the session with. When provided, the session's
   * history starts as a DEFENSIVE COPY of these native messages instead of
   * empty, so a session can be rebuilt around a different runtime without
   * losing the engagement context. This is what makes an in-place `/model`
   * switch possible: the CLI tears down the old session and constructs a fresh
   * one over the new LLM client, replaying the existing `messages` so the model
   * change is invisible to the ongoing conversation. The copy means later
   * `send()` calls never mutate the array the caller passed in. When absent,
   * the session starts with empty history (unchanged behaviour).
   */
  initialMessages?: NativeMessage[];
  /**
   * Engagement target the tools operate against (same-origin checks, tool
   * context). Optional — a bare console can start target-less and the operator
   * can name targets in-conversation; target-scoped tools then return a
   * graceful error until a target is set.
   */
  target?: string;
  /**
   * Role whose tool set the console exposes. Defaults to `"audit"`, which maps
   * to the full "everything" registry (recon, web, source, patch, run_command,
   * …) — the cockpit wants every tool in one place.
   */
  role?: AgentRole;
  /** Explicit tool override; defaults to `getToolsForRole(role, …)`. */
  tools?: ToolDefinition[];
  /** Stable id for this console session (telemetry / future persistence). */
  scanId?: string;
  /**
   * Optional persistent findings database. When supplied, save_finding writes to
   * it and query_findings can inspect prior scans/sessions; when absent, the
   * console keeps its historical in-memory-only behavior.
   */
  db?: osecDB | null;
  /** Retain and recall source-linked lessons in authorized local scopes. No extra model calls. */
  codebaseLearning?: boolean;
  /** Host-owned stores, optionally injected for a tenant or test. */
  huntMemoryStore?: HuntMemoryStore;
  learningStore?: LearningStore;
  /** Trusted host bridge: bounded source hints, never stored in guest memory or checkpoints. */
  sourceLessonHints?: (root: string, signal?: AbortSignal) => Promise<Array<{ title: string; summary: string; sourceLinks: Array<{ path: string; hash: string }> }>>;
  /**
   * Optional cap on tool-call rounds within a single operator turn.
   * Unlimited by default: long reviews continue until the model finishes or the
   * operator cancels. A caller may explicitly set a finite limit for bounded
   * batch work; that limit is honored exactly and never automatically resumed.
   */
  maxToolIterations?: number;
  /**
   * PRIMARY COST GUARD: the token budget (input + output, summed across every
   * model call) a single operator turn may consume. Defaults to
   * {@link DEFAULT_MAX_TURN_TOKENS}. Because every tool iteration resends the
   * whole conversation, turn cost grows superlinearly with tool count, so the
   * meaningful unit is tokens, not rounds.
   *
   * The turn stops when the accumulated usage has reached the budget, or when
   * the next request's estimated input and output allowance would push it past.
   * Summarization spend is included; missing usage is estimated for finite budgets.
   * Independent of {@link maxToolIterations}: either guard can trip
   * first, and each is separately configurable.
   */
  maxTurnTokens?: number;
  /** Opt in to generic-scanner tool wrappers (sqlmap/nikto/…). Default off. */
  allowScanners?: boolean;
  /** Built-in web search, independently of target scope and network authorization. */
  webSearchEnabled?: boolean;
  /** System-prompt override. Defaults to {@link buildConsoleSystemPrompt}. */
  systemPrompt?: string;
  /**
   * Engagement mode (see {@link ConsoleAutonomyMode}): standard prompts for each
   * effectful action. Copilot and the default yolo mode run actions without
   * per-action prompts and expand target-related scope automatically. New
   * unrelated network targets still require operator scope approval.
   */
  autonomyMode?: ConsoleAutonomyMode;
  /**
   * Pre-loaded scope policy. When absent, the session starts scopeless and
   * `requestScope` is invoked before the first network-capable tool call.
   * NEVER written to disk — in-memory only.
   */
  scope?: ScopePolicy;
  /**
   * Callback invoked when a network-capable tool call references URLs outside
   * the current scope (or scope is absent). Return a
   * {@link ConsoleScopeResolution} to approve with an updated target + scope,
   * or return null to deny the call. The resolution updates the session's
   * in-memory scope only — never rewrites a scope file.
   * When absent, the legacy readline console keeps its historical behavior.
   * The Bun/OpenTUI entrypoint always supplies this callback, so engagement
   * egress there remains scope-on-demand.
   */
  requestScope?: (req: ConsoleScopeRequest) => Promise<ConsoleScopeResolution | null>;
  /**
   * Callback invoked when a filesystem-scoped tool
   * (read_file/list_files/search_files/apply_patch/run_command/analyze_binary)
   * is issued and no in-memory local scope covers the path it wants to touch.
   * The local-filesystem analogue of {@link requestScope}: return a
   * {@link ConsoleLocalScopeResolution} to approve an in-memory directory
   * subtree, or return null to deny the call. The approved directory updates
   * the session's tool context only — it is NEVER written to a scope file.
   * When absent, behaviour is unchanged from the legacy readline console: the
   * tool simply returns its "requires a scoped local directory" error.
   */
  requestLocalScope?: (req: ConsoleLocalScopeRequest) => Promise<ConsoleLocalScopeResolution | null>;
  /**
   * Per-action approval callback for `"standard"` mode — the most-prompting
   * mode. Invoked before every non-read-only tool call; return true to allow,
   * false to block with a "denied" result. Ignored in `"copilot"` and `"yolo"`
   * (neither prompts per action). When absent, the gate falls through (the
   * engine cannot invent an operator to ask), mirroring every other gate's
   * "no callback → defer to the layers beneath" contract.
   */
  approveTool?: (call: ToolCall, risk?: ToolRisk) => Promise<boolean>;
  /**
   * Invoked when a tool is blocked purely by the scoped-source-audit
   * allow-list (role `audit`/`review` with a local scope). Return true to
   * let it run for the rest of the session, false to deny and remember.
   *
   * This lifts ONE restriction; it is not a master key. Network scope,
   * local-filesystem scope and the co-pilot gate all still apply, and in
   * yolo mode the allow-list is lifted without prompting. When absent,
   * blocked tools hard-deny exactly as they always have.
   */
  escalateScopedAudit?: (req: ScopedAuditEscalationRequest) => Promise<boolean>;
  /**
   * Operator question channel for the `ask_operator` tool. Invoked when the
   * model pauses to ask the operator a STRUCTURED question; render the
   * question(s), collect the answer, and resolve with an
   * {@link OperatorQuestionAnswer} — or `null` if the operator dismissed the ask
   * without answering.
   *
   * This is INFORMATION-GATHERING ONLY and distinct from `approveTool` /
   * `requestScope` / `escalateScopedAudit`: it authorizes NOTHING. When absent,
   * `ask_operator` returns a graceful "not available" result rather than
   * blocking, mirroring every other gate's "no callback → defer" contract.
   */
  askOperator?: (req: OperatorQuestionRequest) => Promise<OperatorQuestionAnswer | null>;
  /**
   * Agent-to-agent messaging identity and policy for this session's agent.
   *
   * Propagates to every subagent, which is how a child learns its parent's
   * id and — when the operator channel is enabled — the operator console's
   * id, a value a child cannot compute for itself. Absent means messaging
   * is unavailable and the child tools say so.
   *
   * Typed `unknown` because the concrete shape lives in
   * `agent/agent-messaging.ts`; importing it here would invert the layering.
   */
  agentMessaging?: unknown;
  /**
   * Whether to run the ONE-shot model refinement of the session objective (the
   * OMP-style "what am I working on" pill). Default `true`. The instant
   * heuristic is always emitted regardless; this only governs whether the
   * runtime is asked to rewrite it into a crisper label. Fully fail-soft and
   * off the turn's critical path — see `console/session-objective.ts`. Set
   * `false` to keep the heuristic only (e.g. to avoid any extra model spend).
   */
  refineObjective?: boolean;
  /** Enable sandboxed TypeScript tools, skills, and agent programs for this session. */
  allowModelSelfExtension?: boolean;
  /** Captured once; model-authored source cannot change the workspace trust root. */
  workspaceRoot?: string;
  /** Server-owned skill roots; evaluated for each catalog/load request. */
  skillDiscoveryOptions?: ToolContext["skillDiscoveryOptions"];
  skillAuthoring?: ToolContext["skillAuthoring"];
  /** Current host-owned skill editing context, refreshed on every model request. */
  skillEditor?: { read(): { id: string; name: string; revision: string; writable: boolean } | undefined | Promise<{ id: string; name: string; revision: string; writable: boolean } | undefined> };
  onHarnessUpdate?: (snapshot: HarnessSnapshot) => void;
  executablePlugins?: ExecutablePluginConfiguration;
  /** Evaluation contracts owned by the operator, not editable by generated code. */
  executableEvolutionProfiles?: Record<string, EvolutionConfig>;
  /** Optional budgeted Jev bridge available to Jev prepass tools. */
  jevRuntime?: ToolContextJevRuntime;
  /** Actual provider model ID, used for evolution cost accounting. */
  costModel?: string;
  /**
   * Live plugin host for THIS session (0 plugin system). Optional; absent =
   * today's behaviour exactly (no plugin tools are exposed or dispatched). When
   * provided, the tools of ENABLED/loaded plugins are unioned into the
   * model-facing tool set at each turn boundary and their calls are dispatched
   * through the host — but ONLY tools the host actually owns (the loader already
   * enforces enablement; this console never bypasses it). Every existing
   * per-call console gate (recon capability, scope, local-scope, standard
   * approval, and the deny-only guard floor) still applies to a plugin tool,
   * using the host's own resolved gate flags so a plugin tool lands in the SAME
   * gate maps as the built-ins. The host's lifecycle (load/reload/unload) is the
   * caller's responsibility; the console only reads its registry at turn
   * boundaries, which is the loader's turn-boundary safety contract.
   */
  pluginHost?: PluginHost;
  /**
   * A connected MCP client host (external tool servers). The CALLER constructs
   * it and connects its servers (async) before building the session; the console
   * advertises its discovered tools at turn boundaries, routes `mcp__` calls to
   * it via the executor, and closes it on cleanup. Absent = no MCP tools.
   */
  mcpHost?: McpHost;
  /**
   * Read-only access to persisted console session transcripts. When supplied,
   * the model-facing tools `list_conversations` and `read_conversation` are
   * advertised and dispatch through this callback. Both tools are pure read-only
   * operations: no network, no filesystem scope, approved in all autonomy modes
   * (recon/standard/copilot/yolo) without operator prompting. When absent, no
   * conversation-history tools are advertised and the model never sees them.
   */
  conversationHistory?: ConsoleConversationHistory;
  /** Caller-owned lifecycle adapter. start_run queues work for an idle boundary; it never launches inside an active turn. */
  workflowLifecycle?: { invoke(name: string, args: Record<string, unknown>): unknown | Promise<unknown> };
  /** Caller-owned draft storage only. No execution, schedules or authorization. */
  workflowAuthoring?: {
    /** Current storage-backed context, refreshed for every model request. */
    editor?: { id: string; read(): SecurityWorkflow | undefined | Promise<SecurityWorkflow | undefined> };
    list(): SecurityWorkflow[] | Promise<SecurityWorkflow[]>;
    save(input: SecurityWorkflowInput): SecurityWorkflow | Promise<SecurityWorkflow>;
  };
  /**
   * A checkpoint from a prior console session. When provided, the session is
   * seeded from this checkpoint's state (messages, scope, denied sets,
   * self-extension registrations, etc.) instead of starting fresh. The caller
   * MUST construct the candidate session with this checkpoint BEFORE calling
   * {@link ConsoleSession.prepareHandoff} on the old session, so a candidate
   * construction failure leaves the old engine fully usable.
   *
   * Version is validated at construction time before any resources are acquired;
   * an incompatible version causes a synchronous throw with a clear message.
   */
  initialCheckpoint?: ConsoleSessionCheckpoint;
  /**
   * Developer-mode source root for 0dev live updates. When provided, the
   * default system prompt includes brief guidance that the core engine source
   * at this path can be edited with authorized file tools and that engine
   * handoff happens after the current turn. Only set when the operator has
   * explicitly opted in via `allowDevSourceUpdates`. The new factory always
   * rebuilds the default prompt from fresh source on engine replacement.
   */
  developmentSourceRoot?: string;
  /**
   * The active model's context window in prompt tokens. Used only to drive
   * console-loop context compaction (see {@link compaction}); when unset,
   * compaction never fires (there is nothing to measure occupancy against).
   * Recomputed on an in-place `/model` switch via {@link ConsoleSession.reconfigureRuntime}.
   */
  contextWindowTokens?: number;
  /**
   * Console-loop context compaction. Off unless `enabled` is true. When on and
   * {@link contextWindowTokens} is known, the loop rewrites its middle history
   * into a summary at paired request boundaries once estimated prompt occupancy
   * crosses `thresholdFraction` of the context window (default 0.80), reserving
   * output headroom. Includes initial/resumed input and pending tool results.
   */
  compaction?: { enabled: boolean; thresholdFraction: number };
}

/** Explicit operator configuration, applied only while the root turn is idle. */
export interface ConsoleEngagementSelection {
  target?: string;
  scope?: ScopePolicy | null;
}

export interface ConsoleSourceLesson {
  title: string;
  summary: string;
  sourceLinks: Array<{ path: string; hash: string }>;
}
export interface ConsoleSourceContext {
  status: "not_requested" | "supplied" | "none";
  lessons: ConsoleSourceLesson[];
}

/** A live console session: persistent history + a `send()` per operator line. */
export interface ConsoleSession {
  readonly scanId: string;
  /** Restored executable tools and harness providers are usable after this resolves. */
  readonly ready: Promise<void>;
  readonly harness?: LiveHarnessHost;
  readonly contribution?: RunCapture;
  readonly systemPrompt: string;
  readonly tools: ToolDefinition[];
  /** Source lessons supplied to the last actual planner request, never proof of use. */
  readonly sourceContext?: ConsoleSourceContext;
  /** Full conversation so far (native content blocks). Grows with each turn. */
  readonly messages: NativeMessage[];
  /** Current autonomy mode (configurable at creation time). */
  readonly autonomyMode: ConsoleAutonomyMode;
  readonly workerPolicy?: WorkerPolicy;
  /** Idle only; active worker policies remain immutable through their lifetime. */
  setWorkerPolicy?(policy: WorkerPolicy | undefined): void;
  /** Current engagement target (may be updated by scope resolution). */
  readonly target: string;
  /** Current in-memory scope policy (never persisted to disk). */
  readonly scope: ScopePolicy | undefined;
  /** Actual authorization activation; a configured scope alone is not enforcement. */
  readonly scopeEnforcement: ScopeEnforcementState;
  /**
   * Current in-memory local filesystem scope directory (absolute real path), or
   * undefined when none has been approved. Never persisted to disk.
   */
  readonly localScopePath: string | undefined;
  /** Switch autonomy without discarding the conversation or in-memory scope. */
  setAutonomyMode(mode: ConsoleAutonomyMode): void | Promise<void>;
  readonly webSearchEnabled?: boolean;
  /** Idle only; existing child agents must finish before changing their inherited policy. */
  setWebSearchEnabled?(enabled: boolean): void | Promise<void>;
  /** Keep identity, resources and denied-decision memory while changing engagement configuration. */
  configureEngagement(selection: ConsoleEngagementSelection): void;
  /** Explicit operator-approved local directory; idle only. */
  configureWorkspace(path: string): void;
  /**
   * Live-reconfigure the model / provider / role map on the underlying runtime,
   * so the next turn and next subagent fork pick it up without a session
   * restart. No-op when the runtime does not support live reconfiguration.
   */
  reconfigureRuntime(sel: {
    model?: string;
    provider?: string;
    agentModels?: Record<string, string>;
    singleModel?: boolean;
    env?: NodeJS.ProcessEnv;
    /**
     * The new model's context window in prompt tokens. When provided, the
     * console-loop compaction trigger is re-based on it, so a `/model` switch
     * to a smaller- or larger-window model compacts at the right point.
     * Pass null to clear it. A model/provider change without a window also clears it.
     */
    contextWindowTokens?: number | null;
  }): void;
  /**
   * Clear all conversation messages while preserving session identity, target,
   * scope, autonomy mode, system prompt, tools, and executor resources.
   * The next call to {@link send} starts from an empty history.
   */
  clearConversation(): void;
  /**
   * Run one operator message to a natural stop, streaming via `callbacks`.
   * Pass `opts.signal` to make the turn cancellable — see
   * {@link ConsoleSendOptions.signal} for exactly what an abort can and cannot
   * interrupt. Both trailing parameters are optional; omitting them is today's
   * behaviour exactly.
   */
  send(
    userText: string,
    callbacks?: ConsoleRenderCallbacks,
    opts?: ConsoleSendOptions,
  ): Promise<ConsoleTurnOutcome>;
  /** Stop an owned worker subtree and await cleanup without clearing history. */
  stopPersistentAgent(agentId: string): Promise<boolean>;
  /** Drain all owned workers without ending this conversation. */
  stopPersistentAgents(): Promise<void>;
  /** Copy quiescent state; rejects pending initialization, turns, workers or harness actions. */
  exportCheckpoint(): ConsoleSessionCheckpoint;
  /**
   * Retire engine resources without closing caller-owned MCP clients. Preconditions
   * fail before retirement; subsequent cleanup failures are returned as warnings.
   */
  prepareHandoff(): Promise<{ warnings?: string[] }>;
  /** Present only when an owned execution boundary can confirm process/resource exit. */
  forceStop?(): Promise<{ processExited: boolean; resourcesStopped: boolean; quarantined: boolean; error?: string }>;
  /** Release tool resources (browser/PTY) held by the executor. */
  cleanup(): Promise<void>;
}
