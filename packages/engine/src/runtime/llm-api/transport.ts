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
 * Why the first version never actually recovered (found by a reproducer: 4 parallel
 * 100-150KB POSTs per turn against the real API failed with bad_record_mac by turn ~11):
 *  - Node 24+/26 bundles undici 8 and keeps the real global Agent under
 *    `undici.globalDispatcher.2`; `.1` is a `Dispatcher1Wrapper`. The old code looked
 *    only at `.1`, found a class not named "Agent", and silently installed NOTHING, so
 *    every call still shared one H2 session and "recycling" was a counter increment.
 *  - The compiled binary runs under Bun, whose fetch ignores `dispatcher`; its pooled
 *    keep-alive sockets were never dropped either. Bun gets `keepalive: false` instead
 *    (one connection per request), which cannot carry poison from one call to the next.
 * A recycle now builds a brand-new Agent with its own connector, no TLS session cache
 * (`maxCachedSessions: 0`, so no resumption ticket is ever replayed) and destroys the old one.
 */

import { subscribe } from "node:diagnostics_channel";
import { createSecureContext } from "node:tls";

interface Closable { close?: () => Promise<void>; destroy?: () => Promise<void> }
type DispatcherCtor = new (options: Record<string, unknown>) => Closable;

export interface ModelTransportStats {
  /** Model calls that failed at the connection level since the last success. */
  consecutiveFailures: number;
  failedCalls: number;
  /** Times the connection pool was thrown away and rebuilt after a connection-level failure. */
  recycles: number;
  lastFailureCode: string | null;
  /** Whether the most recent TLS connection resumed a cached session (null until one is observed). Always false when sessions are disabled. */
  lastSessionReused: boolean | null;
  /** Active TCP handles in this process (sockets to providers, tools and the console alike). */
  openSockets: number;
  http: "1.1" | "runtime-default" | "bun-no-keepalive";
}

// Node >= 24 keeps the real Agent under `.2` (undici 8) and a v1 wrapper under `.1`.
const GLOBAL_DISPATCHERS = [Symbol.for("undici.globalDispatcher.2"), Symbol.for("undici.globalDispatcher.1")];
const state = { consecutive: 0, failed: 0, recycles: 0, lastCode: null as string | null, sessionReused: null as boolean | null };
let extraConnect: Record<string, unknown> = {};
let tlsError: { code: string; at: number } | undefined;
let globalReady: Promise<void> | undefined;
let dispatcher: Closable | undefined;
let generation = 0;

try { subscribe("undici:client:connected", message => observeConnection((message as { socket?: unknown }).socket)); } catch { /* diagnostics_channel unavailable */ }

const isBun = (): boolean => typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

function canOwnDispatcher(): boolean {
  return !isBun() && process.env["ZERO_LLM_SHARED_DISPATCHER"] !== "1";
}

/** Node creates its global Agent lazily on the first fetch; a `data:` fetch forces it without touching the network. */
function ensureGlobalDispatcher(): Promise<void> {
  if (!canOwnDispatcher() || GLOBAL_DISPATCHERS.some(sym => (globalThis as Record<symbol, unknown>)[sym])) return Promise.resolve();
  globalReady ??= fetch("data:,").then(r => r.arrayBuffer()).then(() => undefined, () => undefined);
  return globalReady;
}

/** Record whether the TLS session of a freshly opened connection was resumed (diagnostic only). */
function observeConnection(socket: unknown): void {
  const s = socket as { isSessionReused?: () => boolean; once?: (event: string, listener: (error: { code?: unknown }) => void) => unknown } | undefined;
  if (typeof s?.isSessionReused === "function") { try { state.sessionReused = s.isSessionReused(); } catch { /* socket already gone */ } }
  // undici may surface a TLS alert only as "other side closed"; keep the real code for diagnostics.
  s?.once?.("error", error => { if (typeof error?.code === "string") tlsError = { code: error.code, at: Date.now() }; });
}

function createDispatcher(): Closable | undefined {
  if (!canOwnDispatcher()) return undefined;
  // Node does not expose undici's classes; the global dispatcher's constructor is one.
  // Only a plain Agent is replaced: a proxy-aware agent is the operator's choice and is left alone.
  let Ctor: { name?: string } | undefined;
  for (const sym of GLOBAL_DISPATCHERS) {
    const candidate = ((globalThis as Record<symbol, unknown>)[sym] as { constructor?: { name?: string } } | undefined)?.constructor;
    if (typeof candidate === "function" && candidate.name === "Agent") { Ctor = candidate; break; }
  }
  if (!Ctor) return undefined;
  try {
    return new (Ctor as unknown as DispatcherCtor)({
      allowH2: false,
      connect: {
        timeout: positiveInt(process.env["ZERO_LLM_CONNECT_TIMEOUT_MS"], 20_000),
        // Fresh TLS state per dispatcher: its own SecureContext, and no session cache, so
        // no resumption ticket from a poisoned connection can ever be replayed.
        secureContext: createSecureContext(extraConnect["ca"] ? { ca: extraConnect["ca"] as string } : undefined),
        maxCachedSessions: 0,
        session: undefined,
        ...extraConnect,
      },
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
  // close() stops the old pool taking new work and lets healthy in-flight siblings finish (destroying
  // at once turned one failure into N); destroy() shortly after guarantees no socket outlives it.
  void old.close?.().catch(() => undefined);
  const timer = setTimeout(() => { void old.destroy?.().catch(() => undefined); }, 30_000);
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
  await ensureGlobalDispatcher();
  const d = modelDispatcher();
  const started = generation;
  // Bun ignores `dispatcher`; `keepalive: false` is its way to get one fresh connection per request.
  const bunInit = isBun() && process.env["ZERO_LLM_SHARED_DISPATCHER"] !== "1" ? { keepalive: false } : undefined;
  try {
    const res = await fetch(input, d ? { ...init, dispatcher: d } as RequestInit : bunInit ? { ...init, ...bunInit } as RequestInit : init);
    state.consecutive = 0;
    return res;
  } catch (error) {
    const aborted = init?.signal?.aborted === true || (error as { name?: string } | undefined)?.name === "AbortError";
    if (!aborted) {
      state.consecutive++; state.failed++;
      const code = causeCode(error);
      const tls = tlsError && Date.now() - tlsError.at < 5_000 && (!code || code === "UND_ERR_SOCKET" || code === "ECONNRESET") ? tlsError.code : undefined;
      state.lastCode = tls ?? code ?? "unknown";
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
    lastSessionReused: state.sessionReused, openSockets: sockets,
    http: dispatcher ? "1.1" : isBun() && process.env["ZERO_LLM_SHARED_DISPATCHER"] !== "1" ? "bun-no-keepalive" : "runtime-default" };
}

/** Test seam: extra TLS connect options (e.g. `ca` for a local self-signed server). */
export function setModelConnectOptionsForTests(options: Record<string, unknown>): void { extraConnect = options; dispatcher = undefined; }

/** Test seam: forget accounting and drop the pool. */
export function resetModelTransportForTests(): void { state.consecutive = 0; state.failed = 0; state.recycles = 0; state.lastCode = null; state.sessionReused = null; tlsError = undefined; dispatcher = undefined; }
