import { readFileSync } from "node:fs";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { promisify } from "node:util";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify } from "jose";

const scrypt = promisify(scryptCallback);
const COOKIE = "zero_team_session";
const SSO_COOKIE = "zero_team_sso";
const SESSION_MS = 8 * 60 * 60 * 1000;
const SSO_MS = 10 * 60 * 1000;
const userSchema = z.object({
  id: z.string().min(1).max(160), name: z.string().min(1).max(160),
  role: z.enum(["owner", "editor", "viewer"]), passwordHash: z.string().optional(), oidcSub: z.string().min(1).optional(),
}).strict();
const configSchema = z.object({
  workspace: z.object({ id: z.string().min(1).max(160), name: z.string().min(1).max(160) }).strict(),
  users: z.array(userSchema).min(1).max(1000),
  oidc: z.object({ issuer: z.string().url(), clientId: z.string().min(1), clientSecretEnv: z.string().min(1).optional(), redirectUri: z.string().url() }).strict().optional(),
}).strict();
export type TeamConfig = z.infer<typeof configSchema>;
export function parseTeamConfig(input: unknown): TeamConfig { return configSchema.parse(input); }
export interface TeamIdentity { workspaceId: string; userId: string; displayName: string; role: "owner" | "editor" | "viewer" }
export class TeamAuthError extends Error { constructor(message: string, public readonly statusCode = 401) { super(message); } }
function opaque(): string { return randomBytes(32).toString("base64url"); }
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("="); if (at < 0) continue;
    const name = part.slice(0, at).trim();
    // Reject duplicates rather than selecting an attacker-controlled shadow cookie.
    if (Object.hasOwn(cookies, name)) { cookies[name] = ""; continue; }
    cookies[name] = part.slice(at + 1).trim();
  }
  return cookies;
}
export function getSessionId(req: Pick<IncomingMessage, "headers">): string | undefined {
  const id = parseCookies(req.headers.cookie)[COOKIE]; return id && /^[\w-]{43}$/.test(id) ? id : undefined;
}
export async function hashTeamPassword(password: string): Promise<string> {
  if (!password || password.length > 1024) throw new TeamAuthError("Password must contain 1–1024 characters", 400);
  const salt = randomBytes(16); const key = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
function validHash(hash: string): boolean { return /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(hash); }
async function passwordMatches(password: string, hash: string): Promise<boolean> {
  const [, salt, expected] = hash.split("$");
  const key = await scrypt(password, Buffer.from(salt!, "hex"), 64) as Buffer;
  return timingSafeEqual(key, Buffer.from(expected!, "hex"));
}
interface Discovery { authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
export class TeamAuth {
  private readonly config?: TeamConfig;
  private readonly origin: string;
  private readonly now: () => number;
  private readonly sessions = new Map<string, { userId: string; expires: number }>();
  private readonly pending = new Map<string, { nonce: string; verifier: string; browser: string; expires: number }>();
  private readonly attempts = new Map<string, { count: number; expires: number }>();
  private discovery?: Discovery;
  private keys?: ReturnType<typeof createRemoteJWKSet>;
  private readonly dummyHash: Promise<string>;
  constructor(options: { configPath?: string; config?: TeamConfig; origin: string; now?: () => number }) {
    this.origin = new URL(options.origin).origin; this.now = options.now ?? Date.now;
    const source = options.config ?? (options.configPath ? JSON.parse(readFileSync(options.configPath, "utf8")) as unknown : undefined);
    if (source !== undefined) {
      this.config = configSchema.parse(source);
      if (new Set(this.config.users.map(user => user.id)).size !== this.config.users.length) throw new Error("Team user IDs must be unique");
      const subjects = this.config.users.flatMap(user => user.oidcSub ? [user.oidcSub] : []);
      if (new Set(subjects).size !== subjects.length) throw new Error("OIDC subjects must be unique");
      for (const user of this.config.users) if (user.passwordHash && !validHash(user.passwordHash)) throw new Error("Invalid team password hash; use hashTeamPassword");
      if (this.config.oidc) {
        this.requireProviderURL(this.config.oidc.issuer);
        if (new URL(this.config.oidc.redirectUri).origin !== this.origin) throw new Error("OIDC redirect URI must use this engine origin");
        if (new URL(this.config.oidc.redirectUri).pathname !== "/api/team/auth/callback") throw new Error("OIDC redirect URI must use /api/team/auth/callback");
        if (this.config.oidc.clientSecretEnv && !process.env[this.config.oidc.clientSecretEnv]) throw new Error("Configured OIDC client secret environment variable is missing");
      }
    }
    this.dummyHash = hashTeamPassword(opaque());
  }
  get enabled(): boolean { return !!this.config; }
  get workspaceId(): string | undefined { return this.config?.workspace.id; }
  get name(): string | undefined { return this.config?.workspace.name; }
  private cookie(name: string, value: string, seconds: number): string {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.origin.startsWith("https:") ? "; Secure" : ""}`;
  }
  lookupUser(id: string): TeamIdentity | null {
    const user = this.config?.users.find(row => row.id === id);
    return user ? { workspaceId: this.config!.workspace.id, userId: user.id, displayName: user.name, role: user.role } : null;
  }
  /** Trusted server configuration only; never serialize this through a browser API. */
  snapshotConfig(): TeamConfig {
    if (!this.config) throw new TeamAuthError("Team sign-in is not configured", 404);
    return structuredClone(this.config);
  }
  configurationDigest(): string { return createHash("sha256").update(JSON.stringify(this.snapshotConfig())).digest("hex"); }
  members(): Array<Pick<TeamIdentity, "userId" | "displayName" | "role">> {
    return (this.config?.users ?? []).map(user => ({ userId: user.id, displayName: user.name, role: user.role }));
  }
  /** Called only after an owner-authorized member has been durably persisted. */
  addMember(input: { id: string; name: string; role: "editor" | "viewer"; passwordHash: string }): TeamIdentity {
    if (!this.config) throw new TeamAuthError("Team sign-in is not configured", 404);
    const member = userSchema.extend({ role: z.enum(["editor", "viewer"]), passwordHash: z.string() }).parse(input);
    if (!validHash(member.passwordHash)) throw new TeamAuthError("Invalid password hash", 400);
    if (this.config.users.some(user => user.id === member.id)) throw new TeamAuthError("That account ID already exists", 409);
    if (this.config.users.length >= 1000) throw new TeamAuthError("Workspace member limit reached", 409);
    this.config.users.push(member);
    return this.lookupUser(member.id)!;
  }
  resolveSessionId(id: string | undefined): TeamIdentity | null {
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || session.expires <= this.now()) { this.sessions.delete(id); return null; }
    return this.lookupUser(session.userId);
  }
  resolveSession(req: Pick<IncomingMessage, "headers">): TeamIdentity | null { return this.resolveSessionId(getSessionId(req)); }
  status(req: Pick<IncomingMessage, "headers">) {
    return { enabled: this.enabled, ...(this.config ? { workspace: this.config.workspace } : {}), user: this.resolveSession(req), sso: !!this.config?.oidc };
  }
  private issueSession(userId: string) {
    for (const [id, session] of this.sessions) if (session.expires <= this.now()) this.sessions.delete(id);
    if (this.sessions.size >= 10000) throw new TeamAuthError("Session capacity reached", 503);
    const sessionId = opaque(); this.sessions.set(sessionId, { userId, expires: this.now() + SESSION_MS });
    return { sessionId, user: this.lookupUser(userId)!, setCookie: this.cookie(COOKIE, sessionId, SESSION_MS / 1000) };
  }
  async login(input: unknown, rateKey = "local") {
    if (!this.config) throw new TeamAuthError("Team sign-in is not configured", 404);
    const parsed = z.object({ userId: z.string().min(1).max(160), password: z.string().min(1).max(1024) }).strict().safeParse(input);
    if (!parsed.success) throw new TeamAuthError("User ID and password are required", 400);
    // Rate key must come from the server socket, never a request identity or forwarding header.
    const key = rateKey;
    for (const [id, row] of this.attempts) if (row.expires <= this.now()) this.attempts.delete(id);
    const attempt = this.attempts.get(key) ?? { count: 0, expires: this.now() + 60_000 };
    if (attempt.count >= 10 || this.attempts.size >= 10000) throw new TeamAuthError("Too many sign-in attempts; try again shortly", 429);
    attempt.count++; this.attempts.set(key, attempt);
    const user = this.config.users.find(row => row.id === parsed.data.userId);
    const matches = await passwordMatches(parsed.data.password, user?.passwordHash ?? await this.dummyHash);
    if (!user?.passwordHash || !matches) throw new TeamAuthError("Invalid user ID or password");
    return this.issueSession(user.id);
  }
  logout(req: Pick<IncomingMessage, "headers">): { setCookie: string } {
    const id = getSessionId(req); if (id) this.sessions.delete(id);
    return { setCookie: this.cookie(COOKIE, "", 0) };
  }
  private requireProviderURL(value: string): URL {
    const url = new URL(value);
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("OIDC endpoints require HTTPS (HTTP is allowed only on loopback)");
    return url;
  }
  private async getDiscovery(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const oidc = this.config?.oidc; if (!oidc) throw new TeamAuthError("SSO is not configured", 404);
    const response = await fetch(`${oidc.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) throw new TeamAuthError("SSO provider is unavailable", 502);
    const data = z.object({ issuer: z.string(), authorization_endpoint: z.string().url(), token_endpoint: z.string().url(), jwks_uri: z.string().url() }).parse(await response.json());
    if (data.issuer !== oidc.issuer) throw new TeamAuthError("SSO provider issuer does not match", 502);
    for (const endpoint of [data.authorization_endpoint, data.token_endpoint, data.jwks_uri]) this.requireProviderURL(endpoint);
    this.discovery = data; this.keys = createRemoteJWKSet(new URL(data.jwks_uri)); return data;
  }
  async beginSSO(): Promise<{ url: string; setCookie: string }> {
    const discovery = await this.getDiscovery(); const oidc = this.config!.oidc!;
    for (const [id, pending] of this.pending) if (pending.expires <= this.now()) this.pending.delete(id);
    if (this.pending.size >= 1000) throw new TeamAuthError("Too many pending sign-ins", 429);
    const state = opaque(), nonce = opaque(), verifier = opaque(), browser = opaque();
    this.pending.set(state, { nonce, verifier, browser, expires: this.now() + SSO_MS });
    const url = new URL(discovery.authorization_endpoint);
    for (const [key, value] of Object.entries({ response_type: "code", scope: "openid profile", client_id: oidc.clientId, redirect_uri: oidc.redirectUri, state, nonce, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" })) url.searchParams.set(key, value);
    return { url: url.href, setCookie: this.cookie(SSO_COOKIE, browser, SSO_MS / 1000) };
  }
  async callback(params: URLSearchParams, req: Pick<IncomingMessage, "headers">) {
    const state = params.get("state") ?? ""; const pending = this.pending.get(state);
    const browser = parseCookies(req.headers.cookie)[SSO_COOKIE];
    if (!pending || pending.expires <= this.now() || browser !== pending.browser) throw new TeamAuthError("Invalid or expired SSO sign-in");
    this.pending.delete(state); // Consume even if exchange or verification fails; never permit replay.
    const code = params.get("code"); if (!code || params.has("error")) throw new TeamAuthError("SSO sign-in was not completed");
    const discovery = await this.getDiscovery(); const oidc = this.config!.oidc!;
    const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: oidc.clientId, redirect_uri: oidc.redirectUri, code_verifier: pending.verifier });
    if (oidc.clientSecretEnv) body.set("client_secret", process.env[oidc.clientSecretEnv]!);
    const response = await fetch(discovery.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) throw new TeamAuthError("SSO code exchange failed");
    const tokens = z.object({ id_token: z.string().max(32_000) }).passthrough().parse(await response.json());
    let payload;
    try { ({ payload } = await jwtVerify(tokens.id_token, this.keys!, { issuer: oidc.issuer, audience: oidc.clientId, algorithms: ["RS256", "ES256"], requiredClaims: ["exp", "iat", "sub", "nonce"], currentDate: new Date(this.now()), maxTokenAge: "10 minutes" })); }
    catch { throw new TeamAuthError("SSO identity verification failed"); }
    if (payload.nonce !== pending.nonce || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== oidc.clientId)) throw new TeamAuthError("SSO identity verification failed");
    const user = this.config!.users.find(row => row.oidcSub === payload.sub);
    if (!user) throw new TeamAuthError("This SSO account is not a workspace member", 403);
    const session = this.issueSession(user.id);
    return { ...session, setCookies: [session.setCookie, this.cookie(SSO_COOKIE, "", 0)], redirect: "/" };
  }
}
