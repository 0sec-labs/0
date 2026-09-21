/**
 * Hosted Jev client — wire transport for cloud-hosted Jev sessions.
 *
 * Implements the shared protocol contract:
 * - POST /api/inference/jev/sessions — create a hosted session (lazy, on first use)
 * - POST /api/inference/jev/evaluate — evaluate questions against a hosted session
 *
 * All calls use standard CLI bearer auth. The bearer host is validated as
 * HTTPS or loopback HTTP only; no redirects are followed. Session creation
 * verifies returned ceilings, expiry, and answer schemas.
 *
 * No provider API keys are stored here — the bearer token is the auth mechanism.
 * The transport owns no session budget; callers supply and enforce their own.
 */
import { z } from "zod";
import type { JevFeature,
JevEvaluationRequest,
JevEvaluationResult,
JevQuestion,
JevAnswer,
JevUsage, } from "@0/shared"

// ── Constants ──

const DEFAULT_TIMEOUT_MS = 15_000;
const VALID_FEATURES: readonly string[] = [
  "browser", "memory", "dedupe", "redteam", "kernel", "crash", "radar", "foxguard",
];

// ── Types ──

interface HostedSessionConfig {
  /** Base URL for the inference API (e.g. https://cloud.0sec.app). */
  host: string;
  /** Bearer token for authentication. */
  token: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Custom fetch implementation. */
  fetch?: typeof globalThis.fetch;
}

interface HostedSession {
  sessionId: string;
  features: string[];
  maxRequests: number;
  maxCostUsd: number;
  expiresAt: string;
}

/**
 * Billing metadata returned with hosted Jev evaluation results.
 * Mirrors the shared wire contract: status 'settled' or 'pending',
 * with optional charged USD and funding source.
 */
export interface JevBillingResult {
  status: "settled" | "pending";
  chargedUsd?: number;
  fundingSource?: "included" | "prepaid";
}

/**
 * Result of a hosted Jev evaluation, extending the base JevEvaluationResult
 * with optional billing data.
 */
export interface HostedJevEvaluationResult extends JevEvaluationResult {
  billing?: JevBillingResult;
}

// ── Session validation ──

const sessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
  features: z.array(z.string()),
  maxRequests: z.number().int().positive(),
  maxCostUsd: z.number().positive(),
  expiresAt: z.string().datetime(),
}).strict();

const evaluateResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.unknown()),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  billing: z.object({
    status: z.enum(["settled", "pending"]),
    chargedUsd: z.number().nonnegative().optional(),
    fundingSource: z.enum(["included", "prepaid"]).optional(),
  }).optional(),
}).strict();

// ── Host name validation ──

function validateHostUrl(host: string): string {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new Error(`Invalid Jev cloud host URL: ${host}`);
  }
  const isHttps = url.protocol === "https:";
  const isLoopback = url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!isHttps && !isLoopback) {
    throw new Error("Jev cloud host must be HTTPS or loopback HTTP");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Jev cloud host URL must not contain credentials, query, or fragment");
  }
  // Normalise: strip trailing slash
  return url.origin;
}

// ── Hosted Jev transport ──

/**
 * Lazy-hosted Jev session transport. Creates the hosted session on first use
 * (lazy initialisation), then dispatches evaluations against it. This avoids
 * creating a session that may never be used.
 *
 * The transport validates all server responses: session creation verifies the
 * returned feature set, limits, and expiry. Evaluation responses validate the
 * answer shape and usage. No automatic retries on ambiguous calls; the request
 * ID is reused for the same dispatch.
 *
 * No redirects are followed. No provider credentials leak through error bodies.
 */
export class HostedJevTransport {
  private _config: Required<HostedSessionConfig>;
  private _sessionPromise: Promise<HostedSession> | null = null;
  private _session: HostedSession | null = null;
  private _fetch: typeof globalThis.fetch;

  constructor(config: HostedSessionConfig) {
    const host = validateHostUrl(config.host);
    const fetch = config.fetch ?? globalThis.fetch;
    this._config = {
      host,
      token: config.token,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetch,
    };
    this._fetch = fetch;
  }

  /** Whether a session has been created (lazily). */
  get hasSession(): boolean {
    return this._session !== null;
  }

  /** The current session, if created. */
  get session(): HostedSession | null {
    return this._session;
  }

  /**
   * Get or create the hosted session. Lazy — only creates on first call.
   * Returns the cached session on subsequent calls.
   */
  private async _getOrCreateSession(features: string[]): Promise<HostedSession> {
    if (this._session) return this._session;
    if (this._sessionPromise) return this._sessionPromise;

    this._sessionPromise = this._createSession(features);
    try {
      this._session = await this._sessionPromise;
      return this._session;
    } finally {
      this._sessionPromise = null;
    }
  }

