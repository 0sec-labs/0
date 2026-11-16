// Server mode for `0`: the explicit, opt-in way to serve the console to a network behind a TLS proxy.
//
// Loopback behaviour lives in dashboard-http.ts and is untouched. Everything here only runs when the
// operator passes --server-mode. The invariants (see docs/design/deployment-packaging.md, threat model):
//   * the per-start control token is never placed in HTML for an unauthenticated visitor;
//   * a browser session is an opaque HttpOnly SameSite=Strict cookie obtained with an access token (or a
//     team sign-in), never the control token itself;
//   * only an explicit allow-list of Host values is accepted (DNS-rebinding protection stays on);
//   * X-Forwarded-* headers are honoured only from configured proxy addresses;
//   * login attempts are throttled with exponential backoff and compared in constant time.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BlockList, isIP } from "node:net";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import { z } from "zod";
import { audit } from "./audit.js";
import { htmlSecurityHeaders } from "./dashboard-csp.js";
import { WebRequestError, json } from "./dashboard-http.js";
import { TeamAuth, TeamAuthError, parseCookies } from "./team-auth.js";

export const ACCESS_COOKIE = "zero_access";
export const ACCESS_ROUTE_PREFIX = "/_access/";
export const MIN_ACCESS_TOKEN_LENGTH = 32;
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;

export function isWildcardHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, "");
  return h === "0.0.0.0" || h === "::" || h === "";
}

// ---------------------------------------------------------------- health

export type ServerPhase = "starting" | "ready" | "draining";

export function isHealthRequest(req: Pick<IncomingMessage, "method" | "url">): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const path = (req.url ?? "").split("?")[0];
  return path === "/healthz" || path === "/readyz";
}

/** Liveness and readiness. No authentication, no secrets: only a status word. */
export function handleHealth(req: Pick<IncomingMessage, "url">, res: ServerResponse, state: { phase: () => ServerPhase; dbOk: () => boolean }): void {
  const path = (req.url ?? "").split("?")[0];
  if (path === "/healthz") { json(res, 200, { status: "ok" }); return; }
  const phase = state.phase();
  if (phase !== "ready") { json(res, 503, { status: phase }); return; }
  if (!state.dbOk()) { json(res, 503, { status: "unavailable" }); return; }
  json(res, 200, { status: "ready" });
}

// ---------------------------------------------------------------- access secret

export function validateAccessToken(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.length < MIN_ACCESS_TOKEN_LENGTH || value.length > 4096) throw new Error(`${label} must be ${MIN_ACCESS_TOKEN_LENGTH} to 4096 characters. Generate one with: openssl rand -base64 32`);
  return value;
}

export interface AccessSecret { token: string; generated: boolean; path?: string }

/** The configured secret, else a stored one, else a freshly generated 0600 file (printed once by the caller). */
export function resolveAccessSecret(options: { configured?: string; stateDir: string }): AccessSecret {
  if (options.configured) return { token: options.configured, generated: false };
  const path = join(options.stateDir, "access-token");
  if (existsSync(path)) {
    const stored = readFileSync(path, "utf8").trim();
    if (stored.length >= MIN_ACCESS_TOKEN_LENGTH) { try { chmodSync(path, 0o600); } catch { /* best effort */ } return { token: stored, generated: false, path }; }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { token, generated: true, path };
}

// ---------------------------------------------------------------- hosts, proxies

function normalizeIp(address: string | undefined): string {
  const value = (address ?? "").toLowerCase();
  return value.startsWith("::ffff:") && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
}

export function parseTrustedProxies(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const raw of entries.flatMap(entry => entry.split(",")).map(entry => entry.trim()).filter(Boolean)) {
    if (raw === "loopback") { list.addSubnet("127.0.0.0", 8, "ipv4"); list.addAddress("::1", "ipv6"); continue; }
    const [address, prefix] = raw.split("/") as [string, string | undefined];
    const family = isIP(address);
    if (!family) throw new Error(`Invalid trusted proxy "${raw}": use an IP address, a CIDR such as 172.30.0.0/24, or "loopback".`);
    const bits = prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix);
    if (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) throw new Error(`Invalid trusted proxy prefix in "${raw}".`);
    if (family === 4) list.addSubnet(address, bits, "ipv4"); else list.addSubnet(address, bits, "ipv6");
  }
  return list;
}

