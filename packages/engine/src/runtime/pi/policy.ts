/**
 * Transport policy for the pi-ai runtime, installed as pi's `fetch` option
 * (verified supported by the anthropic-messages, openai-completions,
 * openai-responses and google-generative-ai api modules in pi-ai 1.5.2).
 *
 * It re-implements, at the HTTP boundary, the behaviours LlmApiRuntime has in
 * `postWithRetry`, so both runtimes honour the same operator contracts:
 *   - ZERO_REQUIRE_REQUEST_ADMISSION: gateway byte-limit check before dispatch
 *   - 429 / 5xx retry with Retry-After + jittered backoff and the 429 budget
 *   - plan-quota exhaustion (`usage_limit_reached` / `insufficient_quota`):
 *     never retried; fails over when a chain is configured, else QuotaExhaustedError
 *   - transport failures: only PRE-dispatch socket errors are replayed; an
 *     unknown outcome is never replayed ("Automatic replay is disabled")
 *   - ZERO_REQUIRE_RETRY_SAFE_RECEIPT: a non-2xx without `x-0-retry-safe: 1`
 *     is an unknown outcome and is never replayed
 *   - operator cancellation is terminal (no retry, no failover)
 *
 * pi's SDK layer wraps whatever we throw into a generic provider error string,
 * so typed outcomes are recorded on a per-call {@link PolicyState} that the
 * runtime reads after the stream ends.
 */
import { diag } from "../../diagnostics/channel.js";
import {
  QuotaExhaustedError,
  classifyTransportFailure,
  isRetryableHttpStatus,
  llm429MaxRetries,
  llm429MaxRetryWaitMs,
  llmMaxRetries,
  llmMaxRetryWaitMs,
  parseRetryAfterMs,
  parseUsageLimitReached,
  retryAfterMsFromHeaders,
  retryBackoffMs,
  sleepWithAbort,
  unknownTransportOutcome,
} from "../llm-api/retry.js";
import {
  LOCAL_ADMISSION_UNAVAILABLE,
  assertRequestAdmission,
  parseRequestAdmission,
  type RequestAdmission,
} from "../request-admission.js";

export type FailoverReason = "plan quota exhausted" | "429 retry budget exhausted";

/** Per-call record of typed outcomes pi's SDK layer would otherwise flatten into a string. */
export interface PolicyState {
  /** Set when the caller must switch to the next fallback entry and re-issue the request. */
  failover?: FailoverReason;
  /** Terminal typed failure thrown from the fetch layer (quota, unknown outcome, admission, ...). */
  failure?: Error;
  /** Status of a non-2xx response the policy layer already retried/handed back; the outer stream-retry must not repeat it. */
  httpStatus?: number;
}

export interface PolicyFetchOptions {
  env: Readonly<NodeJS.ProcessEnv>;
  label: string;
  /** Configured provider base URL; the admission catalog is `<baseUrl>/models` exactly like LlmApiRuntime. */
  baseUrl: string;
  state: PolicyState;
  /** Operator signal composed with our timeout; aborts are terminal. */
  signal: AbortSignal;
  /** Operator-only check, so a timeout is never mislabelled as a cancellation. */
  operatorAborted: () => boolean;
  /** Ask the owner to advance its fallback chain; true means "failover engaged, re-issue". */
  tryFailover: (reason: FailoverReason) => boolean;
  /** Catalog cache shared across calls so admission does one GET per route. */
  admissionCache: Map<string, Promise<RequestAdmission>>;
  baseFetch?: typeof fetch;
}

export class FailoverRequested extends Error {
  override readonly name = "FailoverRequested";
  constructor(readonly reason: FailoverReason) { super(`failover requested: ${reason}`); }
}

function headersOf(init?: RequestInit): Headers {
  return new Headers(init?.headers as HeadersInit | undefined);
}

async function gatewayAdmission(
  options: PolicyFetchOptions,
  url: URL,
  init: RequestInit | undefined,
  model: string,
): Promise<RequestAdmission> {
  const origin = url.origin;
  // Same configured provider origin and credentials as the inference POST; redirects cannot move the capability.
  const identity = JSON.stringify([origin, model]);
  let pending = options.admissionCache.get(identity);
  if (!pending) {
    const base = options.baseFetch ?? fetch;
    const catalogUrl = `${options.baseUrl.replace(/\/+$/, "")}/models`;
    const authHeaders = headersOf(init);
    authHeaders.delete("content-length");
    pending = (async () => {
      try {
        // foxguard: ignore[js/no-ssrf]
        const response = await base(catalogUrl, { headers: authHeaders, signal: options.signal, redirect: "error" });
        if (!response.ok) throw new Error(`${LOCAL_ADMISSION_UNAVAILABLE} catalog HTTP ${response.status}; no inference request sent`);
        return parseRequestAdmission(await response.json(), model);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(LOCAL_ADMISSION_UNAVAILABLE)) throw error;
        throw new Error(`${LOCAL_ADMISSION_UNAVAILABLE} catalog unavailable or invalid; no inference request sent`);
      }
    })();
    options.admissionCache.set(identity, pending);
    pending.catch(() => { if (options.admissionCache.get(identity) === pending) options.admissionCache.delete(identity); });
  }
  return pending;
}

