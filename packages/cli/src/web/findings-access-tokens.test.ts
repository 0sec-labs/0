import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { FindingsAccessTokenStore, findingsReadPath, handleFindingsAccessTokenRequest } from "./findings-access-tokens.js";
import { TeamAuth, hashTeamPassword } from "./team-auth.js";
let directory: string, store: FindingsAccessTokenStore, now: number, hash: string;
const request = (method: string, token?: string, cookie?: string) => ({ method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(cookie ? { cookie } : {}) } }) as IncomingMessage;
const url = (path = "/api/v1/findings") => new URL(path, "http://127.0.0.1:48123");
beforeAll(async () => { hash = await hashTeamPassword("test-only-password"); });
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "0-findings-tokens-")); now = 1800000000000; store = new FindingsAccessTokenStore({ workspaceId: "workspace-a", stateDir: directory, now: () => now }); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it("reveals random credentials only at creation and persists only private hashes", () => {
  const created = store.create({ name: "Reporting integration" }, "owner");
  expect(created.token).toMatch(/^0_find_[A-Za-z0-9_-]{43}$/);
  expect(created.credential.scopes).toEqual(["read:findings"]);
  const path = join(directory, readdirSync(directory)[0]!);
  const persisted = readFileSync(path, "utf8");
  expect(persisted).not.toContain(created.token);
  expect(JSON.parse(persisted).tokens[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(store.list()).toEqual([created.credential]);
  expect(JSON.stringify(store.list())).not.toContain("tokenHash");
  expect(JSON.stringify(store.list())).not.toContain(created.token);
  const reopened = new FindingsAccessTokenStore({ workspaceId: "workspace-a", stateDir: directory, now: () => now });
  expect(reopened.authenticate(request("GET", created.token), url())?.id).toBe(created.credential.id);
});
it("limits valid credentials to findings reads, never admin, execution, browser or mutation APIs", () => {
  const { token } = store.create({ name: "Read only" }, "owner");
  for (const path of ["/api/v1/findings", "/api/v1/findings/finding-a", "/api/v1/findings/export?id=a"]) {
    expect(store.authenticate(request("GET", token), url(path))?.scopes).toEqual(["read:findings"]);
    expect(store.authenticate(request("HEAD", token), url(path))?.scopes).toEqual(["read:findings"]);
  }
  for (const path of ["/api/control/launch-run", "/api/console/credentials", "/api/dashboard", "/api/team/session", "/api/findings-access", "/api/findings/export", "/api/v1/findings/a/evidence", "/api/engagements"]) expect(() => store.authenticate(request("GET", token), url(path)), path).toThrow("read-only findings");
  for (const method of ["POST", "PATCH", "DELETE", "PUT", "OPTIONS"]) expect(() => store.authenticate(request(method, token), url())).toThrow("read-only findings");
  expect(findingsReadPath("GET", "/api/v1/findings/%2e%2e")).toBe(false);
  expect(() => store.create({ name: "Escalation", scopes: ["admin"] }, "owner")).toThrow();
  expect(() => store.create({ name: "Spoof", createdBy: "someone" }, "owner")).toThrow();
});
it("revokes and expires immediately, isolates workspaces and ignores unrelated credential transports", () => {
  const first = store.create({ name: "Short", expiresAt: new Date(now + 1000).toISOString() }, "owner");
  expect(() => new FindingsAccessTokenStore({ workspaceId: "workspace-b", stateDir: directory }).authenticate(request("GET", first.token), url())).toThrow("Invalid or expired");
  expect(store.authenticate(request("GET"), url("?token=" + first.token))).toBeNull();
  expect(store.authenticate(request("GET", "admin-engine-token"), url())).toBeNull();
  expect(() => store.authenticate(request("GET", first.token), url("?access_token=" + first.token))).toThrow("Authorization header");
  now += 1001;
  expect(() => store.authenticate(request("GET", first.token), url())).toThrow("Invalid or expired");
  const next = store.create({ name: "Revoked", expiresAt: null }, "owner");
  expect(store.revoke(next.credential.id).revokedAt).not.toBeNull();
  expect(() => store.authenticate(request("GET", next.token), url())).toThrow("Invalid or expired");
  expect(() => store.create({ name: "Past", expiresAt: new Date(now - 1).toISOString() }, "owner")).toThrow("future");
});
it("fails closed on concurrent writers and corrupt workspace storage rather than resurrecting revoked grants", () => {
  const created = store.create({ name: "Lock test" }, "owner");
  const path = join(directory, readdirSync(directory)[0]!);
  writeFileSync(path + ".lock", String(process.pid));
  expect(() => store.revoke(created.credential.id)).toThrow("busy");
  rmSync(path + ".lock");
  store.revoke(created.credential.id);
  const state = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...state, workspaceId: "different" }));
  expect(() => store.authenticate(request("GET", created.token), url())).toThrow("Invalid API access storage");
});
it("allows token management only through verified workspace owners in team mode", async () => {
  const auth = new TeamAuth({ origin: "http://127.0.0.1:48123", config: { workspace: { id: "workspace-a", name: "Workspace" }, users: [
    { id: "owner", name: "Owner", role: "owner", passwordHash: hash }, { id: "editor", name: "Editor", role: "editor", passwordHash: hash },
  ] } });
  const owner = (await auth.login({ userId: "owner", password: "test-only-password" })).setCookie.split(";")[0]!;
  const editor = (await auth.login({ userId: "editor", password: "test-only-password" })).setCookie.split(";")[0]!;
  await expect(handleFindingsAccessTokenRequest(request("POST"), url("/api/findings-access"), auth, store, async () => ({ name: "No auth" }))).rejects.toThrow("Sign in");
  await expect(handleFindingsAccessTokenRequest(request("POST", undefined, editor), url("/api/findings-access"), auth, store, async () => ({ name: "No owner" }))).rejects.toThrow("owners");
  const result = await handleFindingsAccessTokenRequest(request("POST", undefined, owner), url("/api/findings-access"), auth, store, async () => ({ name: "Approved" }));
  expect(result?.data).toMatchObject({ credential: { createdBy: "owner", workspaceId: "workspace-a" }, token: expect.stringMatching(/^0_find_/) });
  const foreign = new FindingsAccessTokenStore({ workspaceId: "workspace-other", stateDir: directory });
  await expect(handleFindingsAccessTokenRequest(request("GET", undefined, owner), url("/api/findings-access"), auth, foreign, async () => undefined)).rejects.toThrow("owners");
});
