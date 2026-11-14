import { type NativeRuntimeResult } from "../types.js";
import { LLM_429_MAX_RETRIES, LLM_MAX_RETRIES, LLM_STREAM_MAX_ATTEMPTS, resolveLimit } from "../../shared/limits.js";

/** HTTP statuses worth retrying: rate-limit (429) + transient 5xx. */
export function isRetryableHttpStatus(status: number): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

// ── Transient empty-stream retry (streaming ended with NO final response) ───
//
// Distinct from HTTP-status retry: a provider can accept a request, open an
// SSE stream, then close without a recognized final response. This classifier
// retains the existing bounded retry for that missing-final-response result;
// EOF alone does not establish why the stream ended.
//
// Explicit failures are not transient empty streams. Only a provider-confirmed
// max_output_tokens incompletion can return an observation-only checkpoint;
// its continuation belongs to the loop, never this same-request retry.
// "response stream failed" remains below for historical runtime results only.
// Auth/validation errors, timeouts, operator cancellations, and outcomes that
// already produced tool calls are not retried here.

/**
 * Substrings that identify a transient "the stream ended without a usable final
 * response" outcome — the ONLY error class {@link shouldRetryNativeStream}
 * retries. These are produced verbatim by {@link LlmApiRuntime.consumeResponsesStream}.
 */
export const TRANSIENT_STREAM_ERROR_PATTERNS: readonly string[] = [
  "stream completed without final response",
  "response stream failed",
];

/** Total attempts for a transient empty stream (1 initial + retries). `ZERO_LLM_STREAM_MAX_ATTEMPTS` (default 3). */
export function llmStreamMaxAttempts(): number {
  return resolveLimit(LLM_STREAM_MAX_ATTEMPTS);
}

/** Backoff before the Nth retry (1-based): ~500ms, then ~1s, then ~1s… */
export function streamRetryBackoffMs(retry: number): number {
  return retry <= 1 ? 500 : 1000;
}

/** Sleep `ms`, resolving early (never rejecting) if `signal` aborts first. */
export function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Pure decision: should this native result be retried as a transient empty
 * stream? True ONLY when the runtime reported `stopReason:"error"`, the error
 * message matches a {@link TRANSIENT_STREAM_ERROR_PATTERNS} substring, the call
 * was NOT an operator cancellation, and nothing usable was produced (no
 * tool_use blocks). A 4xx/auth/validation error ("API error 400: …"), a
 * timeout, a stall, a quota exhaustion, or an outcome carrying tool calls all
 * return false so genuine failures fail fast and useful work is never repeated.
 */
export function shouldRetryNativeStream(result: NativeRuntimeResult): boolean {
  if (result.stopReason !== "error") return false;
  if (result.cancelled) return false;
  const error = result.error ?? "";
  if (/automatic replay (?:is )?disabled|outcome.{0,30}unknown/i.test(error)) return false;
  if (!TRANSIENT_STREAM_ERROR_PATTERNS.some((pattern) => error.includes(pattern))) return false;
  // Defensive: a partial stream that still yielded tool calls is usable work —
  // never repeat it. (The transient returns carry no tool_use today, but this
  // keeps the predicate correct regardless of how the return is shaped.)
  if (result.content.some((block) => block.type === "tool_use")) return false;
  return true;
}

// ── Provider policy-refusal failover ────────────────────────────────────
//
// A provider-side safety classifier can reject a research request outright:
// OpenAI's Responses wire answers HTTP 200, streams, then terminates with
// `response.failed` and an error code like `cyber_policy` once accumulated
// attack evidence trips it. The refusal is terminal for THAT provider — the
// same content resubmitted to the same classifier refuses again — so the only
// recovery is a DIFFERENT provider. When ZERO_LLM_FALLBACK is configured,
// {@link LlmApiRuntime.executeNative} fails over and re-issues the request on
// the next entry; without a fallback chain the refusal stays terminal and the
// result is unchanged from the previous behaviour.
//
// Only Responses-wire terminal rejections count. `response.incomplete`
// (content_filter) has already yielded partial output through the stream
// callbacks, so replaying it wholesale would duplicate content — those keep
// the existing observation-checkpoint handling.

