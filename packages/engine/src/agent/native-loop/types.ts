import type { WorkerPolicy } from "../../workflow-execution-policy.js";
import { type WorkspaceIdentity } from "../workspace-identity.js";
import type { NativeRuntime, NativeMessage, NativeRuntimeResult } from "../../runtime/types.js";
import type { AuthConfig } from "../../shared/index.js";
import type { ToolDefinition, ToolCall, ToolResult, ToolContext, AgentRole } from "../types.js";
import type { ToolHealthSummary } from "../tool-health.js";
import { type TrustGraphConfig } from "../trust-graph-runtime.js";
import { type RunCapture } from "../../telemetry/run-contribution.js";
import type { ScanCostLedger } from "../cost-ledger.js";
import type { osecDB } from "../../storage/index.js";
import type { Finding, AttackResult, TargetInfo } from "../../shared/index.js";

// ── Native Agent Loop Config ──

export interface NativeAgentConfig {
  /** Host-owned ceiling inherited by every descendant. */
  workerPolicy?: WorkerPolicy;
  /** Preserve exact target identity guards when delegating from the console. */
  consoleSession?: boolean;
  /**
   * Agent-to-agent messaging identity and policy, propagated to the tool
   * context so the child messaging tools know who they are and whom they
   * may address. Absent means messaging is unavailable.
   */
  agentMessaging?: unknown;
  role: AgentRole;
  systemPrompt: string;
  tools: ToolDefinition[];
  /** Explicit execution allowance; omitted means continue until completion or cancellation. */
  maxTurns?: number;
  /** Disable delegation, including unadvertised calls to spawn tools. */
  singleAgent?: boolean;
  /** Bound diff base for exact source-line suggestions. */
  reviewDiffBase?: string;
  /** Blind verification may assess findings but must not publish a second copy. */
  suppressFindingEvents?: boolean;
  target: string;
  scanId: string;
  workerTree?: ToolContext["workerTree"];
  workerFindings?: ToolContext["findings"];
  persistDelegatedFinding?: ToolContext["persistDelegatedFinding"];
  updateDelegatedFinding?: ToolContext["updateDelegatedFinding"];
  scopePath?: string;
  /** Inherited parent identity; validated before the child starts analysis. */
  workspaceIdentity?: WorkspaceIdentity;
  sessionId?: string; // Resume from existing session
  /** Which retry attempt this is (0 = first attempt). Used by early-stop logic. */
  retryCount?: number;
  /** Authentication credentials to inject into tool context */
  authConfig?: AuthConfig;
  /**
   * Hard cost ceiling in USD. When set, the loop checks the running
   * estimated cost after every tool-call turn and aborts cleanly when
   * the ceiling is exceeded. Partial findings collected so far are
   * preserved on the returned state.
   *
   * By default the running cost is THIS session's `totalUsage` alone.
   * When {@link NativeAgentConfig.costLedger} is present the check prices
   * the ledger's cross-session cumulative total instead, so the ceiling
   * binds the whole scan rather than each agent session individually.
   */
  costCeilingUsd?: number;
  /** Optional model id used to price token usage against the ceiling. */
  costModel?: string;
  /**
   * Shared per-scan cost ledger (see agent/cost-ledger.ts). When present,
   * every turn's token usage is folded into the ledger AND the cost-ceiling
   * check above prices the ledger total — so a scan running multiple agent
   * sessions (research + the concurrent verify wave) enforces ONE ceiling
   * across all of them instead of granting each session the full ceiling
   * independently. Omit to keep the legacy per-session accounting.
   */
  costLedger?: ScanCostLedger;
  requirePricedUsage?: boolean;
  /** Root policy inherited by descendants without accumulating ancestor tasks.
   * Defaults to systemPrompt for a non-delegated root.
   */
  delegationSystemPrompt?: string;
  /** Inherited built-in search policy, independent of network authorization. */
  webSearchEnabled?: boolean;
  /**
   * Methodology skill IDs to auto-load into context before the loop starts
   * (#557). Used by EGATS specialist routing so a class branch begins with the
   * matching playbook already in its system prompt. Each skill's content is
   * appended to the system prompt and the ID is recorded in the loop's
   * `loadedSkills` set, so a later `load_skill` call on the same ID is a no-op
   * (`already_loaded`) — the preload is idempotent. Unknown IDs and skills not
   * applicable to `role` are skipped silently. Independent of the `jitSkills`
   * flag: the preload reads the registry directly, so the playbook lands even
   * when the `list_skills` / `load_skill` tools are not exposed.
   */
  preloadedSkillIds?: string[];
  /**
   * Durable cross-scan credential store wiring (0#771, connects #786 +
   * #780). OPT-IN and OFF BY DEFAULT: when omitted, the loop behaves exactly as
   * today — no durable store is constructed, no prior footholds are loaded, the
   * ledger is never persisted, and no `credential_shared` journal entry is
   * emitted (zero new I/O, byte-identical behaviour; asserted by test).
   *
   * When set, the loop (a) injects this target's prior-scan footholds at start,
   * (b) persists the in-scan ledger (hash + redacted preview only — never
   * plaintext) on harvest growth and at completion, and (c) emits a
   * `credential_shared` journal entry when a prior-scan credential from a
   * different source target is re-found against this target. See
   * `trust-graph-runtime.ts` for the full contract.
   */
  trustGraph?: TrustGraphConfig;
  /** Captured canonical workspace root for trust/enablement decisions. */
  workspaceRoot?: string;
  skillDiscoveryOptions?: ToolContext["skillDiscoveryOptions"];
  skillAuthoring?: ToolContext["skillAuthoring"];
}