export function splitList(...values: Array<string | string[] | undefined>): string[] {
  return values.flatMap(value => (Array.isArray(value) ? value : value === undefined ? [] : [value])).flatMap(value => value.split(",")).map(value => value.trim().toLowerCase()).filter(Boolean);
}

interface AllowedHost { hostname: string; port?: string }
export function parseAllowedHosts(entries: readonly string[]): AllowedHost[] {
  return entries.map(entry => {
    if (!/^[a-z0-9.[\]:-]+$/.test(entry)) throw new Error(`Invalid allowed host "${entry}": use a hostname such as 0.example.com, optionally with :port.`);
    const url = new URL(`http://${entry}`);
    if (url.pathname !== "/" || url.username) throw new Error(`Invalid allowed host "${entry}".`);
    return { hostname: url.hostname, ...(url.port ? { port: url.port } : {}) };
  });
}

// ---------------------------------------------------------------- login throttle

interface Attempt { fails: number; lockedUntil: number; seen: number }

/** Per-client exponential backoff plus a global ceiling against distributed guessing. */
export class LoginThrottle {
  private readonly clients = new Map<string, Attempt>();
  private readonly global: Attempt = { fails: 0, lockedUntil: 0, seen: 0 };
  constructor(private readonly now: () => number = Date.now, private readonly freeAttempts = 5) {}
  /** Seconds until another attempt is admitted; 0 when allowed. */
  retryAfter(key: string): number {
    const t = this.now();
    const wait = Math.max(this.global.lockedUntil, this.clients.get(key)?.lockedUntil ?? 0) - t;
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }
  fail(key: string): void {
    const t = this.now();
    if (this.clients.size >= 10_000) for (const [id, row] of this.clients) if (t - row.seen > 15 * 60_000) this.clients.delete(id);
    if (this.clients.size >= 10_000) this.clients.clear();
    let row = this.clients.get(key);
    if (!row || t - row.seen > 15 * 60_000) row = { fails: 0, lockedUntil: 0, seen: t };
    row.fails++; row.seen = t;
    if (row.fails > this.freeAttempts) row.lockedUntil = t + Math.min(2 ** (row.fails - this.freeAttempts) * 1000, 15 * 60_000);
    this.clients.set(key, row);
    if (t - this.global.seen > 60_000) { this.global.fails = 0; }
    this.global.fails++; this.global.seen = t;
    if (this.global.fails > 100) this.global.lockedUntil = t + 30_000;
  }
  success(key: string): void { this.clients.delete(key); }
}

// ---------------------------------------------------------------- guard

export interface ServerRequestContext { authority: string; https: boolean; clientIp: string; viaTrustedProxy: boolean }

export interface ServerGuardOptions {
  allowedHosts: readonly string[];
  trustedProxies: readonly string[];
  /** Public URL clients use (for Secure cookies and OIDC); optional. */
  publicUrl?: string;
  /** Shared access secret; absent when team accounts are the only credential. */
  accessToken?: string;
  now?: () => number;
}

const same = (a: string, b: string): boolean => {
  const x = createHash("sha256").update(a).digest(); const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};
const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim() || undefined;

export class ServerModeGuard {
  private readonly allowed: AllowedHost[];
  private readonly proxies: BlockList;
  readonly trustsProxy: boolean;
  private readonly publicHttps: boolean;
  private readonly sessions = new Map<string, number>();
  private readonly throttle: LoginThrottle;
  private readonly now: () => number;
  private readonly accessToken?: string;

