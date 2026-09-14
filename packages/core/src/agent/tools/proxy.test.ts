/**
 * Unit tests for the intercepting-proxy tool scaffold (burp-network-20260913).
 *
 * These pin the things that must hold with NO real proxy present:
 *  1. definition / dispatch shape (action enum, handler name),
 *  2. arg-validation (missing/unknown action, missing id, bad intercept rules),
 *  3. the REAL in-memory history store (add / list / filter / get),
 *  4. scope refusal (replay to an out-of-scope host is refused before egress),
 *  5. the "backend unavailable" degradation path (guarded driver seam),
 *  6. replay composition shape (overrides merged, scope-checked) with a fake driver.
 *
 * A fake driver stands in for the real http/https backend so replay + start
 * routing can be exercised deterministically without opening a socket.
 */
import { describe, it, expect } from "vitest";
import {
  PROXY_ACTIONS,
  PROXY_INSTALL_HINT,
  proxyToolDefinitions,
  proxyDispatch,
  executeProxy,
  composeReplay,
  parseInterceptRule,
  ProxyHistoryStore,
  type CapturedEntry,
  type ProxyDriver,
  type ProxyDriverFactory,
  type ProxyHost,
  type ProxyToolContext,
} from "./proxy.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

function fakeDriver(): ProxyDriver {
  let running = false;
  return {
    async start(opts) {
      running = true;
      return { port: opts.port, caCertPath: "/tmp/0sec-proxy-ca.pem" };
    },
    isRunning: () => running,
    async send(req) {
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: `replayed ${req.method} ${req.url}`,
        durationMs: 3,
      };
    },
    async stop() {
      running = false;
    },
  };
}

const fakeFactory: ProxyDriverFactory = async () => ({ driver: fakeDriver() });
const missingBackendFactory: ProxyDriverFactory = async () => ({ error: PROXY_INSTALL_HINT });

const unscopedCtx: ProxyToolContext = { target: "https://target.test" };

// A scope stub matching only *.target.test — enough for gateUrl / hostAllowed.
function scopedCtx(): ProxyToolContext {
  const scope = {
    match(url: string) {
      const allowed = /^https?:\/\/([a-z0-9-]+\.)?target\.test(\/|:|$)/.test(url);
      return { allowed, reason: allowed ? "in scope" : "host not in scope" };
    },
  } as unknown as NonNullable<ProxyToolContext["scope"]>;
  return { target: "https://target.test", scope };
}

function seededHost(): ProxyHost {
  const store = new ProxyHistoryStore();
  store.add({
    source: "proxy",
    method: "GET",
    url: "https://target.test/login",
    host: "target.test",
    requestHeaders: { host: "target.test" },
    status: 200,
    responseHeaders: {},
    responseBody: "ok",
  });
  return { store };
}

// ── Definition / dispatch shape ───────────────────────────────────────────────

describe("proxy tool definition", () => {
  it("declares the full action enum", () => {
    expect(proxyToolDefinitions.proxy.parameters.action.enum).toEqual([...PROXY_ACTIONS]);
    expect(proxyToolDefinitions.proxy.required).toEqual(["action"]);
  });
  it("routes through the proxyAction handler name", () => {
    expect(proxyDispatch.proxy).toBe("proxyAction");
  });
});

// ── Arg validation ────────────────────────────────────────────────────────────

describe("executeProxy arg validation", () => {
  const deps = { createDriver: fakeFactory };

  it("rejects a missing action", async () => {
    const r = await executeProxy(unscopedCtx, {}, deps);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/action is required/);
  });

  it("rejects an unknown action", async () => {
    const r = await executeProxy(unscopedCtx, { action: "pillage" }, deps);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Unknown proxy action/);
  });

  it("requires id for inspect and replay", async () => {
    const noInspect = await executeProxy(unscopedCtx, { action: "inspect" }, deps);
    expect(noInspect.error).toMatch(/id is required/);
    const noReplay = await executeProxy(unscopedCtx, { action: "replay" }, deps);
    expect(noReplay.error).toMatch(/id is required/);
  });

  it("rejects a bad intercept rule and a bad regex", () => {
    const missing = parseInterceptRule({ in: "req", part: "url", replace: "x" }, 0);
    expect("error" in missing && missing.error).toMatch(/match/);
    const badSide = parseInterceptRule({ in: "sideways", part: "url", match: "a", replace: "b" }, 1);
    expect("error" in badSide && badSide.error).toMatch(/\.in must be/);
    const badRe = parseInterceptRule({ in: "res", part: "body", match: "(", replace: "b" }, 2);
    expect("error" in badRe && badRe.error).toMatch(/not a valid regex/);
    const ok = parseInterceptRule({ in: "res", part: "body", match: "secret", replace: "REDACTED" }, 0);
    expect("error" in ok).toBe(false);
    expect((ok as { name: string }).name).toBe("R1");
  });

  it("intercept set requires a non-empty rules array", async () => {
    const r = await executeProxy(unscopedCtx, { action: "intercept", mode: "set" }, deps);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/non-empty 'rules'/);
  });
});