/** Build a `fetch` implementing the retry / failover / replay-safety policy above. */
export function createPolicyFetch(options: PolicyFetchOptions): typeof fetch {
  const { env, label, state } = options;
  const retrySafe = env["ZERO_REQUIRE_RETRY_SAFE_RECEIPT"] === "1";
  const fail = (error: Error): never => { state.failure ??= error; throw error; };

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const base = options.baseFetch ?? fetch;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    // Only the inference POST is policy-managed; anything else passes straight through.
    if (method !== "POST") return base(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    let waited429Ms = 0;
    let waitedOtherMs = 0;
    for (let attempt = 0; ; attempt++) {
      if (options.operatorAborted()) throw new DOMException("cancelled by operator", "AbortError");

      if (env["ZERO_REQUIRE_REQUEST_ADMISSION"] === "1" && typeof init?.body === "string") {
        let model = "";
        try { model = String((JSON.parse(init.body) as { model?: unknown }).model ?? ""); } catch { /* admission below rejects */ }
        try { assertRequestAdmission(init.body, await gatewayAdmission(options, url, init, model)); }
        catch (error) { return fail(error instanceof Error ? error : new Error(String(error))); }
      }

      let res: Response;
      try {
        res = await base(input, { ...init, redirect: "error" });
      } catch (error) {
        if (options.operatorAborted()) throw error;
        const failure = classifyTransportFailure(error);
        if (!failure.beforeDispatch) return fail(new Error(unknownTransportOutcome(label, failure), { cause: error }));
        if (retrySafe) return fail(new Error(`${label} connection failed before inference dispatch [${failure.code}]. Automatic replay is disabled by the configured retry policy`, { cause: error }));
        const delay = retryBackoffMs(attempt);
        if (attempt < llmMaxRetries() && waitedOtherMs + delay <= llmMaxRetryWaitMs() && !options.signal.aborted) {
          diag.warn("transport_retry", `${label} pre-dispatch transport ${failure.code} — backoff ${delay}ms`, { provider: label, cause_code: failure.code, delay_ms: delay, attempt: attempt + 1 });
          waitedOtherMs += delay;
          await sleepWithAbort(delay, options.signal);
          continue;
        }
        return fail(new Error(`${label} connection failed before inference dispatch [${failure.code}]: ${failure.message}`, { cause: error }));
      }

      if (!res.ok && retrySafe && res.headers.get("x-0-retry-safe") !== "1") {
        await res.body?.cancel();
        return fail(new Error(`${label} gateway HTTP ${res.status}; request outcome may be unknown. Automatic replay is disabled`));
      }
      if (!res.ok) state.httpStatus = res.status;
      if (res.ok || !isRetryableHttpStatus(res.status)) return res;

      // Retry and failover are both wrong after an operator cancellation.
      if (options.operatorAborted()) throw new DOMException("cancelled by operator", "AbortError");

      const is429 = res.status === 429;
      let bodyText: string | undefined;
      if (is429) {
        try { bodyText = await res.text(); } catch { bodyText = undefined; }
        const quota = bodyText != null ? parseUsageLimitReached(bodyText) : undefined;
        if (quota) {
          const resetsAtIso = quota.resetsAtMs != null ? new Date(quota.resetsAtMs).toISOString() : "unknown";
          const quotaKind = quota.quotaKind ?? "quota_exhausted";
          diag.error("quota_exhausted", `${label} ${quotaKind} — plan quota exhausted; skipping retry`, { provider: label, quota_kind: quotaKind, plan: quota.planType ?? "unknown", resets_at: resetsAtIso, status: res.status });
          if (options.tryFailover("plan quota exhausted")) { state.failover = "plan quota exhausted"; throw new FailoverRequested("plan quota exhausted"); }
          return fail(new QuotaExhaustedError(`${label} ${quotaKind}: plan quota exhausted (plan=${quota.planType ?? "unknown"}, resets_at=${resetsAtIso}) — reschedulable after reset`, quota));
        }
      }
      const handBack = (): Response => is429 && bodyText != null
        ? new Response(bodyText, { status: res.status, statusText: res.statusText, headers: res.headers })
        : res;
      const maxRetries = is429 ? llm429MaxRetries() : llmMaxRetries();
      const maxWaitMs = is429 ? llm429MaxRetryWaitMs() : llmMaxRetryWaitMs();
      const waitedMs = is429 ? waited429Ms : waitedOtherMs;
      const exhausted = (): Response => {
        if (is429 && options.tryFailover("429 retry budget exhausted")) { state.failover = "429 retry budget exhausted"; throw new FailoverRequested("429 retry budget exhausted"); }
        return handBack();
      };
      if (attempt >= maxRetries) return exhausted();
      const retryAfter = is429 ? retryAfterMsFromHeaders(res.headers) : parseRetryAfterMs(res.headers?.get?.("retry-after"));
      const delay = retryAfter ?? retryBackoffMs(attempt, is429 ? 30_000 : 20_000);
      if (waitedMs + delay > maxWaitMs) return exhausted();
      if (!is429) { try { await res.text(); } catch { /* best-effort drain */ } }
      diag.warn("http_retry", `${label} HTTP ${res.status} — backoff ${delay}ms (retry ${attempt + 1}/${maxRetries})`, { provider: label, status: res.status, delay_ms: delay, attempt: attempt + 1, max_retries: maxRetries });
      if (is429) waited429Ms += delay; else waitedOtherMs += delay;
      await sleepWithAbort(delay, options.signal);
    }
  }) as typeof fetch;
}
