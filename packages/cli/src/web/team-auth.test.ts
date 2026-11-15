import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TeamAuth, getSessionId, hashTeamPassword, parseCookies, type TeamConfig } from "./team-auth.js";
const origin = "http://127.0.0.1:48123";
let passwordHash: string;
beforeAll(async () => { passwordHash = await hashTeamPassword("correct horse battery"); });
const request = (cookie?: string) => ({ headers: { cookie } });
function config(): TeamConfig { return { workspace: { id: "team", name: "Team" }, users: [{ id: "alex", name: "Alex", role: "viewer", passwordHash }] }; }
function cookieHeader(setCookie: string): string { return setCookie.split(";")[0]!; }
describe("optional workspace sign-in", () => {
  it("leaves an unconfigured local engine account-free", () => {
    const auth = new TeamAuth({ origin }); expect(auth.status(request())).toEqual({ enabled: false, user: null, sso: false });
    expect(auth.resolveSessionId("forged")).toBeNull();
  });
  it("issues opaque sessions and trusts configured roles only", async () => {
    const auth = new TeamAuth({ origin, config: config() });
    const signedIn = await auth.login({ userId: "alex", password: "correct horse battery" });
    expect(signedIn.setCookie).toContain("HttpOnly; SameSite=Lax; Max-Age=28800");
    const req = request(cookieHeader(signedIn.setCookie));
    expect(getSessionId(req)).toBe(signedIn.sessionId);
    expect(auth.resolveSession(req)).toEqual({ workspaceId: "team", userId: "alex", displayName: "Alex", role: "viewer" });
    expect(auth.status(req)).not.toHaveProperty("passwordHash");
    await expect(auth.login({ userId: "alex", password: "correct horse battery", role: "owner" })).rejects.toMatchObject({ statusCode: 400 });
    expect(auth.resolveSessionId(JSON.stringify({ userId: "alex", role: "owner" }))).toBeNull();
    auth.logout(req); expect(auth.resolveSession(req)).toBeNull();
  });
  it("expires sessions and uses Secure on HTTPS", async () => {
    let now = 100; const auth = new TeamAuth({ origin: "https://localhost:48123", config: config(), now: () => now });
    const session = await auth.login({ userId: "alex", password: "correct horse battery" });
    expect(session.setCookie).toContain("; Secure"); now += 8 * 60 * 60 * 1000;
    expect(auth.resolveSessionId(session.sessionId)).toBeNull();
  });
  it("rejects wrong/unknown credentials and throttles server-derived origin", async () => {
    const auth = new TeamAuth({ origin, config: config() });
    await expect(auth.login({ userId: "alex", password: "wrong" }, "socket-a")).rejects.toMatchObject({ message: "Invalid user ID or password", statusCode: 401 });
    for (let i = 0; i < 9; i++) await expect(auth.login({ userId: "unknown", password: "wrong" }, "socket-a")).rejects.toMatchObject({ statusCode: 401 });
    await expect(auth.login({ userId: "alex", password: "correct horse battery" }, "socket-a")).rejects.toMatchObject({ statusCode: 429 });
    expect((await auth.login({ userId: "alex", password: "correct horse battery" }, "socket-b")).user.role).toBe("viewer");
  });
  it("rejects malformed hashes, duplicate IDs and conflicting browser cookies", () => {
    expect(() => new TeamAuth({ origin, config: { ...config(), users: [{ ...config().users[0]!, passwordHash: "plaintext" }] } })).toThrow("Invalid team password hash");
    expect(() => new TeamAuth({ origin, config: { ...config(), users: [...config().users, ...config().users] } })).toThrow("unique");
    expect(parseCookies("zero_team_session=a; zero_team_session=b").zero_team_session).toBe("");
  });
});

let server: Server | undefined;
afterEach(async () => { if (server) { const active = server; server = undefined; active.closeAllConnections(); await new Promise<void>(resolve => active.close(() => resolve())); } });
async function provider() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  let issuer = ""; let nonce = ""; let tokenIssuer: string | undefined; let audience: string | undefined; let subject = "verified-sub";
  let lastVerifier = "";
  server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/.well-known/openid-configuration") return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys` }));
    if (req.url === "/keys") return res.end(JSON.stringify({ keys: [jwk] }));
    if (req.url === "/token") {
      let body = ""; for await (const part of req) body += part.toString();
      lastVerifier = new URLSearchParams(body).get("code_verifier")!;
      const id_token = await new SignJWT({ nonce }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(tokenIssuer ?? issuer).setAudience(audience ?? "client").setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(privateKey);
      return res.end(JSON.stringify({ id_token }));
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve)); issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { issuer, setNonce(value: string) { nonce = value; }, setIssuer(value: string) { tokenIssuer = value; }, setAudience(value: string) { audience = value; }, setSubject(value: string) { subject = value; }, verifier() { return lastVerifier; } };
}
async function ssoFixture() {
  const mock = await provider();
  const cfg = config(); cfg.users[0]!.oidcSub = "verified-sub";
  cfg.oidc = { issuer: mock.issuer, clientId: "client", redirectUri: `${origin}/api/team/auth/callback` };
  const auth = new TeamAuth({ origin, config: cfg });
  const start = await auth.beginSSO(); const url = new URL(start.url); mock.setNonce(url.searchParams.get("nonce")!);
  return { auth, mock, start, url, params: new URLSearchParams({ state: url.searchParams.get("state")!, code: "one-time-code" }), req: request(cookieHeader(start.setCookie)) };
}
describe("OIDC authorization code sign-in", () => {
  it("uses PKCE and verified provider subject, then consumes state", async () => {
    const { auth, mock, url, params, req } = await ssoFixture();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const result = await auth.callback(params, req);
    expect(mock.verifier()).toMatch(/^[\w-]{43}$/);
    expect(result.user.role).toBe("viewer"); expect(result.setCookies).toHaveLength(2);
    await expect(auth.callback(params, req)).rejects.toThrow("Invalid or expired");
  });
  it("requires the state to belong to the initiating browser", async () => {
    const { auth, params } = await ssoFixture();
    await expect(auth.callback(params, request())).rejects.toThrow("Invalid or expired");
    params.set("state", "invented"); await expect(auth.callback(params, request())).rejects.toThrow("Invalid or expired");
  });
  it.each(["nonce", "issuer", "audience", "subject"])("rejects an invalid %s without granting a session", async (field) => {
    const { auth, mock, params, req } = await ssoFixture();
    if (field === "nonce") mock.setNonce("wrong"); if (field === "issuer") mock.setIssuer("https://other.example");
    if (field === "audience") mock.setAudience("different-client"); if (field === "subject") mock.setSubject("not-a-member");
    await expect(auth.callback(params, req)).rejects.toMatchObject({ statusCode: field === "subject" ? 403 : 401 });
    expect(auth.resolveSession(req)).toBeNull();
    await expect(auth.callback(params, req)).rejects.toThrow("Invalid or expired");
  });
  it("rejects a callback on a different engine and insecure remote issuers", () => {
    const cfg = config(); cfg.oidc = { issuer: "http://provider.example", clientId: "client", redirectUri: `${origin}/api/team/auth/callback` };
    expect(() => new TeamAuth({ origin, config: cfg })).toThrow("HTTPS");
    cfg.oidc.issuer = "https://provider.example"; cfg.oidc.redirectUri = "http://localhost:99/api/team/auth/callback";
    expect(() => new TeamAuth({ origin, config: cfg })).toThrow("engine origin");
  });
});
