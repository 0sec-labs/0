import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamAuth, hashTeamPassword, getSessionId } from "./team-auth.js";
import { CollaborationService } from "./collaboration.js";
import { assertTeamConsoleMutation, authorizeTeamApi, handleTeamRequest } from "./team-web.js";
import type { ConsoleGateway } from "./console-gateway.js";

let hash: string;
let directory: string;
let auth: TeamAuth;
let collaboration: CollaborationService;
let cookies: Record<string, string>;
let gateway: ConsoleGateway;
let send: ReturnType<typeof vi.fn>;
const origin = "http://127.0.0.1:48123";
function request(method = "GET", cookie?: string, lease?: string): IncomingMessage {
  return { method, headers: { ...(cookie ? { cookie } : {}), ...(lease ? { "x-0-team-lease": lease } : {}) }, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage;
}
async function route(path: string, method = "GET", user?: string, body?: unknown, lease?: string) {
  return handleTeamRequest(request(method, user ? cookies[user] : undefined, lease), new URL("/api/team/" + path, origin), auth, collaboration, gateway, async () => body);
}
beforeAll(async () => { hash = await hashTeamPassword("test-only-password"); });
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "0-team-web-"));
  auth = new TeamAuth({ origin, config: { workspace: { id: "shared-team", name: "Test team" }, users: [
    { id: "owner", name: "Owner", role: "owner", passwordHash: hash },
    { id: "editor", name: "Editor", role: "editor", passwordHash: hash },
    { id: "viewer", name: "Viewer", role: "viewer", passwordHash: hash },
  ] } });
  collaboration = new CollaborationService({ workspaceId: auth.workspaceId!, stateDir: directory, resolveSession: id => auth.resolveSessionId(id) });
  cookies = {};
  for (const id of ["owner", "editor", "viewer"]) cookies[id] = (await auth.login({ userId: id, password: "test-only-password" }, id)).setCookie.split(";")[0]!;
  send = vi.fn(async (_id: string, _input: unknown) => ({ id: "chat-a" }));
  gateway = { get: (id: string) => { if (id !== "chat-a") throw new Error("No such gateway conversation"); return { session: { id } }; }, send } as unknown as ConsoleGateway;
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("team HTTP authorization integration", () => {
  it("requires authenticated accounts for team reads/writes and ordinary API reads/writes", async () => {
    await expect(route("conversations/chat-a")).rejects.toThrow("Sign in");
    await expect(route("conversations/chat-a/presence", "POST", undefined, { typing: false })).rejects.toThrow("Sign in");
    await expect(route("conversations/chat-a/proposals", "POST", undefined, { text: "Inspect" })).rejects.toThrow("Sign in");
    expect(() => authorizeTeamApi(auth, request(), "/api/dashboard")).toThrow("Sign in");
    expect(() => authorizeTeamApi(auth, request("POST"), "/api/console/sessions")).toThrow("Sign in");
    const publicSession = await route("session");
    expect(publicSession?.data).toMatchObject({ enabled: true, user: null });
    expect(collaboration.hasConversation("chat-a")).toBe(false);
  });
  it("allows viewer presence and read access but denies chat creation, control and proposals", async () => {
    const presence = await route("conversations/chat-a/presence", "POST", "viewer", { typing: false });
    expect(presence?.data).toMatchObject({ viewer: { role: "viewer", userId: "viewer" }, canControl: false });
    expect(authorizeTeamApi(auth, request("GET", cookies.viewer), "/api/console/sessions")?.role).toBe("viewer");
    expect(() => authorizeTeamApi(auth, request("POST", cookies.viewer), "/api/console/sessions")).toThrow("read-only");
    await expect(route("conversations/chat-a/control", "POST", "viewer", { action: "claim" })).rejects.toThrow("viewers");
    await expect(route("conversations/chat-a/proposals", "POST", "viewer", { text: "Run command" })).rejects.toThrow("viewers");
    expect(send).not.toHaveBeenCalled();
  });
  it("does not grant owner settings or machine-bridge access to editors", () => {
    for (const path of ["/api/control/reset-database", "/api/workflow-engine/call", "/api/console/settings", "/api/console/connections", "/api/console/plugins/install", "/api/console/github/connect", "/api/console/checks"]) {
      expect(() => authorizeTeamApi(auth, request("POST", cookies.editor), path), path).toThrow("owners");
      expect(authorizeTeamApi(auth, request("POST", cookies.owner), path)?.role).toBe("owner");
    }
    expect(() => authorizeTeamApi(auth, request("GET", cookies.editor), "/api/backends/remote/proxy/api/dashboard")).toThrow("workspace owner");
  });
  it("requires exact controller session and lease on all console mutation admissions", async () => {
    const claim = await route("conversations/chat-a/control", "POST", "owner", { action: "claim" });
    const lease = (claim!.data as { leaseToken: string }).leaseToken;
    const mutations: Array<[string, string]> = [
      ["POST", "messages"], ["PATCH", "configuration"], ["POST", "cancel"], ["POST", "clear"],
      ["POST", "continue"], ["POST", "harness"], ["POST", "save"], ["POST", "archive"], ["POST", "delete"],
      ["DELETE", "queue"], ["POST", "decisions/decision-a"], ["POST", "workers/stop"], ["POST", "workers/worker-a/messages"],
      ["DELETE", ""],
    ];
    for (const [method, action] of mutations) {
      const path = "/api/console/sessions/chat-a/" + action;
      expect(authorizeTeamApi(auth, request(method, cookies.editor), path)?.role).toBe("editor");
      expect(() => assertTeamConsoleMutation(request(method, cookies.editor, lease), "chat-a", auth, collaboration, gateway), path).toThrow("current controller lease");
      expect(() => assertTeamConsoleMutation(request(method, cookies.owner), "chat-a", auth, collaboration, gateway), path).toThrow("current controller lease");
      expect(() => assertTeamConsoleMutation(request(method, cookies.owner, lease), "chat-a", auth, collaboration, gateway), path).not.toThrow();
    }
    const otherSession = (await auth.login({ userId: "owner", password: "test-only-password" }, "owner-again")).setCookie.split(";")[0]!;
    expect(() => assertTeamConsoleMutation(request("POST", otherSession, lease), "chat-a", auth, collaboration, gateway)).toThrow("current controller lease");
    auth.logout(request("POST", cookies.owner));
    expect(() => assertTeamConsoleMutation(request("POST", cookies.owner, lease), "chat-a", auth, collaboration, gateway)).toThrow("authenticated");
  });
  it("rejects spoofed identities and nonexistent gateway conversations before registering them", async () => {
    await expect(route("conversations/chat-a/presence", "POST", "editor", { typing: true, userId: "owner" })).rejects.toThrow("booleans");
    await expect(route("conversations/chat-a/proposals", "POST", "editor", { text: "Inspect", role: "owner" })).rejects.toThrow("text only");
    await expect(route("conversations/missing", "GET", "editor")).rejects.toThrow("No such gateway");
    expect(collaboration.hasConversation("missing")).toBe(false);
  });
  it("dispatches an accepted attributed proposal to gateway exactly once", async () => {
    const submitted = await route("conversations/chat-a/proposals", "POST", "editor", { text: "Inspect stored evidence" });
    const proposal = submitted!.data as { id: string; submittedBy: { userId: string } };
    expect(proposal.submittedBy.userId).toBe("editor");
    const claimed = await route("conversations/chat-a/control", "POST", "owner", { action: "claim" });
    const lease = (claimed!.data as { leaseToken: string }).leaseToken;
    await expect(route("conversations/chat-a/proposals/" + proposal.id, "POST", "editor", { action: "accept" }, lease)).rejects.toThrow("current controller lease");
    let finish!: () => void;
    send.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ id: "chat-a" }); }));
    const first = route("conversations/chat-a/proposals/" + proposal.id, "POST", "owner", { action: "accept" }, lease);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await expect(route("conversations/chat-a/proposals/" + proposal.id, "POST", "owner", { action: "accept" }, lease)).rejects.toThrow("already been");
    finish();
    const accepted = await first;
    expect(send).toHaveBeenCalledWith("chat-a", { text: "Inspect stored evidence", mode: "queue" }, { userId: "editor", displayName: "Editor", proposalId: proposal.id });
    expect(accepted!.data).toMatchObject({ proposals: [{ submittedBy: { userId: "editor" }, resolvedBy: { userId: "owner" }, status: "accepted" }] });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("renews/releases leases only through the holder's authenticated cookie plus lease header", async () => {
    const claim = await route("conversations/chat-a/control", "POST", "owner", { action: "claim" });
    const lease = (claim!.data as { leaseToken: string }).leaseToken;
    await expect(route("conversations/chat-a/control", "POST", "owner", { action: "renew" })).rejects.toThrow("current controller lease");
    expect((await route("conversations/chat-a/control", "POST", "owner", { action: "renew" }, lease))!.data).toMatchObject({ leaseToken: lease });
    await expect(route("conversations/chat-a/control", "POST", "editor", { action: "release" }, lease)).rejects.toThrow("current controller lease");
    expect((await route("conversations/chat-a/control", "POST", "owner", { action: "release" }, lease))!.data).toMatchObject({ controller: null, canControl: false });
    expect(auth.resolveSessionId(getSessionId(request("GET", cookies.owner)))?.userId).toBe("owner");
  });
  it("leaves local account-free operation unchanged when team mode is disabled", async () => {
    const localAuth = new TeamAuth({ origin });
    expect(authorizeTeamApi(localAuth, request("POST"), "/api/console/sessions")).toBeNull();
    expect(() => assertTeamConsoleMutation(request("POST"), "chat-a", localAuth, undefined, gateway)).not.toThrow();
    await expect(handleTeamRequest(request(), new URL("/api/team/conversations/chat-a", origin), localAuth, undefined, gateway, async () => undefined)).rejects.toThrow("not configured");
  });
});