  constructor(options: ServerGuardOptions) {
    this.now = options.now ?? Date.now;
    this.allowed = parseAllowedHosts(options.allowedHosts);
    if (options.publicUrl) {
      const url = new URL(options.publicUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("--public-url must be an http(s) URL.");
      this.publicHttps = url.protocol === "https:";
      if (!this.allowed.some(row => row.hostname === url.hostname)) this.allowed.push({ hostname: url.hostname, ...(url.port ? { port: url.port } : {}) });
    } else this.publicHttps = false;
    if (this.allowed.length === 0) throw new Error("Server mode needs at least one allowed host: pass --allowed-host <name> (for example 0.example.com or localhost).");
    this.proxies = parseTrustedProxies(options.trustedProxies);
    this.trustsProxy = options.trustedProxies.some(entry => entry.trim() !== "");
    this.accessToken = options.accessToken;
    this.throttle = new LoginThrottle(this.now);
  }

  get hasAccessToken(): boolean { return this.accessToken !== undefined; }

  isTrustedProxy(address: string | undefined): boolean {
    const ip = normalizeIp(address); const family = isIP(ip);
    return family !== 0 && this.proxies.check(ip, family === 4 ? "ipv4" : "ipv6");
  }

  /** Host allow-list, forwarded-header trust, Origin and fetch-metadata checks. Throws WebRequestError. */
  authorize(req: IncomingMessage): ServerRequestContext {
    const peer = normalizeIp(req.socket.remoteAddress);
    const trusted = this.isTrustedProxy(peer);
    const authority = (trusted ? first(req.headers["x-forwarded-host"]) : undefined) ?? req.headers.host;
    if (!authority || !/^[A-Za-z0-9.[\]:-]+$/.test(authority)) throw new WebRequestError("Invalid web application host.", 403);
    let requestUrl: URL;
    try { requestUrl = new URL(`http://${authority}`); } catch { throw new WebRequestError("Invalid web application host.", 403); }
    if (!this.allowed.some(row => row.hostname === requestUrl.hostname && (row.port === undefined || row.port === requestUrl.port))) {
      throw new WebRequestError("This host name is not allowed. Add it with --allowed-host.", 403);
    }
    const forwardedProto = trusted ? first(req.headers["x-forwarded-proto"])?.toLowerCase() : undefined;
    const https = this.publicHttps || forwardedProto === "https";
    const expectedOrigin = `${https ? "https" : "http"}://${authority.toLowerCase()}`;
    if (req.headers.origin !== undefined && req.headers.origin.toLowerCase() !== expectedOrigin) throw new WebRequestError("Cross-origin web application requests are not allowed.", 403);
    const ssoCallback = req.method === "GET" && /^\/api\/team\/auth\/callback(?:\?|$)/.test(req.url ?? "");
    if (req.url?.startsWith("/api/") && req.headers["sec-fetch-site"] === "cross-site" && !ssoCallback) throw new WebRequestError("Cross-site control requests are not allowed.", 403);
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) throw new WebRequestError("Invalid request target.", 400);
    return { authority, https, clientIp: trusted ? this.forwardedClient(req, peer) : peer, viaTrustedProxy: trusted };
  }

  /** Rightmost address in X-Forwarded-For that is not one of our own proxies. */
  private forwardedClient(req: IncomingMessage, peer: string): string {
    const raw = req.headers["x-forwarded-for"]; const header = Array.isArray(raw) ? raw.join(",") : raw;
    const hops = (header ?? "").split(",").map(hop => normalizeIp(hop.trim())).filter(hop => isIP(hop) !== 0);
    for (let i = hops.length - 1; i >= 0; i--) if (!this.isTrustedProxy(hops[i])) return hops[i]!;
    return hops[0] ?? peer;
  }