/** Marker `consumeResponsesStream` prefixes the embedded failure envelope with. */
export const RESPONSES_TERMINAL_FAILURE_MARKER = "Responses terminal failure ";

/**
 * Pure decision: did this native result terminate because the provider's
 * content policy refused the request? True ONLY for a Responses-wire terminal
 * failure whose error code names a policy classifier (`*_policy`, e.g.
 * `cyber_policy`). Quota, auth, rate-limit, transport and empty-stream
 * failures are different classes with their own recovery paths and return
 * false here.
 */
export function isPolicyRefusalResult(result: NativeRuntimeResult): boolean {
  if (result.stopReason !== "error" || result.cancelled) return false;
  const error = result.error ?? "";
  const at = error.indexOf(RESPONSES_TERMINAL_FAILURE_MARKER);
  if (at < 0) return false;
  try {
    const failure = JSON.parse(error.slice(at + RESPONSES_TERMINAL_FAILURE_MARKER.length)) as { code?: unknown };
    return typeof failure.code === "string" && failure.code.length > 0 && /_policy$/.test(failure.code);
  } catch {
    return false;
  }
}

/** Sum two optional usage readings into one honest total (all fields optional). */
export function mergeRuntimeUsage(
  a: NativeRuntimeResult["usage"],
  b: NativeRuntimeResult["usage"],
): NativeRuntimeResult["usage"] {
  const cached = (a?.cachedInputTokens ?? 0) + (b?.cachedInputTokens ?? 0);
  const cacheWrites = (a?.cacheWriteTokens ?? 0) + (b?.cacheWriteTokens ?? 0);
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    ...(cacheWrites > 0 ? { cacheWriteTokens: cacheWrites } : {}),
  };
}

export interface TransportFailure {
  code: string;
  message: string;
  beforeDispatch: boolean;
}

/** Node/Undici usually nests socket metadata in cause; Bun exposes it directly.
 * A closed POST connection alone does not prove the provider rejected the call.
 */
