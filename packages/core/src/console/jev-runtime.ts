/**
 * Console Jev runtime — evaluator factory, per-session budget, activity reporting.
 *
 * Manages one or more JevEvaluator instances sharing a single per-session hard
 * budget (maxRequests / maxCostUsd). Every evaluate() call through the runtime
 * is budgeted, cached, and activity-recorded. Callers receive a budgeted wrapper,
 * never the raw JevEvaluator — the raw evaluator is private inside this module.
 *
 * The cloud provider path uses the HostedJevTransport (session-based, Usage-v2
 * funding) instead of the legacy createJevEvaluator cloud route. No automatic
 * retries on ambiguous dispatch.
 *
 * NEVER serialises credentials to checkpoints, transcripts, or persisted state.
 */
import { createJevEvaluator, jevConfigFromEnvironment } from "@0/shared"
import type { JevEvaluator,
JevFeature,
JevUsage,
JevEvaluationRequest,
JevEvaluationResult,
ConsoleJevConfig,
ConsoleJevActivity,
JevConfig, } from "@0/shared"
import { HostedJevTransport, createHostedJevTransport } from "../cloud/jev-client.js";

// ── Defaults ──

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_MAX_COST_USD = 0.10;
const FEATURES: readonly JevFeature[] = ["browser", "memory", "dedupe", "redteam", "kernel", "crash", "radar", "foxguard"];

// ── Error helpers ──

class JevBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevBudgetError";
  }
}

// ── Session-level hard budget ──

interface SessionBudget {
  remainingRequests: number;
  remainingCostUsd: number;
}

function createSessionBudget(config: ConsoleJevConfig): SessionBudget {
  const maxRequests = config.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const maxCostUsd = config.maxCostUsd ?? DEFAULT_MAX_COST_USD;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 10_000) {
    throw new Error("Console Jev maxRequests must be an integer between 1 and 10,000");
  }
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || maxCostUsd > 100) {
    throw new Error("Console Jev maxCostUsd must be a positive amount up to 100");
  }
  return { remainingRequests: maxRequests, remainingCostUsd: maxCostUsd };
}

/**
 * Reserve one request slot from the budget. Throws JevBudgetError when
 * either the request count or cost ceiling is exhausted.
 */
function checkBudget(budget: SessionBudget, feature: string): void {
  if (budget.remainingRequests <= 0) {
    throw new JevBudgetError(`Jev budget exhausted (requests) for feature: ${feature}`);
  }
  if (budget.remainingCostUsd <= 0) {
    throw new JevBudgetError(`Jev budget exhausted (cost) for feature: ${feature}`);
  }
  budget.remainingRequests--;
}

/**
 * Deduct actual cost from the budget after a completed evaluation.
 * The cost is the actual estimated cost from the evaluation, not a reservation.
 * Never refunds or increases the budget beyond original limits.
 */
function deductCost(budget: SessionBudget, actualCostUsd: number): void {
  budget.remainingCostUsd = Math.max(0, budget.remainingCostUsd - actualCostUsd);
}

// ── Safe activity categories ──

type SafeActivityMessage =
  | "Jev evaluation started"
  | "Jev evaluation completed"
  | "Jev budget exhausted"
  | "Jev evaluation timed out"
  | "Jev provider error"
  | "Jev evaluation cancelled"
  | "Jev evaluator unavailable"
  | "Jev configuration error";

function safeActivityMessage(raw: string): SafeActivityMessage {
  if (raw.includes("budget") || raw.includes("Budget") || raw.includes("exhausted")) {
    return "Jev budget exhausted";
  }
  if (raw.includes("timed out") || raw.includes("timeout") || raw.includes("Timeout")) {
    return "Jev evaluation timed out";
  }
  if (raw.includes("cancel") || raw.includes("Cancel") || raw.includes("abort")) {
    return "Jev evaluation cancelled";
  }
  if (raw.includes("provider") || raw.includes("Provider") || raw.includes("HTTP")) {
    return "Jev provider error";
  }
  if (raw.includes("unavailable") || raw.includes("Unavailable")) {
    return "Jev evaluator unavailable";
  }
  return "Jev provider error";
}

