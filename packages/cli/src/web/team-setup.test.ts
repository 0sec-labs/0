import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamAuth, getSessionId } from "./team-auth.js";
import { TeamSetupService, defaultTeamConfigPath, findTeamConfigPath, handleTeamSetupRequest, isolatedTeamPaths, type PreparedTeamWorkspace } from "./team-setup.js";
let directory: string; let workspace: string; let stateRoot: string;
const origin = "http://127.0.0.1:48123";
const input = { workspaceName: "Security", displayName: "Alex", userId: "alex", password: "disposable setup password" };
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "zero-team-setup-")); workspace = join(directory, "source"); stateRoot = join(directory, "state"); mkdirSync(workspace); mkdirSync(stateRoot); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function fixture(activateOverride?: () => Promise<void>) {
  let auth = new TeamAuth({ origin });
  // Keep the independently staged auth inside this mock active service bundle.
  const switchWorkspace = vi.fn(async (prepared: PreparedTeamWorkspace) => { if (activateOverride) await activateOverride(); auth = prepared.auth; });
  const service = new TeamSetupService({ workspacePath: workspace, stateRoot, origin: () => origin, currentAuth: () => auth, activate: switchWorkspace });
  return { service, switchWorkspace, auth: () => auth };
}
describe("same-server workspace setup", () => {
  it("activates an isolated team and immediate owner session without touching personal state", async () => {
    const personal = join(stateRoot, "data.db"); writeFileSync(personal, "personal retained evidence");
    const saved = join(stateRoot, "sessions", "personal.json"); mkdirSync(join(stateRoot, "sessions")); writeFileSync(saved, "private transcript");
    const { service, auth, switchWorkspace } = fixture();
    expect(service.status()).toEqual({ available: true, pending: false });
    const result = await service.setup(input);
    const prepared = switchWorkspace.mock.calls[0]![0];
    expect(prepared.auth).toBe(auth());
    expect(prepared.dbPath).not.toBe(personal); expect(prepared.stateDir).not.toBe(stateRoot);
    expect(result.user).toMatchObject({ userId: "alex", role: "owner", workspaceId: result.workspace.id });
    const cookie = result.setCookie.split(";")[0]!;
    expect(auth().resolveSessionId(getSessionId({ headers: { cookie } }))).toEqual(result.user);
    const path = defaultTeamConfigPath(workspace, stateRoot); expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(isolatedTeamPaths(result.workspace.id, stateRoot).stateDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8")).not.toContain(input.password);
    expect(readFileSync(personal, "utf8")).toBe("personal retained evidence"); expect(readFileSync(saved, "utf8")).toBe("private transcript");
    expect(service.status().available).toBe(false);
    await expect(service.setup(input)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("automatically discovers the persisted config across launches and canonical paths", async () => {
    const { service } = fixture(); expect(findTeamConfigPath({ workspacePath: workspace, stateRoot })).toBeUndefined();
    await service.setup(input);
    const alias = join(directory, "alias"); symlinkSync(workspace, alias);
    expect(defaultTeamConfigPath(alias, stateRoot)).toBe(defaultTeamConfigPath(workspace, stateRoot));
    const configPath = findTeamConfigPath({ workspacePath: alias, stateRoot })!;
    const nextLaunch = new TeamAuth({ configPath, origin });
    expect(nextLaunch.enabled).toBe(true); expect((await nextLaunch.login({ userId: input.userId, password: input.password })).user.role).toBe("owner");
    expect(findTeamConfigPath({ workspacePath: workspace, stateRoot, explicitConfigPath: "./custom-team.json" })).toMatch(/custom-team\.json$/);
  });
  it("rolls back durable config on activation failure while retaining personal auth", async () => {
    const { service, auth } = fixture(async () => { throw new Error("failure includes disposable setup password"); });
    const priorAuth = auth();
    await expect(service.setup(input)).rejects.toMatchObject({ statusCode: 500, message: "Workspace setup could not be completed" });
    expect(auth()).toBe(priorAuth); expect(auth().enabled).toBe(false);
    expect(existsSync(defaultTeamConfigPath(workspace, stateRoot))).toBe(false); expect(service.status().available).toBe(true);
  });
  it("is single-flight and refuses unexpected account assertions before activation", async () => {
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const { service, switchWorkspace } = fixture(() => wait);
    await expect(service.setup({ ...input, role: "owner" })).rejects.toMatchObject({ statusCode: 400 });
    expect(switchWorkspace).not.toHaveBeenCalled();
    const first = service.setup(input); await expect(service.setup(input)).rejects.toMatchObject({ statusCode: 409 });
    finish(); await first; expect(switchWorkspace).toHaveBeenCalledTimes(1);
  });
  it("prevents independent setup races from overwriting the owner", async () => {
    const a = fixture(); const b = fixture();
    const outcomes = await Promise.allSettled([a.service.setup(input), b.service.setup({ ...input, userId: "other" })]);
    expect(outcomes.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(row => row.status === "rejected")).toHaveLength(1);
    const config = JSON.parse(readFileSync(defaultTeamConfigPath(workspace, stateRoot), "utf8"));
    expect(config.users).toHaveLength(1);
  });
  it("bounds repeated failed activation attempts without saving credentials", async () => {
    const { service } = fixture(async () => { throw new Error("Unavailable"); });
    for (let count = 0; count < 5; count++) await expect(service.setup(input)).rejects.toMatchObject({ statusCode: 500 });
    await expect(service.setup(input)).rejects.toMatchObject({ statusCode: 429 });
    expect(existsSync(defaultTeamConfigPath(workspace, stateRoot))).toBe(false);
  });
  it("returns only public identity and HttpOnly session cookie through the API controller", async () => {
    const { service } = fixture(); const url = new URL("/api/team/setup", origin);
    const reply = await handleTeamSetupRequest({ method: "POST" }, url, service, async () => input);
    expect(reply!.status).toBe(201); expect(reply!.headers!["Set-Cookie"]).toContain("HttpOnly");
    expect(JSON.stringify(reply!.data)).not.toContain("sessionId"); expect(JSON.stringify(reply!.data)).not.toContain("password");
    await expect(handleTeamSetupRequest({ method: "DELETE" }, url, service, async () => input)).rejects.toMatchObject({ statusCode: 405 });
    expect(await handleTeamSetupRequest({ method: "GET" }, url, service, async () => null)).toEqual({ status: 200, data: { available: false, pending: false } });
  });
});

describe("owner-managed teammate accounts", () => {
  async function ownerFixture() {
    const result = fixture(); const signedIn = await result.service.setup(input);
    const req = { headers: { cookie: signedIn.setCookie.split(";")[0]! } };
    return { ...result, signedIn, req };
  }
  it("persists private accounts and permits immediate login while retaining the owner's session", async () => {
    const { service, auth, req, signedIn } = await ownerFixture();
    const reply = await handleTeamSetupRequest({ method: "POST", ...req }, new URL("/api/team/users", origin), service, async () => ({ userId: "morgan", displayName: "Morgan", password: "disposable teammate secret", role: "editor" }));
    expect(reply!.status).toBe(201); expect(reply!.headers).toBeUndefined();
    expect(auth().resolveSession(req)).toEqual(signedIn.user);
    const teammate = await auth().login({ userId: "morgan", password: "disposable teammate secret" }); expect(teammate.user.role).toBe("editor");
    const path = defaultTeamConfigPath(workspace, stateRoot);
    expect(statSync(path).mode & 0o777).toBe(0o600); expect(readFileSync(path, "utf8")).not.toContain("disposable teammate secret");
    const list = await handleTeamSetupRequest({ method: "GET", ...req }, new URL("/api/team/users", origin), service, async () => null);
    expect(list!.data).toEqual({ users: [{ userId: "alex", displayName: "Alex", role: "owner" }, { userId: "morgan", displayName: "Morgan", role: "editor" }] });
    expect(JSON.stringify(list!.data)).not.toContain("Hash");
    const reloaded = new TeamAuth({ configPath: path, origin }); expect((await reloaded.login({ userId: "morgan", password: "disposable teammate secret" })).user.role).toBe("editor");
  });
  it("allows member listing but refuses non-owner creation and forged owner role", async () => {
    const { service, auth, req } = await ownerFixture();
    await expect(service.addMember(req, { userId: "other", displayName: "Other", password: "secret", role: "owner" })).rejects.toMatchObject({ statusCode: 400 });
    for (const role of ["editor", "viewer"] as const) {
      await service.addMember(req, { userId: role, displayName: role, password: "test role secret", role });
      const session = await auth().login({ userId: role, password: "test role secret" });
      const memberReq = { headers: { cookie: session.setCookie.split(";")[0]! } };
      expect(service.members(memberReq).users.length).toBeGreaterThan(1);
      await expect(service.addMember(memberReq, { userId: "nope", displayName: "Nope", password: "secret", role: "editor" })).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(() => service.members({ headers: {} })).toThrow("Sign in");
    await expect(service.addMember({ headers: {} }, {})).rejects.toMatchObject({ statusCode: 401 });
  });
  it("rejects duplicate IDs and externally modified config without overwriting it", async () => {
    const { service, req } = await ownerFixture(); const path = defaultTeamConfigPath(workspace, stateRoot);
    await expect(service.addMember(req, { userId: "alex", displayName: "Other", password: "secret", role: "editor" })).rejects.toMatchObject({ statusCode: 409 });
    const config = JSON.parse(readFileSync(path, "utf8")); config.workspace.name = "External edit";
    writeFileSync(path, JSON.stringify(config)); const external = readFileSync(path, "utf8");
    await expect(service.addMember(req, { userId: "other", displayName: "Other", password: "secret", role: "editor" })).rejects.toMatchObject({ statusCode: 409 });
    expect(readFileSync(path, "utf8")).toBe(external); expect(existsSync(`${path}.lock`)).toBe(false);
  });
  it("shares the CLI lock and preserves explicit configuration paths", async () => {
    const path = join(directory, "explicit.json");
    let auth = new TeamAuth({ origin }); const service = new TeamSetupService({ workspacePath: workspace, stateRoot, configPath: path, origin: () => origin, currentAuth: () => auth, activate: async prepared => { auth = prepared.auth; } });
    const owner = await service.setup(input); const req = { headers: { cookie: owner.setCookie.split(";")[0]! } };
    writeFileSync(`${path}.lock`, "", { mode: 0o600 });
    await expect(service.addMember(req, { userId: "other", displayName: "Other", password: "secret", role: "viewer" })).rejects.toMatchObject({ statusCode: 409 });
    expect(existsSync(`${path}.lock`)).toBe(true);
    rmSync(`${path}.lock`); await service.addMember(req, { userId: "other", displayName: "Other", password: "secret", role: "viewer" });
    expect(JSON.parse(readFileSync(path, "utf8")).users).toHaveLength(2); expect(existsSync(defaultTeamConfigPath(workspace, stateRoot))).toBe(false);
  });
});
