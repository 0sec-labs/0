/**
 * Model-provider HTTP transport for the long-lived engine.
 *
 * Root cause this exists for (docs/design/core-toolset.md, "Engine failure seen
 * during the A/B"): under Node the global `fetch` negotiates HTTP/2 and keeps
 * ONE multiplexed TLS session per origin for the life of the process. After
 * concurrent large inference POSTs the provider answered with a TLS
 * `bad_record_mac` alert (`ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC`, http2ErrorCode 2),
 * and every later call reused the same dead session and failed instantly with
 * `fetch failed`, so the engine never recovered until restarted. The cause code
 * was also invisible because it contains `/`, which the old code filter rejected.
 *
 * So model calls go through a dedicated HTTP/1.1 dispatcher (one connection per
 * request, no shared multiplexed session) with a bounded connect timeout, and the
 * dispatcher is replaced whenever a call dies at the connection level so a bad
 * pooled connection can never outlive the call that found it.
 *
 * Bun (the compiled binary) has its own fetch; it ignores `dispatcher` and is left alone.
 */

interface Closable { close?: () => Promise<void>; destroy?: () => Promise<void> }
type DispatcherCtor = new (options: Record<string, unknown>) => Closable;

export interface ModelTransportStats {
  /** Model calls that failed at the connection level since the last success. */
  consecutiveFailures: number;
  failedCalls: number;
  /** Times the connection pool was thrown away and rebuilt after a connection-level failure. */
  recycles: number;
  lastFailureCode: string | null;
  /** Active TCP handles in this process (sockets to providers, tools and the console alike). */
  openSockets: number;
  http: "1.1" | "runtime-default";
}

const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
const state = { consecutive: 0, failed: 0, recycles: 0, lastCode: null as string | null };
let dispatcher: Closable | undefined;
let generation = 0;

function canOwnDispatcher(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun === "undefined" && process.env["ZERO_LLM_SHARED_DISPATCHER"] !== "1";
}

function createDispatcher(): Closable | undefined {
  if (!canOwnDispatcher()) return undefined;
  // Node does not expose undici's classes; the global dispatcher's constructor is one.
  // Only a plain Agent is replaced: a proxy-aware agent is the operator's choice and is left alone.
  const current = (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER] as { constructor?: { name?: string } } | undefined;
  const Ctor = current?.constructor;
  if (typeof Ctor !== "function" || Ctor.name !== "Agent") return undefined;
  try {
    return new (Ctor as unknown as DispatcherCtor)({
      allowH2: false,
      connect: { timeout: positiveInt(process.env["ZERO_LLM_CONNECT_TIMEOUT_MS"], 20_000) },
      keepAliveTimeout: 5_000,
      keepAliveMaxTimeout: 30_000,
    });
  } catch { return undefined; }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The dispatcher model calls use, or undefined to use the runtime's default. */
export function modelDispatcher(): Closable | undefined {
  if (dispatcher === undefined && canOwnDispatcher()) { dispatcher = createDispatcher(); generation++; }
  return dispatcher;
}

/** Drop the pool: in-flight requests finish on the old one, new calls get fresh connections. */
export function recycleModelDispatcher(): void {
  const old = dispatcher;
  dispatcher = undefined;
  state.recycles++;
  if (!old) return;
  // close() lets in-flight streams finish; destroy() is the backstop so nothing lingers.
  void old.close?.().catch(() => undefined);
  const timer = setTimeout(() => { void old.destroy?.().catch(() => undefined); }, 120_000);
  timer.unref?.();
}

/** The most specific `code` in an error's cause chain, e.g. `ECONNRESET` or `ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC`. */
export function causeCode(error: unknown): string | undefined {
  let found: string | undefined;
  const seen = new Set<unknown>();
  for (let v = error as { code?: unknown; cause?: unknown } | undefined; v && typeof v === "object" && !seen.has(v) && seen.size < 8; v = v.cause as typeof v) {
    seen.add(v);
    if (typeof v.code === "string" && /^[\w./:-]{1,96}$/.test(v.code)) found = v.code;
  }
  return found;
}

/** `fetch` for model-provider calls: dedicated dispatcher, failure accounting, self-healing pool. */
export const modelFetch: typeof fetch = async (input, init) => {
  const d = modelDispatcher();
  const started = generation;
  try {
    const res = await fetch(input, d ? { ...init, dispatcher: d } as RequestInit : init);
    state.consecutive = 0;
    return res;
  } catch (error) {
    const aborted = init?.signal?.aborted === true || (error as { name?: string } | undefined)?.name === "AbortError";
    if (!aborted) {
      state.consecutive++; state.failed++;
      state.lastCode = causeCode(error) ?? "unknown";
      // Only the pool that served this call is discarded; a newer one may already be healthy.
      if (generation === started) recycleModelDispatcher();
    }
    throw error;
  }
};

export function modelTransportStats(): ModelTransportStats {
  const sockets = typeof process.getActiveResourcesInfo === "function"
    ? process.getActiveResourcesInfo().filter(name => name === "TCPSocketWrap").length : 0;
  return { consecutiveFailures: state.consecutive, failedCalls: state.failed, recycles: state.recycles, lastFailureCode: state.lastCode,
    openSockets: sockets, http: dispatcher ? "1.1" : "runtime-default" };
}

/** Test seam: forget accounting and drop the pool. */
export function resetModelTransportForTests(): void { state.consecutive = 0; state.failed = 0; state.recycles = 0; state.lastCode = null; dispatcher = undefined; }