// ── In-memory evaluation cache ──

/**
 * Bounded in-memory cache for identical Jev evaluations within a session.
 * Cache key includes evidence digest, questions digest, feature, and model/policy
 * identifier. Never caches tool args or path alone. Bounded to prevent unbounded
 * memory growth. Cached results report zero new usage and never fabricate charges.
 * The original usage record is preserved but not summed into the session budget.
 */
class JevCache {
  private _entries = new Map<string, { result: JevEvaluationResult; timestamp: number }>();
  private _maxEntries: number;

  constructor(maxEntries = 64) {
    this._maxEntries = maxEntries;
  }

  private _key(feature: string, evidence: unknown, questions: Record<string, unknown>, modelPolicy: string): string {
    const evidenceStr = typeof evidence === "string" ? evidence : JSON.stringify(evidence);
    const questionsStr = JSON.stringify(questions);
    let hash = 0;
    const data = `${feature}|${evidenceStr}|${questionsStr}|${modelPolicy}`;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return `${hash}`;
  }

  get(feature: string, evidence: unknown, questions: Record<string, unknown>, modelPolicy: string): JevEvaluationResult | undefined {
    const key = this._key(feature, evidence, questions, modelPolicy);
    return this._entries.get(key)?.result;
  }

  set(feature: string, evidence: unknown, questions: Record<string, unknown>, modelPolicy: string, result: JevEvaluationResult): void {
    if (this._entries.size >= this._maxEntries) {
      const oldest = this._entries.keys().next();
      if (!oldest.done) this._entries.delete(oldest.value);
    }
    const key = this._key(feature, evidence, questions, modelPolicy);
    this._entries.set(key, { result, timestamp: Date.now() });
  }

  clear(): void {
    this._entries.clear();
  }

  get size(): number {
    return this._entries.size;
  }
}

// ── Console Jev Runtime ──

export interface ConsoleJevRuntime {
  readonly enabled: boolean;
  readonly features: readonly JevFeature[];
  /**
   * Get-or-create a per-feature budgeted evaluator wrapper. The returned object
   * shares the session budget, cache, and activity reporting. Returns undefined
   * when the feature is not enabled or no provider is configured.
   *
   * This is the ONLY public evaluator accessor. Raw JevEvaluator instances are
   * private to this module — callers always go through the budgeted wrapper
   * that enforces hard ceilings and emits activity records.
   */
  evaluator(feature: JevFeature): { evaluate(req: JevEvaluationRequest): Promise<JevEvaluationResult | undefined> } | undefined;
  /**
   * Cache-aware evaluate helper: checks the in-memory cache before dispatching.
   * Tracks session budget and emits activity callbacks. Returns undefined on
   * budget exhaustion or unavailable rather than throwing — callers degrade
   * gracefully. Cached results report zero usage and are not budget-deducted.
   */
  evaluate(feature: JevFeature, request: JevEvaluationRequest, modelPolicy?: string): Promise<JevEvaluationResult | undefined>;
  /** Current budget state, or undefined when no per-session budget is in effect. */
  budget(): { remainingRequests: number; remainingCostUsd: number } | undefined;
  /** Release all resources. Future calls after dispose return undefined. */
  dispose(): void;
}

/**
 * Create a console Jev runtime from explicit config.
 *
 * Credentials live ONLY in the evaluator factory closure and the HostedJevTransport
 * instance — the returned ConsoleJevRuntime carries no serialisable references to
 * apiKey or tokens.
 */