export interface NativeAgentLoopOptions {
  config: NativeAgentConfig;
  runtime: NativeRuntime;
  db: osecDB | null;
  /** Explicit permissioned fixture or enrolled run. Absent: only configured enrollment can capture. */
  contribution?: RunCapture;
  /** Cancels model requests, executable guests, and subsequent tool dispatch. */
  signal?: AbortSignal;
  onTurn?: (
    turn: number,
    toolCalls: ToolCall[],
    results: ToolResult[],
    assistantText: string,
    telemetry?: { usage?: NativeAgentState["totalUsage"]; contextTokens?: number; reasoning_summary?: string },
  ) => void;
  /** Visible tool snapshots before/after execution, without token-level floods. */
  onToolUpdate?: NativeAgentLoopOptions["onTurn"];
  /** Called only after a new finding has passed finding validation. */
  onFindingSaved?: (finding: Finding) => void | Promise<void>;
  onEvent?: (eventType: string, payload: Record<string, unknown>) => void;
  /** Poll for user-injected messages at turn boundaries. */
  getPendingUserMessages?: () => string[];
}

export interface NativeAgentState {
  sessionId: string;
  messages: NativeMessage[];
  turnCount: number;
  findings: Finding[];
  attackResults: AttackResult[];
  targetInfo: Partial<TargetInfo>;
  done: boolean;
  summary: string;
  /**
   * `inputTokens` is total prompt tokens (cached spans included), so the
   * compaction trigger below keeps measuring real context growth regardless of
   * cache hit rate. `cachedInputTokens` is tracked alongside it purely so
   * `estimateCost` can price those tokens at the cached-input rate instead of
   * full price — without it, a well-cached run would report roughly 10x its
   * actual input spend.
   */
  totalUsage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteTokens?: number };
  /** Set to true when the loop stopped early because no finding was called by the halfway point. */
  earlyStopNoProgress: boolean;
  /** Brief description of tools/approaches used before the early stop (for retry context). */
  attemptSummary: string;
  /** LLM-generated structured progress summary for retry handoff. */
  progressSummary: string;
  /** Path to exported progress JSON (set when progressHandoff writes to disk). */
  progressPath?: string;
  /** Approximate USD cost based on token usage and model pricing. */
  estimatedCostUsd: number;
  /**
   * Set to true when the loop terminated because the running cost
   * exceeded the configured `costCeilingUsd`. Partial findings on
   * `state.findings` are preserved.
   */
  costCeilingExceeded: boolean;
  /**
   * Set when the loop terminated because the planner LLM call returned an
   * error (or empty response). The legacy `state.summary = "Error: ..."`
   * marker is preserved for back-compat with downstream readers, but this
   * structured signal is what callers should branch on to surface a
   * `failed` exit_reason to the cloud / CLI rather than the default
   * `completed` path. Carries the raw error message and the turn at which
   * the loop bailed out.
   */
  errorExit?: { error: string; turn: number; source?: "provider" | "harness" };
  /** Resumable output-cap pause, never a provider failure or completed task. */
  outputCapExit?: { checkpoint: NonNullable<NativeRuntimeResult["checkpoint"]>; continuations: number; message: string };
  /**
   * Tool-health roll-up for this run (0#tool-reliability): the deduped set
   * of tool skips / failures (missing binary, buffer limit, wrong lockfile,
   * policy/scope denial) with a concise `line` the CLI can surface as
   * "N tool issues (missing: semgrep; …)". `total: 0` when nothing degraded.
   */
  toolHealth?: ToolHealthSummary;
}