// ── History store (REAL, pure) ────────────────────────────────────────────────

describe("ProxyHistoryStore", () => {
  it("adds, ids, bounds, and gets entries", () => {
    const s = new ProxyHistoryStore();
    const a = s.add({ source: "proxy", method: "GET", url: "https://target.test/a", host: "target.test", requestHeaders: {} });
    const b = s.add({ source: "proxy", method: "POST", url: "https://target.test/b", host: "target.test", requestHeaders: {} });
    expect(a.id).toBe("req-1");
    expect(b.id).toBe("req-2");
    expect(s.size()).toBe(2);
    expect(s.get("req-2")?.method).toBe("POST");
    expect(s.get("nope")).toBeUndefined();
  });

  it("truncates oversized bodies", () => {
    const s = new ProxyHistoryStore();
    const big = "x".repeat(200_000);
    const e = s.add({ source: "proxy", method: "GET", url: "https://target.test/", host: "target.test", requestHeaders: {}, responseBody: big });
    expect(e.responseBodyTruncated).toBe(true);
    expect((e.responseBody ?? "").length).toBeLessThan(big.length);
  });

  it("lists newest-first and filters by host/method/status/url/since", () => {
    const s = new ProxyHistoryStore();
    s.add({ source: "proxy", method: "GET", url: "https://target.test/a", host: "target.test", requestHeaders: {}, status: 200, timestamp: 100 });
    s.add({ source: "proxy", method: "POST", url: "https://api.target.test/b", host: "api.target.test", requestHeaders: {}, status: 500, timestamp: 200 });
    s.add({ source: "replay", method: "GET", url: "https://target.test/c", host: "target.test", requestHeaders: {}, status: 200, timestamp: 300 });

    expect(s.list().map((r) => r.id)).toEqual(["req-3", "req-2", "req-1"]); // newest-first
    expect(s.list({ method: "post" }).map((r) => r.id)).toEqual(["req-2"]);
    expect(s.list({ host: "target.test" }).map((r) => r.id)).toEqual(["req-3", "req-1"]);
    expect(s.list({ status: 500 }).map((r) => r.id)).toEqual(["req-2"]);
    expect(s.list({ url_contains: "/c" }).map((r) => r.id)).toEqual(["req-3"]);
    expect(s.list({ since: 250 }).map((r) => r.id)).toEqual(["req-3"]);
    expect(s.list({ limit: 1 }).map((r) => r.id)).toEqual(["req-3"]);
  });
});

// ── history / inspect actions over a seeded host ──────────────────────────────

describe("executeProxy history + inspect", () => {
  it("lists captured rows and inspects one by id", async () => {
    const host = seededHost();
    const list = await executeProxy(unscopedCtx, { action: "history" }, { host, createDriver: fakeFactory });
    expect(list.success).toBe(true);
    expect((list.output as { total: number }).total).toBe(1);

    const inspect = await executeProxy(unscopedCtx, { action: "inspect", id: "req-1" }, { host, createDriver: fakeFactory });
    expect(inspect.success).toBe(true);
    expect((inspect.output as CapturedEntry).url).toBe("https://target.test/login");

    const missing = await executeProxy(unscopedCtx, { action: "inspect", id: "req-99" }, { host, createDriver: fakeFactory });
    expect(missing.success).toBe(false);
    expect(missing.error).toMatch(/No captured entry/);
  });
});

// ── intercept rule management (pure) ──────────────────────────────────────────

