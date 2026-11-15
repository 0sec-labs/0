import { describe, expect, it } from "vitest";
import { TeamAuth } from "./team-auth.js";
import { LoginThrottle, ServerModeGuard, handleHealth, isHealthRequest, parseAllowedHosts, parseTrustedProxies, resolveAccessSecret, validateAccessToken, ACCESS_COOKIE } from "./server-mode.js";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "t".repeat(40);
const noTeam = () => new TeamAuth({ origin: "http://localhost:48123" });

function fakeReq(init: { method?: string; url?: string; headers?: Record<string, string>; remote?: string }): never {
  return { method: init.method ?? "GET", url: init.url ?? "/", headers: init.headers ?? {}, socket: { remoteAddress: init.remote ?? "203.0.113.9" } } as never;
}
function fakeRes() {
  const state = { status: 0, headers: {} as Record<string, unknown>, body: "" };
  const res = {
    req: undefined, headersSent: false, destroyed: false, writableEnded: false,
    setHeader(k: string, v: unknown) { state.headers[k.toLowerCase()] = v; },
    writeHead(status: number, headers?: Record<string, unknown>) { state.status = status; for (const [k, v] of Object.entries(headers ?? {})) state.headers[k.toLowerCase()] = v; },
    end(chunk?: unknown) { state.body = chunk === undefined ? "" : String(chunk); },
  };
  return { res: res as never, state };
}
const body = (value: unknown) => () => Promise.resolve(value);

describe("server mode host and proxy rules", () => {
  const guard = (extra: Partial<ConstructorParameters<typeof ServerModeGuard>[0]> = {}) => new ServerModeGuard({ allowedHosts: ["0.example.com"], trustedProxies: [], accessToken: TOKEN, ...extra });

  it("accepts only listed Host names and rejects everything else with 403", () => {
    const g = guard();
    expect(g.authorize(fakeReq({ headers: { host: "0.example.com" } })).authority).toBe("0.example.com");
    for (const host of ["evil.example.com", "127.0.0.1:48123", "localhost", "0.example.com.evil.net", "", undefined]) {
      expect(() => g.authorize(fakeReq({ headers: host === undefined ? {} : { host } }))).toThrowError(expect.objectContaining({ statusCode: 403 }));
    }
  });

  it("requires at least one allowed host", () => {
    expect(() => new ServerModeGuard({ allowedHosts: [], trustedProxies: [] })).toThrow(/allowed host/);
  });

  it("honours a port in an allow-list entry", () => {
    const g = guard({ allowedHosts: ["localhost:48123"] });
    expect(g.authorize(fakeReq({ headers: { host: "localhost:48123" } })).authority).toBe("localhost:48123");
    expect(() => g.authorize(fakeReq({ headers: { host: "localhost:1" } }))).toThrow();
  });

  it("ignores X-Forwarded-* from an untrusted peer", () => {
    const g = guard({ trustedProxies: ["10.0.0.0/8"] });
    const ctx = g.authorize(fakeReq({ remote: "203.0.113.9", headers: { host: "0.example.com", "x-forwarded-proto": "https", "x-forwarded-for": "1.2.3.4" } }));
    expect(ctx.https).toBe(false);
    expect(ctx.clientIp).toBe("203.0.113.9");
    expect(() => g.authorize(fakeReq({ remote: "203.0.113.9", headers: { host: "0.example.com", "x-forwarded-host": "0.example.com", ...{ } } }))).not.toThrow();
    expect(() => g.authorize(fakeReq({ remote: "203.0.113.9", headers: { host: "evil.example.com", "x-forwarded-host": "0.example.com" } }))).toThrow();
  });

  it("trusts X-Forwarded-* only from a configured proxy and finds the real client", () => {
    const g = guard({ trustedProxies: ["10.0.0.0/8", "::ffff:172.30.0.0/112"] });
    const ctx = g.authorize(fakeReq({ remote: "10.1.2.3", headers: { host: "internal:1", "x-forwarded-host": "0.example.com", "x-forwarded-proto": "https", "x-forwarded-for": "198.51.100.7, 10.9.9.9" } }));
    expect(ctx).toMatchObject({ authority: "0.example.com", https: true, clientIp: "198.51.100.7", viaTrustedProxy: true });
    // a client-spoofed first hop cannot displace the real (rightmost untrusted) address
    expect(g.authorize(fakeReq({ remote: "10.1.2.3", headers: { host: "0.example.com", "x-forwarded-for": "6.6.6.6, 198.51.100.7" } })).clientIp).toBe("198.51.100.7");
    // the proxy cannot smuggle a disallowed forwarded host either
    expect(() => g.authorize(fakeReq({ remote: "10.1.2.3", headers: { host: "0.example.com", "x-forwarded-host": "evil.example.com" } }))).toThrow();
  });

  it("checks Origin against the effective scheme and host, and rejects cross-site API calls", () => {
    const g = guard({ trustedProxies: ["10.0.0.0/8"] });
    const proxied = { remote: "10.1.2.3", headers: { host: "0.example.com", "x-forwarded-proto": "https" } };
    expect(() => g.authorize(fakeReq({ ...proxied, headers: { ...proxied.headers, origin: "https://0.example.com" } }))).not.toThrow();
    expect(() => g.authorize(fakeReq({ ...proxied, headers: { ...proxied.headers, origin: "http://0.example.com" } }))).toThrow();
    expect(() => g.authorize(fakeReq({ ...proxied, headers: { ...proxied.headers, origin: "https://evil.example.com" } }))).toThrow();
    expect(() => g.authorize(fakeReq({ ...proxied, url: "/api/x", headers: { ...proxied.headers, "sec-fetch-site": "cross-site" } }))).toThrow();
    expect(() => g.authorize(fakeReq({ url: "//evil.example.com", headers: { host: "0.example.com" } }))).toThrow();
  });

  it("parses proxy lists strictly", () => {
    expect(() => parseTrustedProxies(["not-an-ip"])).toThrow();
    expect(() => parseTrustedProxies(["10.0.0.0/99"])).toThrow();
    expect(parseTrustedProxies(["loopback"]).check("127.0.0.5", "ipv4")).toBe(true);
    expect(() => parseAllowedHosts(["bad host!"])).toThrow();
  });
});