export function createConsoleJevRuntime(
  config: ConsoleJevConfig,
  onActivity?: (activity: ConsoleJevActivity) => void,
): ConsoleJevRuntime {
  const enabled = config.features.length > 0;
  let budget: SessionBudget | null = enabled ? createSessionBudget(config) : null;
  const cache = new JevCache();
  let disposed = false;

  // Validate feature list
  for (const feature of config.features) {
    if (!FEATURES.includes(feature)) {
      throw new Error(`Unknown Jev feature: ${feature}`);
    }
  }

  // Sanitised activity emit — never passes raw error text to the callback.
  function emitSafeActivity(activity: Omit<ConsoleJevActivity, "message"> & { message?: string }): void {
    if (disposed) return;
    try {
      onActivity?.({
        feature: activity.feature,
        status: activity.status,
        model: activity.model,
        durationMs: activity.durationMs,
        inputTokens: activity.inputTokens,
        outputTokens: activity.outputTokens,
        estimatedCostUsd: activity.estimatedCostUsd,
        billing: activity.billing,
        message: activity.message ? safeActivityMessage(activity.message) : undefined,
      });
    } catch {
      // Activity callback must never break the runtime.
    }
  }

  // ── Private evaluator construction ──

  const rawEvaluatorCache = new Map<JevFeature, JevEvaluator>();

  function buildRawEvaluator(feature: JevFeature): JevEvaluator | undefined {
    if (disposed || !config.features.includes(feature)) return undefined;

    if (config.provider === "cloud") {
      // Hosted transport uses HostedJevTransport sessions (Usage-v2 funding).
      // No legacy createJevEvaluator cloud route — this is the primary path.
      const transport = createHostedJevTransport({
        host: config.cloud?.host,
        token: config.cloud?.token,
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      if (!transport) return undefined;

      // Wrap HostedJevTransport into a JevEvaluator interface.
      return {
        async evaluate(request: JevEvaluationRequest): Promise<JevEvaluationResult> {
          const result = await transport.evaluate({
            ...request,
            feature,
          });
          return result;
        },
      };
    }

    if (config.provider === "direct") {
      const envConfig = jevConfigFromEnvironment(feature, process.env);
      if (!envConfig) return undefined;
      if (config.timeoutMs !== undefined && envConfig.timeoutMs === undefined) {
        (envConfig as unknown as Record<string, unknown>).timeoutMs = config.timeoutMs;
      }
      return createJevEvaluator(envConfig);
    }

    // Explicit provider (typesafe/vercel) — build from ConsoleJevConfig fields.
    const apiKey = config.apiKey ?? "";
    if (!apiKey) {
      emitSafeActivity({ feature, status: "unavailable", message: "Jev evaluator unavailable" });
      return undefined;
    }

    const jevConfig: JevConfig = {
      provider: config.provider,
      apiKey,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    } as JevConfig;

    return createJevEvaluator(jevConfig);
  }

  // ── Budgeted evaluator wrapper ──

  function createBudgetedEvaluator(feature: JevFeature): { evaluate(req: JevEvaluationRequest): Promise<JevEvaluationResult | undefined> } | undefined {
    const raw = rawEvaluatorCache.get(feature);
    if (raw !== undefined) return { evaluate: (req) => dispatchBudgeted(feature, raw, req) };
    const built = buildRawEvaluator(feature);
    if (!built) return undefined;
    rawEvaluatorCache.set(feature, built);
    return { evaluate: (req) => dispatchBudgeted(feature, built, req) };
  }

  // ── Budgeted dispatch (shared request/cost budget, cache, activity) ──

  async function dispatchBudgeted(
    feature: JevFeature,
    raw: JevEvaluator,
    request: JevEvaluationRequest,
  ): Promise<JevEvaluationResult | undefined> {
    if (disposed) return undefined;

    // Check cache first
    const mp = `${config.provider}:${feature}`;
    const cached = cache.get(feature, request.state, request.questions as Record<string, unknown>, mp);
    if (cached) {
      // Cached result: report zero new usage, never fabricate charges.
      emitSafeActivity({
        feature, status: "completed",
        model: cached.model,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        message: "Jev evaluation completed",
      });
      return cached;
    }

    // Budget admission — hard check before any dispatch
    if (budget) {
      try {
        checkBudget(budget, feature);
      } catch (error) {
        emitSafeActivity({ feature, status: "unavailable", message: "Jev budget exhausted" });
        return undefined;
      }
    }

    const startedAt = performance.now();
    emitSafeActivity({ feature, status: "started", message: "Jev evaluation started" });

    try {
      const result = await raw.evaluate(request);
      const durationMs = performance.now() - startedAt;
      if (disposed) return undefined;

      // Deduct actual cost from budget
      if (budget) {
        deductCost(budget, result.usage.estimatedCostUsd);
      }

      // Cache the result
      cache.set(feature, request.state, request.questions as Record<string, unknown>, mp, result);

      emitSafeActivity({
        feature, status: "completed",
        model: result.model,
        durationMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        estimatedCostUsd: result.usage.estimatedCostUsd,
        message: "Jev evaluation completed",
      });

      return result;
    } catch (error) {
      if (disposed) return undefined;
      const durationMs = performance.now() - startedAt;

      // Budget slot was consumed on admission — never refund on failure.
      // This is intentional: the slot is gone even on error.
      const msg = error instanceof Error ? error.message : "unknown";
      emitSafeActivity({ feature, status: "unavailable", durationMs, message: msg });

      return undefined;
    }
  }

  const runtime: ConsoleJevRuntime = {
    get enabled(): boolean {
      return !disposed && enabled;
    },
    get features(): readonly JevFeature[] {
      return config.features;
    },
    evaluator(feature: JevFeature) {
      if (disposed || !enabled || !config.features.includes(feature)) return undefined;
      return createBudgetedEvaluator(feature);
    },
    async evaluate(
      feature: JevFeature,
      request: JevEvaluationRequest,
      modelPolicy?: string,
    ): Promise<JevEvaluationResult | undefined> {
      const wrapped = runtime.evaluator(feature);
      if (!wrapped) return undefined;
      return wrapped.evaluate(request);
    },
    budget(): { remainingRequests: number; remainingCostUsd: number } | undefined {
      if (disposed || !budget) return undefined;
      return { remainingRequests: budget.remainingRequests, remainingCostUsd: budget.remainingCostUsd };
    },
    dispose(): void {
      disposed = true;
      cache.clear();
      rawEvaluatorCache.clear();
      budget = null;
    },
  };

  return runtime;
}

// ── ToolContext adapter ──

/**
 * Wraps a {@link ConsoleJevRuntime} for transport through ToolContext.
 * Provides a stable interface that subagent executors and tool handlers
 * consume without importing the console module directly.
 */
export interface ToolContextJevRuntime {
  readonly enabled: boolean;
  readonly features: readonly string[];
  evaluator(feature: string): { evaluate(req: JevEvaluationRequest): Promise<JevEvaluationResult | undefined> } | undefined;
  evaluate(feature: string, request: JevEvaluationRequest, modelPolicy?: string): Promise<JevEvaluationResult | undefined>;
  budget(): { remainingRequests: number; remainingCostUsd: number } | undefined;
}

export function toToolContextJevRuntime(runtime: ConsoleJevRuntime): ToolContextJevRuntime {
  return {
    get enabled() { return runtime.enabled; },
    get features() { return runtime.features as readonly string[]; },
    evaluator(feature: string) { return runtime.evaluator(feature as JevFeature); },
    evaluate(feature: string, request: JevEvaluationRequest, modelPolicy?: string) {
      return runtime.evaluate(feature as JevFeature, request, modelPolicy);
    },
    budget() { return runtime.budget(); },
  };
}

export { JevBudgetError, JevCache };
export type { SessionBudget };