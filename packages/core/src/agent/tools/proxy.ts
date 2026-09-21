/**
 * Intercepting HTTP(S) proxy tool (SCAFFOLD — burp-network-20260913).
 *
 * A Burp-Suite-style intercepting proxy, re-cut for CLI/agent use. Where Burp
 * gives a human a GUI with an HTTP-history table, a Repeater, and a
 * match/replace panel, this exposes the SAME capabilities through ONE `proxy`
 * tool with an `action` enum the native loop can drive turn-by-turn:
 *
 *   start   — bring up an in-process HTTP(S) forward proxy on a local port and
 *             begin recording every request/response pair it relays.
 *   stop    — tear the proxy down (frees the port; history is retained).
 *   status  — is it running, on what port, how many entries captured, CA path.
 *   history — LIST captured traffic (Burp's "HTTP history"), with a filter
 *             (host / method / status / url-substring / since).
 *   inspect — dump ONE captured entry in full (headers + bounded bodies).
 *   replay  — re-send a captured request with modifications (Burp "Repeater"):
 *             override method / url / headers / body, scope-gated, re-recorded.
 *   intercept — manage MATCH/REPLACE + intercept-and-modify rules applied to
 *             in-flight traffic (Burp "Match and Replace" / "Intercept").
 *
 * DESIGN + DEP DECISION (see scratchpad/spec-burp.md for the full rationale):
 *   - The TRANSPORT is pure Node: `http`/`https`/`net`/`tls` + CONNECT tunnel
 *     handling. Zero new runtime dependency for the proxy itself.
 *   - The ONE thing Node's stdlib cannot do ergonomically is mint an X.509 CA
 *     + per-host leaf certs for HTTPS MITM. That is isolated behind the driver
 *     seam. The recommended dep is a tiny cert-gen lib (`selfsigned` ~1 dep, or
 *     `node-forge`); it is NOT added to package.json here — see WIRING TODO #3.
 *   - The real proxy server therefore lives behind a lazy, guarded
 *     {@link ProxyDriver} seam. The factory dynamically imports the backend and,
 *     when it is absent, returns a clear "proxy backend not available" error
 *     instead of throwing at import time. This module TYPECHECKS with no backend
 *     present: there is no top-level backend import, and the dynamic import uses
 *     a NON-LITERAL specifier so tsc cannot try to resolve it.
 *
 * The {@link ProxyHistoryStore} is REAL (not stubbed): add/list/filter/get run
 * purely in memory, so history / inspect / replay-shape are exercisable in unit
 * tests with no proxy process ever started.
 *
 * SCOPE POSTURE: the proxy is a powerful, effectful capability, gated exactly
 * like `http_request` / `browser`. Every host it would relay to and every
 * `replay` target is checked through {@link effectiveScope}`.match()`; an
 * out-of-scope host is refused with a `ToolResult.error` and never contacted.
 */