  private sessionOf(req: Pick<IncomingMessage, "headers">): string | undefined {
    const id = parseCookies(req.headers.cookie)[ACCESS_COOKIE];
    return id && /^[\w-]{43}$/.test(id) ? id : undefined;
  }
  private sessionValid(req: Pick<IncomingMessage, "headers">): boolean {
    const id = this.sessionOf(req); if (!id) return false;
    const expires = this.sessions.get(id);
    if (expires === undefined) return false;
    if (expires <= this.now()) { this.sessions.delete(id); return false; }
    return true;
  }

  /** A browser is authenticated by a team session (team mode) or a gate session (access-token mode). */
  isAuthenticated(req: Pick<IncomingMessage, "headers">, team: TeamAuth): boolean {
    return team.enabled ? Boolean(team.resolveSession(req)) : this.sessionValid(req);
  }

  private cookie(value: string, seconds: number, https: boolean): string {
    return `${ACCESS_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${https ? "; Secure" : ""}`;
  }

  private fail(req: IncomingMessage, ctx: ServerRequestContext, action: string, reason: string, status: number): void {
    audit({ actor: "anonymous", action, subject: req.url?.split("?")[0] ?? "/", outcome: "denied", detail: { reason, status, method: req.method ?? "GET", client: ctx.clientIp } });
  }

  /** Audit and answer 401 for an API call that carries no session and no bearer credential. */
  denyAnonymous(req: IncomingMessage, res: ServerResponse, ctx: ServerRequestContext): void {
    this.fail(req, ctx, "access.required", "no_session", 401);
    json(res, 401, { code: "access_required", error: "Sign in to use this console." });
  }

  /** Mutating API calls from a cookie session must be provably same-origin; the control-token header is the synchronizer token. */
  csrfDenial(req: IncomingMessage, ctx: ServerRequestContext): string | undefined {
    const method = req.method ?? "GET";
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return undefined;
    if (req.headers.origin === undefined && req.headers["sec-fetch-site"] !== "same-origin") {
      this.fail(req, ctx, "access.csrf", "origin_missing", 403);
      return "Cross-site request refused: an Origin header is required.";
    }
    return undefined;
  }

  /** POST /_access/login and /_access/logout. Returns true when the request was answered. */
  async handleAccessRoute(req: IncomingMessage, res: ServerResponse, pathname: string, ctx: ServerRequestContext, team: TeamAuth, readBody: () => Promise<unknown>): Promise<boolean> {
    if (!pathname.startsWith(ACCESS_ROUTE_PREFIX)) return false;
    const route = pathname.slice(ACCESS_ROUTE_PREFIX.length);
    if (req.method !== "POST" || (route !== "login" && route !== "logout")) { json(res, route === "login" || route === "logout" ? 405 : 404, { error: "Not found." }); return true; }
    if (req.headers.origin === undefined && req.headers["sec-fetch-site"] !== "same-origin") { this.fail(req, ctx, "access.csrf", "origin_missing", 403); json(res, 403, { error: "Cross-site request refused." }); return true; }
    if (route === "logout") {
      const id = this.sessionOf(req); if (id) this.sessions.delete(id);
      const headers: string[] = [this.cookie("", 0, ctx.https)];
      if (team.enabled) headers.push(team.logout(req).setCookie);
      audit({ actor: "browser", action: "access.logout", subject: "console", outcome: "ok", detail: { client: ctx.clientIp } });
      res.setHeader("Set-Cookie", headers); json(res, 200, { ok: true }); return true;
    }
    const wait = this.throttle.retryAfter(ctx.clientIp);
    if (wait > 0) {
      this.fail(req, ctx, "access.throttled", "backoff", 429);
      res.setHeader("Retry-After", String(wait)); json(res, 429, { error: `Too many attempts. Try again in ${wait} seconds.` }); return true;
    }
    const body = await readBody();
    if (team.enabled) {
      try {
        const login = await team.login(body, ctx.clientIp);
        this.throttle.success(ctx.clientIp);
        audit({ actor: login.user.displayName, action: "access.login", subject: "console", outcome: "ok", detail: { kind: "team", role: login.user.role, client: ctx.clientIp } });
        res.setHeader("Set-Cookie", login.setCookie); json(res, 200, { ok: true }); return true;
      } catch (error) {
        if (!(error instanceof TeamAuthError)) throw error;
        if (error.statusCode === 401) this.throttle.fail(ctx.clientIp);
        this.fail(req, ctx, "access.login_failed", error.statusCode === 429 ? "rate_limited" : "bad_credentials", error.statusCode);
        json(res, error.statusCode, { error: error.statusCode === 401 ? "Invalid user ID or password." : error.message }); return true;
      }
    }
    const parsed = z.object({ token: z.string().min(1).max(4096) }).strict().safeParse(body);
    if (!parsed.success || !this.accessToken || !same(parsed.data.token, this.accessToken)) {
      this.throttle.fail(ctx.clientIp);
      this.fail(req, ctx, "access.login_failed", "bad_token", 401);
      json(res, 401, { error: "That access token is not valid." }); return true;
    }
    this.throttle.success(ctx.clientIp);
    const t = this.now();
    for (const [id, expires] of this.sessions) if (expires <= t) this.sessions.delete(id);
    if (this.sessions.size >= MAX_SESSIONS) { json(res, 503, { error: "Too many active sessions." }); return true; }
    const sessionId = randomBytes(32).toString("base64url");
    this.sessions.set(sessionId, t + SESSION_MS);
    audit({ actor: "browser", action: "access.login", subject: "console", outcome: "ok", detail: { kind: "access-token", client: ctx.clientIp } });
    res.setHeader("Set-Cookie", this.cookie(sessionId, SESSION_MS / 1000, ctx.https)); json(res, 200, { ok: true });
    return true;
  }

