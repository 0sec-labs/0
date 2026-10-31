import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { getSiwcConnection, listChatGptPlanProfiles, selectChatGptPlanProfile, signInChatGptPlan, signOutChatGptPlan } from "./chatgpt-plan-store.js";
import { SIWC_ISSUER, SIWC_SCOPES } from "./chatgpt-plan-auth.js";
let keys: Awaited<ReturnType<typeof generateKeyPair>>, jwk: Awaited<ReturnType<typeof exportJWK>>;
const roots: string[] = [];
beforeAll(async () => { keys = await generateKeyPair("RS256"); jwk = { ...await exportJWK(keys.publicKey), kid: "key", alg: "RS256" }; });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(expired = true) {
  const home = mkdtempSync(join(tmpdir(), "zero-siwc-store-")); roots.push(home);
  const directory = join(home, ".0", "chatgpt-plan"), file = join(directory, "accounts.json"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const profile = { id: "profile-a", subject: "subject-a", clientId: "oaiapp_a", issuer: SIWC_ISSUER, email: "person@example.test", scopes: SIWC_SCOPES, idToken: "old-id", accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() + (expired ? -1000 : 3_600_000), status: "connected" };
  const store = { version: 1, revision: 1, hostId: "urn:uuid:00000000-0000-4000-8000-000000000001", activeId: profile.id, profiles: [profile] };
  writeFileSync(file, JSON.stringify(store), { mode: 0o600 }); return { home, directory, file, profile, store };
}
function transport(options: { failJwksOnce?: boolean; beforeToken?: () => Promise<void> } = {}) {
  let failed = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("openid-configuration")) return Response.json({ issuer: SIWC_ISSUER, token_endpoint: `${SIWC_ISSUER}/api/accounts/oauth/token`, jwks_uri: `${SIWC_ISSUER}/keys`, revocation_endpoint: `${SIWC_ISSUER}/revoke` });
    if (url.endsWith("/keys")) { if (options.failJwksOnce && !failed) { failed = true; throw new Error("private-network-details"); } return Response.json({ keys: [jwk] }); }
    if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
    expect(new URLSearchParams(String(init?.body)).get("client_id")).toBe("oaiapp_a");
    await options.beforeToken?.();
    const id = await new SignJWT({ sub: "subject-a" }).setProtectedHeader({ alg: "RS256", kid: "key" }).setIssuer(SIWC_ISSUER).setAudience("oaiapp_a").setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
    return Response.json({ access_token: "new-access", refresh_token: "replacement-refresh", id_token: id, token_type: "Bearer", expires_in: 3600, scope: SIWC_SCOPES.join(" ") });
  });
  return { fetch };
}
describe("private 0-owned ChatGPT profile storage", () => {
  it("keeps tokens out of inventory, pins old runtimes to their account, and atomically rotates once for concurrent callers", async () => {
    const f = fixture(), t = transport();
    const a = getSiwcConnection(f.home, undefined, t), b = getSiwcConnection(f.home, undefined, t);
    const values = await Promise.all([a.resolveCredentials(), b.resolveCredentials(), a.resolveCredentials()]);
    expect(values.every(value => value.accessToken === "new-access")).toBe(true);
    expect(t.fetch.mock.calls.filter(([url]) => String(url).endsWith("oauth/token"))).toHaveLength(1);
    const disk = JSON.parse(readFileSync(f.file, "utf8")); expect(disk.profiles[0].refreshToken).toBe("replacement-refresh"); expect(disk.profiles[0].pendingRotation).toBeUndefined();
    expect(statSync(f.file).mode & 0o077).toBe(0);
    expect(JSON.stringify(listChatGptPlanProfiles(f.home))).not.toMatch(/new-access|replacement-refresh|old-id/);
  });
  it("retains rotated refresh tokens before verification and recovers without replaying an already-consumed refresh", async () => {
    const f = fixture(), t = transport({ failJwksOnce: true }); const connection = getSiwcConnection(f.home, undefined, t);
    await expect(connection.resolveCredentials()).rejects.toThrow("could not reach");
    expect(JSON.parse(readFileSync(f.file, "utf8")).profiles[0].pendingRotation.refresh_token).toBe("replacement-refresh");
    expect(await connection.resolveCredentials()).toMatchObject({ accessToken: "new-access" });
    expect(t.fetch.mock.calls.filter(([url]) => String(url).endsWith("oauth/token"))).toHaveLength(1);
  });
  it("persists rotation even if the original inference caller cancels", async () => {
    const f = fixture(); let release!: () => void; const blocked = new Promise<void>(done => { release = done; });
    const t = transport({ beforeToken: () => blocked }), controller = new AbortController();
    const result = getSiwcConnection(f.home, undefined, t).resolveCredentials(controller.signal);
    await vi.waitFor(() => expect(t.fetch.mock.calls.some(([url]) => String(url).endsWith("oauth/token"))).toBe(true));
    controller.abort(); release(); await expect(result).rejects.toThrow();
    expect(JSON.parse(readFileSync(f.file, "utf8")).profiles[0].refreshToken).toBe("replacement-refresh");
  });
  it("obeys a lock held by another process before starting refresh", async () => {
    const f = fixture(), t = transport();
    const child = spawn(process.execPath, ["-e", "const fs=require('node:fs');const p=process.argv[1];const fd=fs.openSync(p,'wx',0o600);process.stdout.write('ready\\n');process.stdin.once('data',()=>{fs.closeSync(fd);fs.unlinkSync(p);process.exit(0)});", join(f.directory, "write.lock")], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await once(child.stdout, "data"); const result = getSiwcConnection(f.home, undefined, t).resolveCredentials();
      await new Promise(done => setTimeout(done, 60)); expect(t.fetch).not.toHaveBeenCalled();
      child.stdin.end("release"); await result; expect(t.fetch).toHaveBeenCalled();
    } finally { if (child.exitCode === null) child.kill(); }
  });
  it("switching active profiles cannot retarget an already captured connection", async () => {
    const f = fixture(false); const connection = getSiwcConnection(f.home);
    f.store.profiles.push({ ...f.profile, id: "profile-b", subject: "subject-b", clientId: "oaiapp_b", accessToken: "b-access" });
    writeFileSync(f.file, JSON.stringify(f.store), { mode: 0o600 }); await selectChatGptPlanProfile("profile-b", f.home);
    expect(await connection.resolveCredentials()).toMatchObject({ accessToken: "old-access" });
    expect(await getSiwcConnection(f.home).resolveCredentials()).toMatchObject({ accessToken: "b-access" });
  });
  it("a changed stored binding or missing plan permission cannot supply a credential", async () => {
    const f = fixture(false), connection = getSiwcConnection(f.home); f.store.profiles[0].subject = "changed"; writeFileSync(f.file, JSON.stringify(f.store));
    await expect(connection.resolveCredentials()).rejects.toThrow("no longer available");
    f.store.profiles[0].scopes = ["openid"]; writeFileSync(f.file, JSON.stringify(f.store));
    await expect(getSiwcConnection(f.home).resolveCredentials()).rejects.toThrow("not enabled");
  });
  it("a later sign-out fences a reconnect already waiting in the browser", async () => {
    const f = fixture(false); let ready!: () => void, allow!: () => void;
    const opened = new Promise<void>(done => { ready = done; }), released = new Promise<void>(done => { allow = done; });
    let nonce = "";
    const t = transport();
    const signinFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (!String(input).endsWith("oauth/token")) return t.fetch(input, init);
      const idToken = await new SignJWT({ sub: "subject-a", nonce }).setProtectedHeader({ alg: "RS256", kid: "key" }).setIssuer(SIWC_ISSUER).setAudience("oaiapp_a").setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
      return Response.json({ access_token: "late-access", refresh_token: "late-refresh", id_token: idToken, scope: SIWC_SCOPES.join(" "), token_type: "Bearer", expires_in: 3600 });
    });
    const signin = signInChatGptPlan({ homeDir: f.home, profileId: "profile-a", fetch: signinFetch, onAuthorize: async value => {
      const auth = new URL(value); nonce = auth.searchParams.get("nonce")!; ready(); await released;
      const callback = new URL(auth.searchParams.get("redirect_uri")!); callback.searchParams.set("code", "late-code"); callback.searchParams.set("state", auth.searchParams.get("state")!);
      await fetch(callback);
    } });
    await opened; await signOutChatGptPlan("profile-a", f.home, t); allow();
    await expect(signin).rejects.toThrow("changed during sign-in");
    expect(JSON.parse(readFileSync(f.file, "utf8")).profiles[0]).toMatchObject({ status: "signed-out", epoch: 1 });
    expect(readFileSync(f.file, "utf8")).not.toContain("late-access");
  });
  it("revokes a pending rotated successor rather than the spent old token", async () => {
    const f = fixture(), t = transport();
    const staged = { ...f.store, profiles: [{ ...f.profile, pendingRotation: { refresh_token: "new-pending-refresh" } }] }; writeFileSync(f.file, JSON.stringify(staged));
    expect(await signOutChatGptPlan("profile-a", f.home, t)).toEqual({ revoked: true });
    const revoke = t.fetch.mock.calls.find(([url]) => String(url).endsWith("/revoke"))!;
    expect(new URLSearchParams(String(revoke[1]?.body)).get("token")).toBe("new-pending-refresh");
  });
  it("clears local credentials even when pending rotation contains an invalid token", async () => {
    const f = fixture(), t = transport();
    writeFileSync(f.file, JSON.stringify({ ...f.store, profiles: [{ ...f.profile, pendingRotation: { refresh_token: "bad token" } }] }));
    expect(await signOutChatGptPlan("profile-a", f.home, t)).toEqual({ revoked: false });
    expect(JSON.parse(readFileSync(f.file, "utf8")).profiles[0].status).toBe("signed-out");
  });
  it("sign-out revokes and clears tokens while preserving registration/host metadata", async () => {
    const f = fixture(false), t = transport(); expect(await signOutChatGptPlan("profile-a", f.home, t)).toEqual({ revoked: true });
    const disk = JSON.parse(readFileSync(f.file, "utf8")); expect(disk.hostId).toBe(f.store.hostId); expect(disk.profiles[0]).toMatchObject({ clientId: "oaiapp_a", subject: "subject-a", status: "signed-out" });
    expect(disk.profiles[0].refreshToken).toBeUndefined(); expect(disk.profiles[0].idToken).toBe(""); expect(() => getSiwcConnection(f.home)).toThrow("Connect");
  });
});
