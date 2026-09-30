import { z } from "zod";

/** Advisory evaluations only: probabilities never grant authority or verify an exploit. */
export type JevFeature = "browser" | "memory" | "dedupe" | "redteam" | "kernel" | "crash" | "radar" | "foxguard";
export type JevQuestion =
  | { type: "boolean"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };
export type JevAnswer =
  | { type: "boolean"; probability: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number> };
export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}
export interface JevEvaluationRequest {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, JevQuestion>;
  signal?: AbortSignal;
}
export interface JevEvaluationResult {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
  durationMs: number;
}
export interface JevEvaluator {
  evaluate(request: JevEvaluationRequest): Promise<JevEvaluationResult>;
}
interface JevCommonConfig {
  timeoutMs?: number;
  maxRequests?: number;
  maxCostUsd?: number;
  fetch?: typeof globalThis.fetch;
  onUsage?: (usage: JevUsage) => void;
}
export type JevConfig = JevCommonConfig & (
  // `vercel` calls the AI gateway directly with our own key — no per-org
  // attribution. `cloud` routes through the orchestrator, which calls the
  // same upstream model and bills the org's credits.
  | { provider: "vercel"; apiKey: string }
  | { provider: "cloud"; apiKey: string; cloudUrl?: string; feature?: JevFeature }
);

// ── Console / hosted Jev types ─────────────────────────────────────────────

/**
 * Console-scoped Jev configuration. Features array enables specific evaluators;
 * operator-only enablement — repo content cannot opt the user into egress/spend.
 * apiKey is accepted here but NEVER stored in checkpoints, persisted transcripts,
 * or serialised session state — it lives only in the in-memory evaluator factory
 * closure. Provider 'direct' uses the same evaluator as the scan pipeline
 * (env-configured); 'typesafe'/'vercel'/'cloud' use the supplied key.
 */
export interface ConsoleJevConfig {
  /** Provider namespace for evaluator dispatch. 'typesafe'/'vercel'/'cloud' wire
   *  to the matching hosted provider; 'direct' uses env-based resolution. */
  provider: "typesafe" | "vercel" | "cloud" | "direct";
  /** Feature names the console enables. Must be non-empty for any Jev tool to
   *  appear in the tool set. Pass an empty array to disable Jev entirely. */
  features: JevFeature[];
  /** Max total evaluation requests across ALL enabled features in this session. */
  maxRequests?: number;
  /** Max total USD spend across ALL enabled features (advisory reservation model,
   *  not billing — real charges happen at the provider level). */
  maxCostUsd?: number;
  /** Per-request timeout in milliseconds. Default 10_000. */
  timeoutMs?: number;
  /** Operator-approved read-only URLs for the browser assist feature. */
  readOnlyUrls?: string[];
  /** Provider API key or cloud token. NEVER included in persisted state. */
  apiKey?: string;
  /** Cloud host and token for hosted Jev sessions (provider: 'cloud'). */
  cloud?: {
    host: string;
    token: string;
  };
}

/**
 * One Jev evaluation activity record, emitted via onJevActivity. Sanitised —
 * no credentials, no raw state/evidence, no question text. The 'estimated'
 * vs 'billing' split lets the UI render estimated usage distinct from server-
 * settled charges.
 */
export interface ConsoleJevActivity {
  /** The feature that produced this activity. */
  feature: JevFeature | "prepass";
  /** Evaluation status. 'started' is emitted before dispatch; 'completed' or
   *  'unavailable' on resolution. */
  status: "started" | "completed" | "unavailable";
  /** Model identifier returned by the provider, when available. */
  model?: string;
  /** Duration of the evaluation in milliseconds. */
  durationMs?: number;
  /** Estimated input tokens (from server usage or reservation model). */
  inputTokens?: number;
  /** Estimated output tokens. */
  outputTokens?: number;
  /** Estimated USD cost based on reservation or returned usage. Never a billable
   *  amount — the provider/settlement system owns actual charges. */
  estimatedCostUsd?: number;
  /** Billing-resolution data from the hosted session API, when available.
   *  Present only during hosted-session settlement, never from estimated usage.
   *  The 'estimated' vs 'billing' split is deliberate. */
  billing?: {
    status: "settled" | "pending";
    chargedUsd?: number;
    fundingSource?: "included" | "prepaid";
  };
  /** Human-readable message for the activity feed. Never contains credentials
   *  or raw evidence. Limited to 280 characters. */
  message?: string;
}