import type { ScopePolicy } from "../../scope/scope.js";
import type { ToolDefinition, ToolResult } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition (mirrors the per-domain module shape: `*ToolDefinitions` +
// `*Dispatch`, exactly like oast.ts / system.ts / browser.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** The action surface, kept as a const tuple so the handler and schema agree. */
export const PROXY_ACTIONS = [
  "start",
  "stop",
  "status",
  "history",
  "inspect",
  "replay",
  "intercept",
] as const;

export type ProxyAction = (typeof PROXY_ACTIONS)[number];

/** Default listen port when the caller omits `port`. */
export const DEFAULT_PROXY_PORT = 8080;

/** Default page size for a `history` listing (bounded so a card stays small). */
export const DEFAULT_HISTORY_LIMIT = 50;

/** Bytes of request/response body retained per captured entry. */
export const MAX_CAPTURED_BODY_BYTES = 64 * 1024;

/** Install hint surfaced when the proxy backend is unavailable. */
export const PROXY_INSTALL_HINT =
  "proxy backend not available — the HTTPS-MITM CA generator is not installed (add `selfsigned` or `node-forge`; see spec-burp.md WIRING TODO #3)";

export const proxyToolDefinitions: Record<string, ToolDefinition> = {
  proxy: {
    name: "proxy",
    description:
      "Burp-style intercepting HTTP(S) proxy for agent-driven pentesting. Bring up an in-process forward proxy, " +
      "record every request/response it relays, and inspect/replay/tamper with the traffic. Actions: " +
      "start (listen on a local port and begin recording; HTTPS is MITM'd with a generated CA), " +
      "stop (tear down; captured history is kept), " +
      "status (running?/port/entry count/CA path), " +
      "history (list captured traffic, optionally filtered by host/method/status/url substring/since — Burp 'HTTP history'), " +
      "inspect (full headers + bodies for one entry by id), " +
      "replay (re-send a captured request with method/url/header/body overrides — Burp 'Repeater'), " +
      "intercept (manage match/replace + intercept-and-modify rules applied to in-flight traffic). " +
      "Every relayed host and every replay target is gated through the engagement scope exactly like http_request; " +
      "out-of-scope hosts are refused and never contacted.",
    parameters: {
      action: {
        type: "string",
        description: "Proxy action",
        enum: [...PROXY_ACTIONS],
      },
      port: {
        type: "number",
        description: `Local TCP port to listen on for start (default ${DEFAULT_PROXY_PORT}).`,
      },
      id: {
        type: "string",
        description: "Captured-entry id (for inspect / replay), e.g. req-12.",
      },
      filter: {
        type: "object",
        description:
          "history filter: { host?, method?, status?, url_contains?, since? (epoch ms), limit? }. All fields optional; combined with AND.",
      },
      request_overrides: {
        type: "object",
        description:
          "replay overrides applied on top of the captured request: { method?, url?, headers? (merged; null value deletes), body? }. The final url is scope-gated before any bytes are sent.",
      },
      rules: {
        type: "array",
        description:
          "intercept match/replace rules to install: array of { in: 'req'|'res', part: 'url'|'header'|'body', match: string (regex), replace: string, name? }. Applied to in-flight traffic while the proxy runs.",
        items: { type: "object" },
      },
      mode: {
        type: "string",
        description:
          "intercept sub-command: 'set' (install `rules`, replacing existing), 'add' (append `rules`), 'list' (show installed rules), 'clear' (remove all). Default 'list'.",
      },
    },
    required: ["action"],
  },
};

/**
 * Tool-name → ToolExecutor handler-method name (0#614). Assembled by
 * ./dispatch.ts; resolved off the executor instance in agent/tools.ts. The
 * handler is a thin delegate that calls {@link executeProxy} (mirrors
 * `startScan → executeStartScan`), holding the cross-turn {@link ProxyHost}.
 */
export const proxyDispatch: Record<string, string> = {
  proxy: "proxyAction",
};

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-history store. REAL, pure, in-memory — the Burp "HTTP history" table.
// list/filter/get work with no proxy process, so tests exercise them directly.
// ─────────────────────────────────────────────────────────────────────────────

/** One captured request/response pair (Burp history row + detail). */
export interface CapturedEntry {
  id: string;
  timestamp: number;
  /** How the entry entered the store: relayed by the proxy, or produced by replay. */
  source: "proxy" | "replay";
  method: string;
  url: string;
  host: string;
  requestHeaders: Record<string, string>;
  /** Bounded to {@link MAX_CAPTURED_BODY_BYTES}; `truncated` flags a clipped body. */
  requestBody?: string;
  requestBodyTruncated?: boolean;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyTruncated?: boolean;
  durationMs?: number;
  /** For a replay entry: the id it was derived from. */
  replayOf?: string;
  /** Free-form notes (e.g. "match/replace rule R2 fired"). */
  notes?: string[];
}

/** A compact history row for a `history` listing (bodies elided). */
export interface CapturedRow {
  id: string;
  timestamp: number;
  source: CapturedEntry["source"];
  method: string;
  url: string;
  host: string;
  status?: number;
  durationMs?: number;
  replayOf?: string;
}

/** Filter passed to {@link ProxyHistoryStore.list}. */
export interface HistoryFilter {
  host?: string;
  method?: string;
  status?: number;
  url_contains?: string;
  /** Only entries at/after this epoch-ms timestamp. */
  since?: number;
  limit?: number;
}

function clip(body: string | undefined): { body?: string; truncated?: boolean } {
  if (body === undefined) return {};
  if (body.length <= MAX_CAPTURED_BODY_BYTES) return { body };
  return { body: body.slice(0, MAX_CAPTURED_BODY_BYTES), truncated: true };
}

/**
 * In-memory capture log. Newest-last insertion order; `list` returns newest
 * first (like Burp's history, most-recent on top). Bounded by `maxEntries` so a
 * long-running proxy cannot grow unbounded (oldest evicted first).
 */
export class ProxyHistoryStore {
  private readonly entries: CapturedEntry[] = [];
  private seq = 0;

  constructor(private readonly maxEntries = 5_000) {}

  /** Record a captured pair, minting an id and bounding the bodies. */
  add(entry: Omit<CapturedEntry, "id" | "timestamp"> & { timestamp?: number }): CapturedEntry {
    const reqClip = clip(entry.requestBody);
    const resClip = clip(entry.responseBody);
    const stored: CapturedEntry = {
      ...entry,
      id: `req-${++this.seq}`,
      timestamp: entry.timestamp ?? Date.now(),
      requestBody: reqClip.body,
      requestBodyTruncated: reqClip.truncated,
      responseBody: resClip.body,
      responseBodyTruncated: resClip.truncated,
    };
    this.entries.push(stored);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    return stored;
  }

  /** One entry by id, or undefined. */
  get(id: string): CapturedEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Filtered, newest-first, bounded list of compact rows. */
  list(filter: HistoryFilter = {}): CapturedRow[] {
    const limit = filter.limit && filter.limit > 0 ? filter.limit : DEFAULT_HISTORY_LIMIT;
    const method = filter.method?.toUpperCase();
    const urlNeedle = filter.url_contains?.toLowerCase();
    const rows: CapturedRow[] = [];
    // Iterate newest-first.
    for (let i = this.entries.length - 1; i >= 0 && rows.length < limit; i--) {
      const e = this.entries[i];
      if (filter.host && e.host !== filter.host) continue;
      if (method && e.method.toUpperCase() !== method) continue;
      if (filter.status !== undefined && e.status !== filter.status) continue;
      if (urlNeedle && !e.url.toLowerCase().includes(urlNeedle)) continue;
      if (filter.since !== undefined && e.timestamp < filter.since) continue;
      rows.push({
        id: e.id,
        timestamp: e.timestamp,
        source: e.source,
        method: e.method,
        url: e.url,
        host: e.host,
        status: e.status,
        durationMs: e.durationMs,
        replayOf: e.replayOf,
      });
    }
    return rows;
  }

  /** Total captured entries (pre-filter). */
  size(): number {
    return this.entries.length;
  }

  /** Drop all captured traffic (does not stop the proxy). */
  clear(): void {
    this.entries.length = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Intercept (match/replace) rules — Burp "Match and Replace". Pure data + a
// tiny applier so `intercept list/set/add/clear` is testable with no proxy; the
// running driver consults the same installed rules for in-flight tampering.
// ─────────────────────────────────────────────────────────────────────────────

export interface InterceptRule {
  name: string;
  /** Apply to the request or the response. */
  in: "req" | "res";
  /** Which part of the message the regex runs against. */
  part: "url" | "header" | "body";
  /** Regex source (compiled with the `g` flag). */
  match: string;
  /** Replacement string (supports `$1` backrefs). */
  replace: string;
}

/** Validate + normalize a raw rule object from tool args. */
export function parseInterceptRule(raw: unknown, idx: number): InterceptRule | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: `rule[${idx}] must be an object` };
  const r = raw as Record<string, unknown>;
  const inSide = r.in;
  if (inSide !== "req" && inSide !== "res") return { error: `rule[${idx}].in must be 'req' or 'res'` };
  const part = r.part;
  if (part !== "url" && part !== "header" && part !== "body")
    return { error: `rule[${idx}].part must be 'url'|'header'|'body'` };
  if (typeof r.match !== "string" || r.match.length === 0) return { error: `rule[${idx}].match (regex) is required` };
  if (typeof r.replace !== "string") return { error: `rule[${idx}].replace (string) is required` };
  try {
    // eslint-disable-next-line no-new
    new RegExp(r.match, "g");
  } catch (err) {
    return { error: `rule[${idx}].match is not a valid regex: ${err instanceof Error ? err.message : String(err)}` };
  }
  const name = typeof r.name === "string" && r.name.length > 0 ? r.name : `R${idx + 1}`;
  return { name, in: inSide, part, match: r.match, replace: r.replace };
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver seam. The handler talks ONLY to these interfaces; the concrete backend
// (the real http/https/net proxy + the CA/leaf cert generator) is loaded lazily
// by the factory. Nothing here references a backend's types, so the module
// typechecks with the backend absent.
// ─────────────────────────────────────────────────────────────────────────────

/** A composed HTTP request, used for replay and for the interceptor sink. */
export interface ProxyRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** A response captured from the upstream (or synthesized by an intercept rule). */
export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body?: string;
  durationMs?: number;
}

/** Options handed to {@link ProxyDriver.start}. */
export interface ProxyStartOptions {
  port: number;
  /**
   * Per-request scope gate. The driver MUST call this for every relayed request
   * (both plain HTTP and the decrypted CONNECT/MITM path) and refuse — respond
   * 403 locally, contact nothing — when it returns false. Mirrors the
   * `context.route` scope pin the browser tool uses.
   */
  allowHost: (host: string) => boolean;
  /**
   * Installed match/replace rules, read live so `intercept set/add/clear` takes
   * effect without a restart.
   */
  getRules: () => InterceptRule[];
  /** Called after each relayed pair is captured; the handler pushes it into the store. */
  onCapture: (pair: { request: ProxyRequest; response: ProxyResponse }) => void;
}

/** A running-proxy handle + the one-shot replay transport. */
export interface ProxyDriver {
  /** Bring the listener up; resolves with the bound port + CA cert path (for client trust). */
  start(opts: ProxyStartOptions): Promise<{ port: number; caCertPath: string }>;
  /** True while the listener is bound. */
  isRunning(): boolean;
  /** Send ONE request upstream (used by `replay`); does not require the listener to be up. */
  send(req: ProxyRequest, opts: { timeoutMs: number }): Promise<ProxyResponse>;
  /** Tear the listener down; frees the port. Safe to call when not running. */
  stop(): Promise<void>;
}

/** Factory contract — resolves a driver, or a guard error when the backend is missing. */
export type ProxyDriverFactory = (
  opts: { publicNetwork?: boolean },
) => Promise<{ driver: ProxyDriver } | { error: string }>;

/**
 * Minimal structural view of the backend module we lazily import. Local so the
 * module typechecks with no backend on disk. Only the members the driver
 * actually touches are declared.
 */
interface ProxyBackendModule {
  createProxyBackend(opts: { publicNetwork?: boolean }): ProxyDriver;
}

/**
 * Default factory. Dynamically imports the proxy backend; on any import failure
 * (backend/CA-generator not installed) returns a clear, actionable error rather
 * than throwing — so the tool degrades gracefully exactly like `browser` does.
 *
 * The specifier is held in a variable so TypeScript treats `import(spec)` as
 * `Promise<any>` and does NOT try to resolve it at compile time — this is what
 * keeps the module typechecking with the backend absent. The named module does
 * not exist yet (Phase 2 builds it); until then this always returns the guard
 * error, which is exactly what the "backend unavailable" test asserts.
 */
export const createProxyDriver: ProxyDriverFactory = async (opts) => {
  const spec = "./proxy-backend.js";
  let mod: ProxyBackendModule;
  try {
    mod = (await import(spec)) as unknown as ProxyBackendModule;
  } catch {
    return { error: PROXY_INSTALL_HINT };
  }
  if (typeof mod?.createProxyBackend !== "function") {
    return { error: PROXY_INSTALL_HINT };
  }
  return { driver: mod.createProxyBackend(opts) };
};

// ─────────────────────────────────────────────────────────────────────────────
// Handler. Standalone `executeProxy(ctx, args, deps?)` that routes actions,
// gates egress through scope, and drives the (lazy) driver. Deps are injectable
// so the "backend unavailable" path, history store, and arg-validation are
// unit-testable without a real proxy.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Narrow slice of {@link import("../types.js").ToolContext} the proxy handler
 * needs. A real `ToolContext` is assignable to this, so the executor's
 * `proxyAction` can call `executeProxy(this.ctx, args, ...)` without adaptation.
 */
export interface ProxyToolContext {
  target: string;
  scope?: ScopePolicy;
  publicNetwork?: { readonly scope?: ScopePolicy };
}

/**
 * Per-session proxy state, held by the host executor across tool calls: the
 * running driver, the (real) capture store, the port, and the installed
 * intercept rules. Created lazily; injected by tests.
 */
export interface ProxyHost {
  driver?: ProxyDriver | null;
  store?: ProxyHistoryStore;
  port?: number;
  caCertPath?: string;
  rules?: InterceptRule[];
}

export interface ProxyToolDeps {
  /** Override the backend factory (tests inject a fake or a forced-missing one). */
  createDriver?: ProxyDriverFactory;
  /** Cross-call proxy state. When omitted, a fresh, ephemeral host is used per call. */
  host?: ProxyHost;
  /** Per-replay timeout in ms (default 15s). */
  replayTimeoutMs?: number;
}

const DEFAULT_REPLAY_TIMEOUT_MS = 15_000;

function fail(error: string): ToolResult {
  return { success: false, output: null, error };
}

/** Effective scope for proxy egress — public-network scope wins when set. */
function effectiveScope(ctx: ProxyToolContext): ScopePolicy | undefined {
  return ctx.publicNetwork ? ctx.publicNetwork.scope : ctx.scope;
}

/** Gate a candidate URL through scope. Unscoped scans keep today's behaviour. */
function gateUrl(ctx: ProxyToolContext, url: string): { ok: true } | { ok: false; reason: string } {
  const scope = effectiveScope(ctx);
  if (!scope) return { ok: true };
  const verdict = scope.match(url);
  if (!verdict.allowed) return { ok: false, reason: verdict.reason };
  return { ok: true };
}

/** Host-portion allow test used by the running proxy's per-request gate. */
function hostAllowed(ctx: ProxyToolContext, host: string): boolean {
  const scope = effectiveScope(ctx);
  if (!scope) return true;
  // Probe with a canonical https URL so the scope host-matcher sees the host.
  return scope.match(`https://${host}/`).allowed;
}

function ensureStore(host: ProxyHost): ProxyHistoryStore {
  if (!host.store) host.store = new ProxyHistoryStore();
  return host.store;
}

function parseFilter(raw: unknown): HistoryFilter {
  if (typeof raw !== "object" || raw === null) return {};
  const f = raw as Record<string, unknown>;
  const out: HistoryFilter = {};
  if (typeof f.host === "string") out.host = f.host;
  if (typeof f.method === "string") out.method = f.method;
  if (typeof f.status === "number") out.status = f.status;
  if (typeof f.url_contains === "string") out.url_contains = f.url_contains;
  if (typeof f.since === "number") out.since = f.since;
  if (typeof f.limit === "number") out.limit = f.limit;
  return out;
}

/** Compose the effective replay request from a captured entry + overrides. */
export function composeReplay(
  entry: CapturedEntry,
  overrides: Record<string, unknown> | undefined,
): { request: ProxyRequest } | { error: string } {
  const ov = (overrides ?? {}) as {
    method?: unknown;
    url?: unknown;
    headers?: unknown;
    body?: unknown;
  };
  const method = typeof ov.method === "string" && ov.method.length > 0 ? ov.method.toUpperCase() : entry.method;
  const url = typeof ov.url === "string" && ov.url.length > 0 ? ov.url : entry.url;
  const headers: Record<string, string> = { ...entry.requestHeaders };
  if (ov.headers !== undefined) {
    if (typeof ov.headers !== "object" || ov.headers === null) return { error: "request_overrides.headers must be an object" };
    for (const [k, v] of Object.entries(ov.headers as Record<string, unknown>)) {
      if (v === null) delete headers[k];
      else headers[k] = String(v);
    }
  }
  const body = ov.body !== undefined ? String(ov.body) : entry.requestBody;
  return { request: { method, url, headers, body } };
}

/**
 * The proxy tool handler. Routes the `action` enum. Pure store actions
 * (status/history/inspect, and intercept rule management) never touch the
 * driver; start/stop/replay acquire the lazy, guarded driver.
 */
export async function executeProxy(
  ctx: ProxyToolContext,
  args: Record<string, unknown>,
  deps: ProxyToolDeps = {},
): Promise<ToolResult> {
  const action = args.action as string | undefined;
  if (!action) return fail("action is required");
  if (!(PROXY_ACTIONS as readonly string[]).includes(action)) {
    return fail(`Unknown proxy action: ${action}. Valid: ${PROXY_ACTIONS.join(", ")}`);
  }

  const host: ProxyHost = deps.host ?? {};
  const store = ensureStore(host);
  const factory = deps.createDriver ?? createProxyDriver;

  try {
    switch (action as ProxyAction) {
      // ── Pure store / state actions (no driver required) ──────────────────
      case "status": {
        return {
          success: true,
          output: {
            running: host.driver?.isRunning() ?? false,
            port: host.port ?? null,
            ca_cert_path: host.caCertPath ?? null,
            captured: store.size(),
            rules: (host.rules ?? []).length,
          },
        };
      }

      case "history": {
        const rows = store.list(parseFilter(args.filter));
        return { success: true, output: { total: store.size(), returned: rows.length, entries: rows } };
      }

      case "inspect": {
        const id = args.id as string | undefined;
        if (!id) return fail("id is required for inspect");
        const entry = store.get(id);
        if (!entry) return fail(`No captured entry with id '${id}'`);
        return { success: true, output: entry };
      }

      case "intercept": {
        const mode = typeof args.mode === "string" ? args.mode : "list";
        host.rules ??= [];
        if (mode === "list") {
          return { success: true, output: { rules: host.rules } };
        }
        if (mode === "clear") {
          host.rules = [];
          return { success: true, output: { rules: [], cleared: true } };
        }
        if (mode === "set" || mode === "add") {
          const rawRules = Array.isArray(args.rules) ? args.rules : undefined;
          if (!rawRules || rawRules.length === 0) return fail(`intercept ${mode} requires a non-empty 'rules' array`);
          const parsed: InterceptRule[] = [];
          for (let i = 0; i < rawRules.length; i++) {
            const r = parseInterceptRule(rawRules[i], i);
            if ("error" in r) return fail(r.error);
            parsed.push(r);
          }
          host.rules = mode === "set" ? parsed : [...host.rules, ...parsed];
          return { success: true, output: { rules: host.rules, installed: parsed.length } };
        }
        return fail(`Unknown intercept mode: ${mode}. Valid: set | add | list | clear`);
      }

      // ── Driver-backed actions ────────────────────────────────────────────
      case "start": {
        if (host.driver?.isRunning()) {
          return { success: true, output: { running: true, port: host.port, ca_cert_path: host.caCertPath, already: true } };
        }
        const port = typeof args.port === "number" && args.port > 0 ? args.port : DEFAULT_PROXY_PORT;
        // Refuse to start a capturing proxy with a scope that would relay NOTHING?
        // No — an empty/unscoped policy is a legitimate "capture the named target
        // only" default; the per-request gate below enforces scope on every host.
        const made = await factory({ publicNetwork: !!ctx.publicNetwork });
        if ("error" in made) return fail(made.error);
        const driver = made.driver;
        host.driver = driver;
        host.rules ??= [];
        const bound = await driver.start({
          port,
          allowHost: (h) => hostAllowed(ctx, h),
          getRules: () => host.rules ?? [],
          onCapture: ({ request, response }) => {
            let reqHost = "";
            try {
              reqHost = new URL(request.url).host;
            } catch {
              reqHost = "";
            }
            store.add({
              source: "proxy",
              method: request.method,
              url: request.url,
              host: reqHost,
              requestHeaders: request.headers,
              requestBody: request.body,
              status: response.status,
              responseHeaders: response.headers,
              responseBody: response.body,
              durationMs: response.durationMs,
            });
          },
        });
        host.port = bound.port;
        host.caCertPath = bound.caCertPath;
        return {
          success: true,
          output: {
            running: true,
            port: bound.port,
            ca_cert_path: bound.caCertPath,
            hint: `Point the target/client at http://127.0.0.1:${bound.port} and trust the CA at ${bound.caCertPath} for HTTPS.`,
          },
        };
      }

      case "stop": {
        if (!host.driver) return { success: true, output: { running: false, stopped: false, note: "proxy was not running" } };
        await host.driver.stop();
        host.driver = null;
        const wasPort = host.port;
        host.port = undefined;
        return { success: true, output: { running: false, stopped: true, port: wasPort ?? null, captured: store.size() } };
      }

      case "replay": {
        const id = args.id as string | undefined;
        if (!id) return fail("id is required for replay");
        const entry = store.get(id);
        if (!entry) return fail(`No captured entry with id '${id}'`);
        const composed = composeReplay(entry, args.request_overrides as Record<string, unknown> | undefined);
        if ("error" in composed) return fail(composed.error);
        const { request } = composed;

        // Scope-gate the FINAL replay target before any bytes leave the process.
        const gate = gateUrl(ctx, request.url);
        if (!gate.ok) return fail(`replay refused: out-of-scope URL '${request.url}' (${gate.reason})`);

        // Sending requires the transport backend. Acquire it lazily; a missing
        // backend degrades to the clear guard error (composition + scope check
        // above already ran, which is what the replay-shape tests assert).
        let driver = host.driver;
        if (!driver) {
          const made = await factory({ publicNetwork: !!ctx.publicNetwork });
          if ("error" in made) return fail(made.error);
          driver = made.driver;
        }
        const timeoutMs = deps.replayTimeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS;
        const response = await driver.send(request, { timeoutMs });
        let reqHost = "";
        try {
          reqHost = new URL(request.url).host;
        } catch {
          reqHost = "";
        }
        const recorded = store.add({
          source: "replay",
          replayOf: entry.id,
          method: request.method,
          url: request.url,
          host: reqHost,
          requestHeaders: request.headers,
          requestBody: request.body,
          status: response.status,
          responseHeaders: response.headers,
          responseBody: response.body,
          durationMs: response.durationMs,
        });
        return { success: true, output: recorded };
      }
    }
    // Exhaustive — every ProxyAction is handled above.
    return fail(`Unhandled proxy action: ${action}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: null, error: msg.slice(0, 2_000) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WIRING TODOs (integration touching files this task does / does not own):
//
// 1. REGISTRY (packages/core/src/agent/tools/index.ts + dispatch.ts — EDITED by
//    this task): `...proxyToolDefinitions` added to DOMAIN_DEFINITIONS, "proxy"
//    appended to TOOL_REGISTRY_ORDER, and `...proxyDispatch` added to
//    TOOL_DISPATCH. dispatch.test.ts pins registry⇄dispatch⇄method symmetry, so
//    the executor delegate (step 2) lands together with this.
//
// 2. EXECUTOR (packages/core/src/agent/tools.ts — EDITED by this task): a thin
//    `ToolExecutor.proxyAction(args)` delegates to
//        executeProxy(this.ctx, args, { host: this._proxyHost })
//    holding a `_proxyHost: ProxyHost = {}` field, and cleanup() calls
//    `this._proxyHost.driver?.stop()` so no listener outlives the session.
//    (This mirrors browser.ts's step-2 note; done here because registration
//    requires a real method for the symmetry test.)
//
// 3. package.json: NO CHANGE MADE. The proxy TRANSPORT is pure Node
//    (http/https/net/tls) — zero deps. The ONLY dep needed is an X.509
//    CA/leaf-cert generator for HTTPS MITM, isolated in the not-yet-built
//    `./proxy-backend.ts` (Phase 2). Recommended: `selfsigned` (~1 transitive
//    dep) or `node-forge`. Add it as an OPTIONAL dependency then, exactly as
//    `playwright` is optional for the browser tool. Until it exists,
//    createProxyDriver returns the "proxy backend not available" guard error.
//
// 4. CARD RENDERING (chat-screen.tsx / ToolCard.tsx / types.ts — NOT owned):
//    add a `proxy`/`network` meta kind to ToolResultMeta (types.ts) that renders
//    captured-request ROWS (method · host · path · status · ms) — a compact
//    Burp-history table for `history`, and a request/response diff for `replay`.
//    Populate `ToolResult.meta` from the history rows / replay entry. Until then
//    the rows ride in `output.entries` / `output` as plain JSON.
//
// 5. ROLE SURFACING (packages/core/src/agent/tools.ts `getToolsForRole` — EDITED
//    by this task): `proxy` is registered + dispatchable + tested but is
//    deliberately gated OUT of every advertised role set (by name, next to
//    `self_extend`), so it does not inflate the audit/review "everything" set or
//    leak to the model before the backend exists. To surface it: add a
//    `featureFlags.proxy` flag and, when on, push `"proxy"` into `networkTools`
//    (and drop the `name !== "proxy"` exclusion from the allEnabledTools
//    filter) — exactly how OAST / cloud-surface / fan-out are gated today.
// ─────────────────────────────────────────────────────────────────────────────