export function classifyTransportFailure(error: unknown): TransportFailure {
  const chain: Array<Record<string, unknown>> = [];
  const seen = new Set<object>();
  for (let value = error; value && typeof value === "object" && !seen.has(value) && chain.length < 8;) {
    seen.add(value);
    const entry = value as Record<string, unknown>;
    chain.push(entry);
    value = entry.cause;
  }
  const knownCodes = ["EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT",
    "ETIMEDOUT", "ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "CONNECTION_CLOSED", "ConnectionClosed", "ERR_SOCKET_CLOSED"];
  const candidates = chain.filter(entry => typeof entry.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(entry.code));
  const metadata = candidates.find(entry => knownCodes.includes(entry.code as string)) ?? candidates[0] ?? {};
  let code = typeof metadata.code === "string" ? metadata.code : "unknown";
  const message = error instanceof Error ? error.message : String(error);
  const closedMessage = chain.some(entry => typeof entry.message === "string" && /socket(?: connection)? (?:was )?closed|other side closed|socket hang up/i.test(entry.message));
  if (code === "ConnectionClosed" || code === "ERR_SOCKET_CLOSED" || (code === "unknown" && closedMessage)) code = "CONNECTION_CLOSED";
  // DNS resolution, refused/unreachable connects and explicit connect timeouts
  // cannot have submitted the inference POST. Generic timeouts/resets can.
  const beforeDispatch = ["EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"].includes(code)
    || (code === "ETIMEDOUT" && metadata.syscall === "connect")
    || (["ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "CONNECTION_CLOSED"].includes(code)
      && Boolean(metadata.socket && typeof metadata.socket === "object" && (metadata.socket as { bytesWritten?: unknown }).bytesWritten === 0));
  return { code, beforeDispatch, message: closedMessage || code === "CONNECTION_CLOSED" ? "The connection closed before a complete response was received" : message };
}

export function unknownTransportOutcome(provider: string, failure: TransportFailure): string {
  return `${provider} transport failure [${failure.code}]: ${failure.message}. Request outcome may be unknown. Automatic replay is disabled`;
}

/** Max retries after the initial attempt. `ZERO_LLM_MAX_RETRIES` (default 6). */
export function llmMaxRetries(): number {
  return resolveLimit(LLM_MAX_RETRIES);
}

/** Cumulative backoff cap in ms. `ZERO_LLM_MAX_RETRY_WAIT_MS` (default 60s). */
export function llmMaxRetryWaitMs(): number {
  const raw = process.env["ZERO_LLM_MAX_RETRY_WAIT_MS"];
  if (raw == null || raw.trim() === "") return 60_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/**
 * Max retries after the initial attempt for 429 rate-limits specifically.
 * `ZERO_LLM_429_MAX_RETRIES` → `ZERO_LLM_MAX_RETRIES` → default 12.
 *
 * ChatGPT/Codex per-minute rate limits reset every ~60s; the generic 6-retry
 * budget exhausts in ~14s (verified in prod raw_logs 2026-07-15: "HTTP 429 —
 * backoff 14144ms (retry 6/6)" then "model did not emit a usable variant
 * plan"), so a rate-limited call could not survive a single limiter window.
 * The 429 budget is sized to span several windows instead.
 */
export function llm429MaxRetries(): number {
  return resolveLimit(LLM_429_MAX_RETRIES);
}

/**
 * Cumulative 429 backoff cap in ms.
 * `ZERO_LLM_429_MAX_RETRY_WAIT_MS` → `ZERO_LLM_MAX_RETRY_WAIT_MS` →
 * default 5 min. Bounds server-guided (`Retry-After`) waits; the per-call
 * abort timer (`config.timeout`) still applies as the outer bound.
 */
export function llm429MaxRetryWaitMs(): number {
  const raw =
    process.env["ZERO_LLM_429_MAX_RETRY_WAIT_MS"] ??
    process.env["ZERO_LLM_MAX_RETRY_WAIT_MS"];
  if (raw == null || raw.trim() === "") return 300_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 300_000;
}

/**
 * Plan-quota exhaustion: a subscription or credit pool is spent and resets in
 * hours/days, so retrying is pointless. The supported wire forms are Codex's
 * `usage_limit_reached` and Alibaba Model Studio Token Plan's
 * `insufficient_quota`. `postWithRetry` advances an explicit fallback chain
 * immediately; when no fallback is usable it throws this typed error instead
 * of burning the per-minute retry budget against a day-scale reset.
 */
export class QuotaExhaustedError extends Error {
  override readonly name = "QuotaExhaustedError";
  readonly quotaKind?: string;
  readonly planType?: string;
  readonly resetsAtMs?: number;
  readonly resetsInSeconds?: number;

  constructor(message: string, details: UsageLimitDetails) {
    super(message);
    this.quotaKind = details.quotaKind;
    this.planType = details.planType;
    this.resetsAtMs = details.resetsAtMs;
    this.resetsInSeconds = details.resetsInSeconds;
  }
}

/**
 * Operator cancellation: the caller handed `executeNative` an `AbortSignal`
 * (the console's Esc) and it fired.
 *
 * This is a sibling of {@link QuotaExhaustedError} and exists for the same
 * reason — some failures must NOT be retried, and the retry loop can only know
 * that if the failure carries its own type. Retrying a request the operator
 * just cancelled is not merely wasteful, it silently defeats the cancellation;
 * so is failing over to a second provider. Both paths check for this error and
 * rethrow it immediately.
 *
 * Deliberately distinct from the runtime's OWN aborts (the per-call timeout
 * and the SSE idle watchdog), which stay transient-class and keep their
 * existing retry/report behaviour. Those surface as an `AbortError`
 * `DOMException` and are classified by message; this one is classified by
 * type, so the two can never be confused.
 */
export class OperatorAbortError extends Error {
  override readonly name = "OperatorAbortError";
  constructor(message = "request cancelled by operator") {
    super(message);
  }
}

/**
 * Per-call abort composition.
 *
 * A call has up to two independent abort sources that must NOT clobber each
 * other: the runtime's own per-call timeout (`AbortController` + `setTimeout`,
 * unchanged) and the operator's signal. `signal` is what goes on the wire —
 * either alone or unioned — while `operatorAborted()` records WHICH of the two
 * fired first, because by the time `fetch` rejects, both look like the same
 * anonymous `AbortError`.
 *
 * The race is resolved in favour of whichever fired first: the operator
 * listener only latches when the timeout has not already aborted, so a
 * timeout that is immediately followed by an operator abort is still reported
 * as a timeout — preserving the pre-existing "API request timed out" path
 * byte for byte.
 */
export interface CallAbort {
  /** Handed to `fetch` and `sleepWithAbort`. Identical to the timeout signal when no operator signal was supplied. */
  readonly signal: AbortSignal;
  /** The operator's raw signal, when supplied — needed to race the SSE reader without catching timeout aborts. */
  readonly operator?: AbortSignal;
  /** True once the OPERATOR signal fired first. Never true for a timeout or stall. */
  operatorAborted(): boolean;
  /** Throw {@link OperatorAbortError} if the operator cancelled. Terminal — callers must not swallow it. */
  throwIfCancelled(): void;
  /** Detach the listeners this composition installed on the (long-lived) operator signal. */
  dispose(): void;
}

export const NO_OPERATOR_ABORT: Omit<CallAbort, "signal"> = {
  operatorAborted: () => false,
  throwIfCancelled: () => {},
  dispose: () => {},
};

/**
 * Union two abort signals without `AbortSignal.any`. Only used if the host
 * lacks it; `package.json` requires Node >= 24, where it has existed since
 * Node 20, so in practice `AbortSignal.any` is what runs. The manual path is
 * kept because it is four lines and removes the need to reason about the
 * platform at all.
 *
 * `detach` unsubscribes both listeners when the call ends, so a session-long
 * operator signal does not accumulate one listener per model call.
 */
export function manualAnySignal(sources: AbortSignal[], detach: AbortSignal): AbortSignal {
  const merged = new AbortController();
  for (const source of sources) {
    if (source.aborted) {
      merged.abort(source.reason);
      return merged.signal;
    }
    source.addEventListener("abort", () => merged.abort(source.reason), {
      once: true,
      signal: detach,
    });
  }
  return merged.signal;
}

/**
 * Compose the per-call timeout signal with an optional operator signal.
 *
 * With no operator signal this returns the timeout signal ITSELF (not a copy,
 * not a union), so every existing code path sees exactly the object it saw
 * before and behaviour is unchanged.
 */
export function composeCallAbort(timeout: AbortSignal, operator?: AbortSignal): CallAbort {
  if (!operator) return { signal: timeout, ...NO_OPERATOR_ABORT };

  // Latched at construction for an already-aborted signal; `timeout` cannot
  // have fired yet at that point, so this cannot mislabel a timeout.
  let operatorFired = operator.aborted;
  const detach = new AbortController();
  operator.addEventListener(
    "abort",
    () => {
      if (!timeout.aborted) operatorFired = true;
    },
    { once: true, signal: detach.signal },
  );

  const signal =
    typeof AbortSignal.any === "function"
      ? AbortSignal.any([timeout, operator])
      : manualAnySignal([timeout, operator], detach.signal);

  return {
    signal,
    operator,
    operatorAborted: () => operatorFired,
    throwIfCancelled: () => {
      if (operatorFired) throw new OperatorAbortError();
    },
    dispose: () => detach.abort(),
  };
}

/** Parsed fields of a supported plan-quota-exhaustion 429 body. */
export interface UsageLimitDetails {
  quotaKind?: "usage_limit_reached" | "insufficient_quota";
  planType?: string;
  resetsAtMs?: number;
  resetsInSeconds?: number;
}

/**
 * Classify a 429 response body as plan-quota exhaustion. Codex nests
 * `{"error":{"type":"usage_limit_reached","plan_type":"pro",
 * "resets_at":<epoch-s>,"resets_in_seconds":<n>}}`; Alibaba Model Studio
 * Token Plan returns `{"error":{"type":"insufficient_quota",
 * "code":"insufficient_quota",…}}`. Everything else remains a regular
 * retryable rate limit.
 *
 * The historical name is preserved because it is exported from the runtime
 * API; callers now receive a `quotaKind` that distinguishes the wire forms.
 */
export function parseUsageLimitReached(
  body: string,
): UsageLimitDetails | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  const root =
    typeof json === "object" && json !== null
      ? (json as Record<string, unknown>)
      : undefined;
  const err =
    typeof root?.error === "object" && root.error !== null
      ? (root.error as Record<string, unknown>)
      : root;
  const errorType = typeof err?.type === "string" ? err.type : undefined;
  const errorCode = typeof err?.code === "string" ? err.code : undefined;
  const quotaKind =
    errorType === "usage_limit_reached"
      ? "usage_limit_reached"
      : errorType === "insufficient_quota" || errorCode === "insufficient_quota"
        ? "insufficient_quota"
        : undefined;
  if (!quotaKind || !err) return undefined;

  const details: UsageLimitDetails = { quotaKind };
  if (typeof err.plan_type === "string") {
    details.planType = err.plan_type;
  } else if (quotaKind === "insufficient_quota") {
    // Alibaba's Token Plan response has no plan_type; preserve a useful,
    // stable label for telemetry and terminal errors.
    details.planType = "token-plan";
  }
  if (typeof err.resets_in_seconds === "number" && Number.isFinite(err.resets_in_seconds)) {
    details.resetsInSeconds = err.resets_in_seconds;
  }
  if (typeof err.resets_at === "number" && Number.isFinite(err.resets_at)) {
    // Wire form is epoch seconds; tolerate an epoch-ms value defensively.
    details.resetsAtMs =
      err.resets_at > 1e12 ? err.resets_at : err.resets_at * 1000;
  }
  if (details.resetsAtMs == null && details.resetsInSeconds != null) {
    details.resetsAtMs = Date.now() + details.resetsInSeconds * 1000;
  }
  // Alibaba Token Plan carries the reset in the message TEXT, not a numeric
  // field: "Your token-plan 1-week quota has been exhausted. The quota will
  // reset at 08-20 15:24:00 UTC." (the 5-hour variant omits the UTC suffix).
  // Month-day only — assume the current year, roll forward if it lands past.
  if (details.resetsAtMs == null && quotaKind === "insufficient_quota") {
    const message = typeof err.message === "string" ? err.message : "";
    const m = message.match(
      /resets? at (\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\s*UTC)?/,
    );
    if (m) {
      const now = Date.now();
      const year = new Date(now).getUTCFullYear();
      const at = (y: number) =>
        Date.UTC(y, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
      const ts = at(year);
      details.resetsAtMs = ts > now ? ts : at(year + 1);
    }
  }
  return details;
}

/**
 * Idle watchdog for STREAMING (SSE) calls, in ms.
 * `ZERO_LLM_STREAM_IDLE_TIMEOUT_MS` (default 120s).
 *
 * The streaming (responses-wireApi) branch keeps the overall call timer ARMED
 * through the stream, but that bound is the whole-call budget — routinely
 * raised far above this for long generations — so it is too coarse for a
 * silent socket: a server that accepts the request and then holds the SSE
 * stream open without emitting a single byte (queue/hold) hung the whole scan
 * silently until the outer sandbox timeout — the "$0 cost, zero output, died
 * at timeout" failure shape reproduced 2026-07-17 against the ChatGPT Codex
 * backend on both E2B and microsandbox. An idle window with NO bytes at all
 * is never legitimate progress (a healthy stream emits reasoning/text deltas
 * or keep-alives continuously), so we fail the call as a transient-class
 * stall: the agent loop's bounded backoff applies, then the run exits loudly
 * via errorExit instead of hanging.
 */
export function llmStreamIdleTimeoutMs(): number {
  const raw = process.env["ZERO_LLM_STREAM_IDLE_TIMEOUT_MS"];
  if (raw == null || raw.trim() === "") return 120_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

/**
 * EVENT-level idle watchdog for STREAMING (SSE) calls, in ms.
 * `ZERO_LLM_STREAM_EVENT_IDLE_TIMEOUT_MS` (default 240s).
 *
 * The byte-level watchdog above is defeated by keep-alives: a server (or the
 * CDN in front of it — the ChatGPT Codex backend hangs exactly this way on
 * queued headless requests, observed 2026-09) can hold the stream open for
 * hours while emitting periodic SSE comment lines (`: keep-alive`) that reset
 * the byte clock without a single real `data:` event ever arriving. The call
 * then survives until the outer sandbox timeout — "$0 cost, zero output,
 * died at timeout" with the idle watchdog never firing.
 *
 * This second bound measures time since the last MEANINGFUL SSE event (a
 * non-empty `data:` payload), not since the last byte. Keep-alive comments,
 * `event:`-only frames and whitespace heartbeats do NOT reset it, so a
 * keep-alive-only hold fails as the same transient-class stall. The default
 * is deliberately looser than the byte watchdog (2×): a provider in a long
 * silent-reasoning phase that emits only keep-alives (e.g. OpenRouter's
 * `: OPENROUTER PROCESSING`) is still legitimate progress up to this window.
 * Independent of the byte bound on purpose — whichever fires first wins; a
 * totally silent stream still dies at the byte watchdog's tighter bound.
 */
export function llmStreamEventIdleTimeoutMs(): number {
  const raw = process.env["ZERO_LLM_STREAM_EVENT_IDLE_TIMEOUT_MS"];
  if (raw == null || raw.trim() === "") return 240_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 240_000;
}

/**
 * Parse a `Retry-After` header into ms. Supports both the delta-seconds form
 * ("5") and the HTTP-date form ("Wed, 21 Oct 2026 07:28:00 GMT"). Returns
 * undefined when the header is absent or unparseable so the caller falls back
 * to exponential backoff.
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/** Exponential backoff with full jitter. `attempt` is 0-based: ~0.5s, 1s, 2s … capped at `ceilingMs` (default 20s; the 429 path passes 30s to stretch across a per-minute limiter window). */
export function retryBackoffMs(attempt: number, ceilingMs = 20_000): number {
  const ceiling = Math.min(ceilingMs, 500 * 2 ** attempt);
  return Math.floor(Math.random() * ceiling) + 250;
}

/** Cap on a server-guided 429 wait: a `Retry-After` longer than this is clamped, not honored verbatim. */
export const RETRY_AFTER_CAP_MS = 120_000;

/**
 * Server-guided wait for a 429, in ms. Reads `retry-after-ms` (millisecond
 * integer, OpenAI platform form) first, then `retry-after` (delta-seconds or
 * HTTP-date), clamped to RETRY_AFTER_CAP_MS. Returns undefined when neither
 * header is present/parseable so the caller falls back to jittered backoff.
 */
export function retryAfterMsFromHeaders(headers: Headers | undefined): number | undefined {
  const msHeader = headers?.get?.("retry-after-ms");
  if (msHeader != null) {
    const n = Number.parseInt(msHeader.trim(), 10);
    if (Number.isFinite(n) && n >= 0) return Math.min(n, RETRY_AFTER_CAP_MS);
  }
  const parsed = parseRetryAfterMs(headers?.get?.("retry-after"));
  return parsed != null ? Math.min(parsed, RETRY_AFTER_CAP_MS) : undefined;
}

/** Sleep that rejects with an AbortError if `signal` fires mid-wait (respects the request budget). */
export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted during retry backoff", "AbortError"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted during retry backoff", "AbortError"));
      },
      { once: true },
    );
  });
}