const FEATURES: readonly JevFeature[] = ["browser", "memory", "dedupe", "redteam", "kernel", "crash", "radar", "foxguard"];
const INPUT_USD_PER_TOKEN = 0.042 / 1_000_000;
// Reserve the provider's full documented context before dispatch, including concurrent calls.
const MAX_INPUT_TOKENS = 65_536;
const REQUEST_RESERVATION_USD = MAX_INPUT_TOKENS * INPUT_USD_PER_TOKEN;
const probability = z.number().finite().min(0).max(1);
const questionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), instructions: z.string().min(1).max(8_192),
    criteria: z.object({ true: z.string().max(4_096), false: z.string().max(4_096) }).optional() }).strict(),
  z.object({ type: z.literal("choice"), instructions: z.string().min(1).max(8_192),
    criteria: z.record(z.string().min(1).max(128), z.string().max(4_096))
      .refine((value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 64) }).strict(),
]);
const normalizedAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), probability }),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(probability) }),
]);
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().max(MAX_INPUT_TOKENS),
  outputTokens: z.number().int().nonnegative(),
});

function positiveNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

/** Explicit feature enablement is the data-egress consent; possessing a key is not enablement. */
export function jevConfigFromEnvironment(
  feature: JevFeature,
  environment: Readonly<Record<string, string | undefined>>,
): JevConfig | undefined {
  const requested = (environment["ZERO_JEV_FEATURES"] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  for (const name of requested) {
    if (!FEATURES.includes(name as JevFeature)) throw new Error(`Unknown ZERO_JEV_FEATURES entry: ${name}`);
  }
  if (!requested.includes(feature)) return undefined;
  const provider = environment["ZERO_JEV_PROVIDER"] ?? "vercel";
  if (provider !== "vercel" && provider !== "cloud") {
    throw new Error("ZERO_JEV_PROVIDER must be vercel or cloud");
  }
  const common = {
    timeoutMs: positiveNumber(environment["ZERO_JEV_TIMEOUT_MS"], 10_000, "ZERO_JEV_TIMEOUT_MS"),
    maxRequests: positiveNumber(environment["ZERO_JEV_MAX_REQUESTS"], 100, "ZERO_JEV_MAX_REQUESTS"),
    maxCostUsd: positiveNumber(environment["ZERO_JEV_MAX_COST_USD"], 0.10, "ZERO_JEV_MAX_COST_USD"),
  };
  const keyName = provider === "cloud" ? "ZERO_JEV_CLOUD_TOKEN" : "AI_GATEWAY_API_KEY";
  const apiKey = environment[keyName]?.trim();
  if (!apiKey) throw new Error(`${keyName} is required when Jev assistance is enabled`);
  if (provider === "cloud") {
    return { provider, apiKey, cloudUrl: environment["ZERO_JEV_CLOUD_URL"], feature, ...common };
  }
  return {
    provider, apiKey, ...common,
  };
}


/** One instance owns one bounded workflow budget. No implicit retries or chat-model fallback. */
export function createJevEvaluator(config: JevConfig): JevEvaluator {
  if (!config.apiKey.trim()) throw new Error("A Jev provider credential is required");
  const timeoutMs = config.timeoutMs ?? 10_000;
  const maxRequests = config.maxRequests ?? 100;
  const maxCostUsd = config.maxCostUsd ?? 0.10;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 10_000
    || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    throw new Error("Invalid Jev timeout, request limit, or cost budget");
  }
  if (config.provider === "cloud") {
    const url = new URL(config.cloudUrl ?? "");
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      || url.username || url.password || url.search || url.hash || !config.feature || !FEATURES.includes(config.feature)) {
      throw new Error("Invalid Jev cloud evaluation endpoint or feature");
    }
  }
  let requests = 0;
  let chargedOrReservedUsd = 0;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  return {
    async evaluate(request) {
      request.signal?.throwIfAborted();
      const questions = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), questionSchema).parse(request.questions);
      const questionIds = Object.keys(questions);
      if (questionIds.length < 1 || questionIds.length > 64) throw new Error("Jev requires between 1 and 64 questions");
      const encoded = JSON.stringify({ state: request.state, questions });
      // Three UTF-8 bytes per UTF-16 unit is a conservative bound without copying the payload.
      if (encoded.length > 32_000) throw new Error("Jev state and questions exceed the bounded input limit");
      if (requests >= maxRequests || chargedOrReservedUsd + REQUEST_RESERVATION_USD > maxCostUsd) {
        throw new Error("Jev workflow evaluation budget exhausted");
      }
      requests++;
      chargedOrReservedUsd += REQUEST_RESERVATION_USD;
      const startedAt = performance.now();
      const signal = request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      let rawAnswers: Record<string, unknown>;
      let model: string;
      let rawUsage: unknown;
      try {
        if (config.provider === "cloud") {
          const response = await fetchImpl(config.cloudUrl!, {
            method: "POST", signal, redirect: "error",
            headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ feature: config.feature, state: request.state, questions }),
          });
          if (!response.ok) throw new Error(`Jev provider returned HTTP ${response.status}`);
          const body = z.object({ model: z.string().min(1), answers: z.record(z.unknown()), usage: usageSchema })
            .parse(await response.json());
          model = body.model;
          rawUsage = body.usage;
          rawAnswers = body.answers;
        } else {
          const [{ experimental_evaluate: evaluate }, { createGateway }] = await Promise.all([
            import("ai"), import("@ai-sdk/gateway"),
          ]);
          signal.throwIfAborted();
          const gateway = createGateway({ apiKey: config.apiKey, fetch: fetchImpl });
          const result = await evaluate({ model: gateway.evaluationModel("typesafe-ai/jev"),
            state: typeof request.state === "string" ? request.state : JSON.stringify(request.state),
            questions, abortSignal: signal, maxRetries: 0 });
          model = result.response.modelId;
          rawUsage = result.usage;
          rawAnswers = result.answers;
        }
        signal.throwIfAborted();
        const parsedUsage = usageSchema.parse(rawUsage);
        const usage = { ...parsedUsage, estimatedCostUsd: parsedUsage.inputTokens * INPUT_USD_PER_TOKEN };
        chargedOrReservedUsd += usage.estimatedCostUsd - REQUEST_RESERVATION_USD;
        config.onUsage?.(usage);
        if (Object.keys(rawAnswers).length !== questionIds.length) throw new Error("Jev returned unexpected answer IDs");
        const answers: Record<string, JevAnswer> = Object.create(null) as Record<string, JevAnswer>;
        for (const id of questionIds) {
          const question = questions[id]!;
          const answer = normalizedAnswerSchema.parse(rawAnswers[id]);
          if (question.type !== answer.type) throw new Error("Jev answer type does not match its question");
          if (question.type === "choice" && answer.type === "choice") {
            const options = Object.keys(question.criteria);
            if (!Object.hasOwn(question.criteria, answer.choice)
              || Object.keys(answer.probabilities).length !== options.length
              || options.some((option) => !Object.hasOwn(answer.probabilities, option))
              || Math.abs(options.reduce((sum, option) => sum + answer.probabilities[option]!, 0) - 1) > 0.02
              || options.some((option) => answer.probabilities[option]! > answer.probabilities[answer.choice]!)) {
              throw new Error("Jev returned an invalid choice distribution");
            }
          }
          answers[id] = answer;
        }
        return { model, answers, usage, durationMs: performance.now() - startedAt };
      } catch (error) {
        // Unknown provider usage retains the full reservation; never treat failed requests as free.
        if (signal.aborted) throw new Error(request.signal?.aborted ? "Jev evaluation cancelled" : "Jev evaluation timed out");
        if (error instanceof z.ZodError) throw new Error("Jev provider returned malformed evaluation data");
        // SDK errors can contain request bodies or credentials. Only our fixed errors may escape.
        if (error instanceof Error && /^Jev (provider returned HTTP \d{3}|returned (unexpected answer IDs|an invalid choice distribution)|answer type does not match its question)$/.test(error.message)) throw error;
        throw new Error("Jev evaluation unavailable; retain the existing decision path");
      }
    },
  };
}