describe("server mode sign-in", () => {
  const ctx = { authority: "0.example.com", https: false, clientIp: "198.51.100.7", viaTrustedProxy: false };
  const guard = () => new ServerModeGuard({ allowedHosts: ["0.example.com"], trustedProxies: [], accessToken: TOKEN });
  const login = (g: ServerModeGuard, token: string, c = ctx, headers: Record<string, string> = { origin: "http://0.example.com" }) => {
    const { res, state } = fakeRes();
    return g.handleAccessRoute(fakeReq({ method: "POST", url: "/_access/login", headers }), res, "/_access/login", c, noTeam(), body({ token })).then(() => state);
  };

  it("issues an HttpOnly SameSite=Strict cookie that authenticates, never the control token", async () => {
    const g = guard();
    const state = await login(g, TOKEN);
    expect(state.status).toBe(200);
    const cookie = String(state.headers["set-cookie"]);
    expect(cookie).toMatch(new RegExp(`^${ACCESS_COOKIE}=[\\w-]{43};`));
    expect(cookie).toMatch(/HttpOnly/); expect(cookie).toMatch(/SameSite=Strict/); expect(cookie).not.toMatch(/Secure/);
    expect(cookie).not.toContain(TOKEN);
    expect(g.isAuthenticated(fakeReq({ headers: { cookie: cookie.split(";")[0]! } }), noTeam())).toBe(true);
    expect(g.isAuthenticated(fakeReq({ headers: { cookie: `${ACCESS_COOKIE}=${"a".repeat(43)}` } }), noTeam())).toBe(false);
    expect(g.isAuthenticated(fakeReq({}), noTeam())).toBe(false);
  });

  it("adds Secure when the request arrived over https", async () => {
    expect(String((await login(guard(), TOKEN, { ...ctx, https: true }, { origin: "https://0.example.com" })).headers["set-cookie"])).toMatch(/; Secure/);
  });

  it("rejects wrong, empty and malformed tokens without a cookie", async () => {
    const g = guard();
    for (const bad of ["x".repeat(40), TOKEN.slice(0, -1), TOKEN + "x", "", undefined, 7]) {
      const state = await login(g, bad as string);
      expect(state.status).toBe(401);
      expect(state.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("throttles brute force per client with Retry-After, then recovers only for other clients", async () => {
    const g = guard();
    for (let i = 0; i < 5; i++) expect((await login(g, "wrong" + i)).status).toBe(401);
    const sixth = await login(g, "wrong");
    expect(sixth.status).toBe(401);
    const locked = await login(g, TOKEN); // even the right token is refused while locked
    expect(locked.status).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await login(g, TOKEN, { ...ctx, clientIp: "198.51.100.8" })).status).toBe(200);
  });

  it("backoff grows exponentially and caps, and the clock unlocks it", () => {
    let now = 1_000_000; const t = new LoginThrottle(() => now);
    for (let i = 0; i < 5; i++) t.fail("a");
    expect(t.retryAfter("a")).toBe(0);
    t.fail("a"); expect(t.retryAfter("a")).toBe(2);
    t.fail("a"); expect(t.retryAfter("a")).toBe(4);
    for (let i = 0; i < 30; i++) t.fail("a");
    expect(t.retryAfter("a")).toBeLessThanOrEqual(900);
    now += 16 * 60_000; expect(t.retryAfter("a")).toBe(0);
  });

  it("refuses login or logout without an Origin or same-origin fetch metadata (login CSRF)", async () => {
    expect((await login(guard(), TOKEN, ctx, {})).status).toBe(403);
    expect((await login(guard(), TOKEN, ctx, { "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  it("logout drops the session", async () => {
    const g = guard();
    const cookie = String((await login(g, TOKEN)).headers["set-cookie"]).split(";")[0]!;
    const { res, state } = fakeRes();
    await g.handleAccessRoute(fakeReq({ method: "POST", url: "/_access/logout", headers: { origin: "http://0.example.com", cookie } }), res, "/_access/logout", ctx, noTeam(), body({}));
    expect(state.status).toBe(200);
    expect(g.isAuthenticated(fakeReq({ headers: { cookie } }), noTeam())).toBe(false);
  });

  it("expires sessions", async () => {
    let now = 1_000_000;
    const g = new ServerModeGuard({ allowedHosts: ["0.example.com"], trustedProxies: [], accessToken: TOKEN, now: () => now });
    const cookie = String((await login(g, TOKEN)).headers["set-cookie"]).split(";")[0]!;
    now += 13 * 60 * 60 * 1000;
    expect(g.isAuthenticated(fakeReq({ headers: { cookie } }), noTeam())).toBe(false);
  });

  it("requires same-origin evidence on mutating API calls from a cookie session (CSRF)", () => {
    const g = guard();
    expect(g.csrfDenial(fakeReq({ method: "POST" }), ctx)).toMatch(/Origin/);
    expect(g.csrfDenial(fakeReq({ method: "POST", headers: { origin: "http://0.example.com" } }), ctx)).toBeUndefined();
    expect(g.csrfDenial(fakeReq({ method: "DELETE", headers: { "sec-fetch-site": "same-origin" } }), ctx)).toBeUndefined();
    expect(g.csrfDenial(fakeReq({ method: "GET" }), ctx)).toBeUndefined();
  });

  it("serves an anonymous sign-in page that carries no control token or app script", () => {
    const { res, state } = fakeRes();
    guard().sendLoginPage(fakeReq({}), res, ctx, noTeam());
    expect(state.status).toBe(200);
    expect(state.body).toContain("Access token");
    expect(state.body).not.toMatch(/0-control-token/);
    expect(String(state.headers["content-security-policy"])).toContain("script-src 'self' 'sha256-");
    expect(state.headers["cache-control"]).toBe("no-store");
  });
});

describe("access secret", () => {
  it("rejects short tokens, accepts 32+", () => {
    expect(() => validateAccessToken("short", "ZERO_ACCESS_TOKEN")).toThrow(/32/);
    expect(validateAccessToken(TOKEN, "X")).toBe(TOKEN);
    expect(validateAccessToken("", "X")).toBeUndefined();
  });

  it("generates once with mode 0600 and reuses it", () => {
    const dir = mkdtempSync(join(tmpdir(), "zero-access-"));
    const first = resolveAccessSecret({ stateDir: dir });
    expect(first.generated).toBe(true);
    expect(first.token.length).toBeGreaterThanOrEqual(32);
    expect(statSync(first.path!).mode & 0o777).toBe(0o600);
    const second = resolveAccessSecret({ stateDir: dir });
    expect(second).toMatchObject({ generated: false, token: first.token });
    expect(readFileSync(first.path!, "utf8").trim()).toBe(first.token);
    expect(resolveAccessSecret({ stateDir: dir, configured: TOKEN })).toMatchObject({ token: TOKEN, generated: false });
  });
});

describe("health endpoints", () => {
  const probe = (url: string, phase: "starting" | "ready" | "draining", dbOk = true) => {
    const { res, state } = fakeRes();
    handleHealth({ url }, res, { phase: () => phase, dbOk: () => dbOk });
    return state;
  };
  it("recognises only GET/HEAD on the two paths", () => {
    expect(isHealthRequest(fakeReq({ url: "/healthz" }))).toBe(true);
    expect(isHealthRequest(fakeReq({ url: "/readyz?x=1" }))).toBe(true);
    expect(isHealthRequest(fakeReq({ method: "POST", url: "/healthz" }))).toBe(false);
    expect(isHealthRequest(fakeReq({ url: "/healthz/x" }))).toBe(false);
  });
  it("healthz is always ok; readyz is 503 while starting, draining or without a database", () => {
    expect(probe("/healthz", "draining").status).toBe(200);
    expect(probe("/readyz", "ready").status).toBe(200);
    expect(probe("/readyz", "starting").status).toBe(503);
    expect(JSON.parse(probe("/readyz", "draining").body)).toEqual({ status: "draining" });
    expect(probe("/readyz", "ready", false).status).toBe(503);
  });
  it("exposes nothing but a status word", () => {
    expect(Object.keys(JSON.parse(probe("/readyz", "ready").body))).toEqual(["status"]);
  });
});