  /** The page an anonymous visitor gets instead of the console: no control token, no application code. */
  sendLoginPage(req: IncomingMessage, res: ServerResponse, ctx: ServerRequestContext, team: TeamAuth): void {
    const teamMode = team.enabled;
    const sso = teamMode && team.status({ headers: {} }).sso;
    const html = loginHtml({ teamMode, sso });
    const headers: Record<string, string> = { ...htmlSecurityHeaders(html), "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
    if (ctx.https) headers["Strict-Transport-Security"] = "max-age=31536000";
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : html);
  }
}

function loginHtml(mode: { teamMode: boolean; sso: boolean }): string {
  const field = mode.teamMode
    ? `<label>User ID<input name="userId" autocomplete="username" required autofocus></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label>`
    : `<label>Access token<input name="token" type="password" autocomplete="off" required autofocus></label>`;
  const script = `const f=document.querySelector("form"),m=document.querySelector("#m");f.addEventListener("submit",async e=>{e.preventDefault();m.textContent="";const b=Object.fromEntries(new FormData(f));try{const r=await fetch("/_access/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b),credentials:"same-origin"});if(r.ok){location.replace("/");return}const d=await r.json().catch(()=>({}));m.textContent=d.error||"Sign-in failed."}catch{m.textContent="Could not reach the server."}});`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign in - 0</title><style>:root{color-scheme:light dark}body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{width:min(22rem,90vw)}h1{font-size:1.2rem}label{display:block;margin:1rem 0 .3rem}input{display:block;width:100%;box-sizing:border-box;padding:.55rem;font:inherit;margin-top:.3rem}button,a.b{display:block;margin-top:1rem;padding:.6rem;width:100%;box-sizing:border-box;font:inherit;text-align:center;cursor:pointer}#m{color:#c0392b;min-height:1.2rem;margin-top:.8rem}</style></head><body><main><h1>Sign in to 0</h1><form>${field}<button type="submit">Sign in</button></form>${mode.sso ? `<a class="b" href="/api/team/auth/sso">Sign in with single sign-on</a>` : ""}<p id="m" role="alert"></p></main><script>${script}</script></body></html>`;
}