describe("executeProxy intercept", () => {
  it("sets, lists, appends, and clears rules on the host", async () => {
    const host: ProxyHost = {};
    const deps = { host, createDriver: fakeFactory };
    const set = await executeProxy(
      unscopedCtx,
      { action: "intercept", mode: "set", rules: [{ in: "res", part: "body", match: "admin", replace: "AAA" }] },
      deps,
    );
    expect(set.success).toBe(true);
    expect((set.output as { rules: unknown[] }).rules).toHaveLength(1);

    await executeProxy(unscopedCtx, { action: "intercept", mode: "add", rules: [{ in: "req", part: "header", match: "Cookie", replace: "x" }] }, deps);
    const list = await executeProxy(unscopedCtx, { action: "intercept", mode: "list" }, deps);
    expect((list.output as { rules: unknown[] }).rules).toHaveLength(2);

    const clear = await executeProxy(unscopedCtx, { action: "intercept", mode: "clear" }, deps);
    expect((clear.output as { rules: unknown[] }).rules).toHaveLength(0);
  });
});

// ── replay composition ────────────────────────────────────────────────────────

describe("composeReplay", () => {
  const entry: CapturedEntry = {
    id: "req-1",
    timestamp: 0,
    source: "proxy",
    method: "GET",
    url: "https://target.test/login",
    host: "target.test",
    requestHeaders: { host: "target.test", cookie: "a=1" },
    requestBody: "orig",
  };

  it("merges overrides, deletes null headers, and uppercases method", () => {
    const r = composeReplay(entry, { method: "post", headers: { cookie: null, "x-test": "1" }, body: "new" });
    expect("error" in r).toBe(false);
    const req = (r as { request: { method: string; headers: Record<string, string>; body?: string } }).request;
    expect(req.method).toBe("POST");
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers["x-test"]).toBe("1");
    expect(req.body).toBe("new");
  });

  it("keeps the captured request when no overrides are given", () => {
    const r = composeReplay(entry, undefined) as { request: { method: string; url: string } };
    expect(r.request.method).toBe("GET");
    expect(r.request.url).toBe("https://target.test/login");
  });
});

// ── Scope refusal ─────────────────────────────────────────────────────────────

describe("executeProxy scope gating", () => {
  it("refuses an out-of-scope replay target before touching the driver", async () => {
    const host = seededHost();
    const r = await executeProxy(
      scopedCtx(),
      { action: "replay", id: "req-1", request_overrides: { url: "https://evil.example/steal" } },
      { host, createDriver: fakeFactory },
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/out-of-scope/);
  });

  it("allows an in-scope replay and records a replay entry", async () => {
    const host = seededHost();
    const r = await executeProxy(
      scopedCtx(),
      { action: "replay", id: "req-1", request_overrides: { url: "https://target.test/login?x=1" } },
      { host, createDriver: fakeFactory },
    );
    expect(r.success).toBe(true);
    const out = r.output as CapturedEntry;
    expect(out.source).toBe("replay");
    expect(out.replayOf).toBe("req-1");
    expect(host.store?.size()).toBe(2);
  });
});

// ── Backend-not-available guard (no real proxy) ───────────────────────────────

describe("executeProxy backend guard", () => {
  it("returns a clear error when the backend is missing on start", async () => {
    const r = await executeProxy(unscopedCtx, { action: "start", port: 8081 }, { createDriver: missingBackendFactory });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/proxy backend not available/);
  });

  it("returns the backend error on replay when in-scope but no backend", async () => {
    const host = seededHost();
    const r = await executeProxy(
      scopedCtx(),
      { action: "replay", id: "req-1" },
      { host, createDriver: missingBackendFactory },
    );
    // Composition + scope check pass; only the actual send needs the backend.
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/proxy backend not available/);
  });

  it("pure actions (status/history) work with no backend at all", async () => {
    const host = seededHost();
    const status = await executeProxy(unscopedCtx, { action: "status" }, { host, createDriver: missingBackendFactory });
    expect(status.success).toBe(true);
    expect((status.output as { running: boolean; captured: number }).captured).toBe(1);
    expect((status.output as { running: boolean }).running).toBe(false);
  });
});

// ── start / stop lifecycle with a fake driver ─────────────────────────────────

describe("executeProxy start/stop", () => {
  it("starts, reports status, and stops via an injected host", async () => {
    const host: ProxyHost = {};
    const deps = { host, createDriver: fakeFactory };

    const start = await executeProxy(unscopedCtx, { action: "start", port: 8088 }, deps);
    expect(start.success).toBe(true);
    expect((start.output as { port: number }).port).toBe(8088);

    const status = await executeProxy(unscopedCtx, { action: "status" }, deps);
    expect((status.output as { running: boolean; port: number }).running).toBe(true);
    expect((status.output as { port: number }).port).toBe(8088);

    const stop = await executeProxy(unscopedCtx, { action: "stop" }, deps);
    expect((stop.output as { stopped: boolean }).stopped).toBe(true);
    expect(host.driver).toBeNull();
  });
});