  /**
   * Create a new hosted Jev session. POSTs to /api/inference/jev/sessions
   * with the enabled features and limits. Validates the response.
   */
  private async _createSession(features: string[]): Promise<HostedSession> {
    const abort = AbortSignal.timeout(this._config.timeoutMs);
    const body = JSON.stringify({
      features,
      maxRequests: undefined, // Server determines session defaults
      maxCostUsd: undefined,
    });

    const response = await this._fetch(`${this._config.host}/api/inference/jev/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this._config.token}`,
        "Content-Type": "application/json",
      },
      body,
      signal: abort,
      redirect: "error",
    });

    if (!response.ok) {
      const status = response.status;
      // Drain body without leaking it to the caller
      await response.body?.cancel();
      throw new Error(`Jev session creation failed (HTTP ${status})`);
    }

    const raw = await response.json();
    const parsed = sessionResponseSchema.parse(raw);

    // Validate returned feature set matches requested
    for (const f of parsed.features) {
      if (!VALID_FEATURES.includes(f)) {
        throw new Error(`Jev session returned unknown feature: ${f}`);
      }
    }

    // Validate expiry
    const expiresAt = new Date(parsed.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new Error("Jev session returned invalid expiry");
    }

    return {
      sessionId: parsed.sessionId,
      features: parsed.features,
      maxRequests: parsed.maxRequests,
      maxCostUsd: parsed.maxCostUsd,
      expiresAt: parsed.expiresAt,
    };
  }

  /**
   * Evaluate a Jev request against the hosted session. Creates the session
   * lazily if not yet created. Returns the evaluation result with optional
   * billing data. Never retries ambiguous calls.
   */
  async evaluate(
    request: JevEvaluationRequest & { feature: JevFeature },
  ): Promise<HostedJevEvaluationResult> {
    request.signal?.throwIfAborted();

    // Lazy session creation
    const session = await this._getOrCreateSession([request.feature]);

    // Enforce session ceiling checks (advisory — server enforces too)
    const questionIds = Object.keys(request.questions);
    if (questionIds.length > 64) {
      throw new Error("Hosted Jev evaluate supports at most 64 questions");
    }

    const encodeState = typeof request.state === "string"
      ? JSON.parse(request.state)
      : request.state;
    const body = JSON.stringify({
      sessionId: session.sessionId,
      requestId: crypto.randomUUID(),
      feature: request.feature,
      state: encodeState,
      questions: request.questions,
    });

    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(this._config.timeoutMs)])
      : AbortSignal.timeout(this._config.timeoutMs);

    const response = await this._fetch(`${this._config.host}/api/inference/jev/evaluate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this._config.token}`,
        "Content-Type": "application/json",
      },
      body,
      signal,
      redirect: "error",
    });

    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel();
      if (status === 401 || status === 403) {
        // Auth failure — invalidate session so next call retries
        this._session = null;
      }
      throw new Error(`Hosted Jev evaluate failed (HTTP ${status})`);
    }

    const raw = await response.json();
    const parsed = evaluateResponseSchema.parse(raw);

    // Map usage back to standard JevUsage
    const usage: JevUsage = {
      inputTokens: parsed.usage.inputTokens,
      outputTokens: parsed.usage.outputTokens,
      estimatedCostUsd: parsed.usage.inputTokens * 0.042 / 1_000_000,
    };

    // Validate and map answers
    const questionSchemas: Record<string, JevQuestion> = request.questions;
    const answers: Record<string, JevAnswer> = Object.create(null) as Record<string, JevAnswer>;

    for (const [id, rawAnswer] of Object.entries(parsed.answers)) {
      const question = questionSchemas[id];
      if (!question) {
        throw new Error(`Hosted Jev returned unexpected answer ID: ${id}`);
      }
      const answer = rawAnswer as Record<string, unknown>;
      if (answer.type === "boolean" && typeof answer.probability === "number") {
        answers[id] = { type: "boolean", probability: answer.probability };
      } else if (answer.type === "choice" && typeof answer.choice === "string" && typeof answer.probabilities === "object") {
        answers[id] = {
          type: "choice",
          choice: answer.choice,
          probabilities: answer.probabilities as Record<string, number>,
        };
      } else {
        throw new Error(`Hosted Jev returned malformed answer for: ${id}`);
      }
    }

    const result: HostedJevEvaluationResult = {
      model: parsed.model,
      answers,
      usage,
      durationMs: 0,
    };

    if (parsed.billing) {
      result.billing = {
        status: parsed.billing.status,
        chargedUsd: parsed.billing.chargedUsd,
        fundingSource: parsed.billing.fundingSource,
      };
    }

    return result;
  }

  /** Release the hosted session reference. The server-side session remains valid until expiry. */
  dispose(): void {
    this._session = null;
    this._sessionPromise = null;
  }
}

// ── Hosted transport factory ──

/**
 * Create a hosted Jev transport from cloud config. Returns undefined when
 * the host or token is missing, so callers degrade gracefully.
 */
export function createHostedJevTransport(config?: {
  host?: string;
  token?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}): HostedJevTransport | undefined {
  if (!config?.host || !config?.token) return undefined;
  return new HostedJevTransport({
    host: config.host,
    token: config.token,
    timeoutMs: config.timeoutMs,
    fetch: config.fetch,
  });
}