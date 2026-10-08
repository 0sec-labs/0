import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamAuth, hashTeamPassword } from "./team-auth.js";
import { CollaborationService } from "./collaboration.js";
import { assertTeamConsoleMutation, authorizeTeamApi, handleTeamRequest } from "./team-web.js";
import type { ConsoleGateway } from "./console-gateway.js";
let hash: string, directory: string, auth: TeamAuth, collaboration: CollaborationService;
let cookies: Record<string, string>, gateway: ConsoleGateway;
const origin = "http://127.0.0.1:48123";
function request(method = "GET", cookie?: string): IncomingMessage { return { method, headers: { ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage; }
async function route(path: string, method = "GET", user?: string, body?: unknown, validate?: (kind: "conversation" | "report" | "workflow", id: string) => void) {
  return handleTeamRequest(request(method, user ? cookies[user] : undefined), new URL("/api/team/" + path, origin), auth, collaboration, gateway, async () => body, validate);
}
beforeAll(async () => { hash = await hashTeamPassword("test-only-password"); });
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "0-team-web-"));
  auth = new TeamAuth({ origin, config: { workspace: { id: "shared-team", name: "Test team" }, users: [
    { id: "owner", name: "Owner", role: "owner", passwordHash: hash }, { id: "editor", name: "Editor", role: "editor", passwordHash: hash }, { id: "viewer", name: "Viewer", role: "viewer", passwordHash: hash },
  ] } });
  collaboration = new CollaborationService({ workspaceId: auth.workspaceId!, stateDir: directory, resolveSession: id => auth.resolveSessionId(id) });
  cookies = {};
  for (const id of ["owner", "editor", "viewer"]) cookies[id] = (await auth.login({ userId: id, password: "test-only-password" }, id)).setCookie.split(";")[0]!;
  gateway = { get: (id: string) => { if (id !== "chat-a") throw new Error("No such gateway conversation"); return { session: { id } }; } } as unknown as ConsoleGateway;
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("shared room HTTP authorization", () => {
  it("requires authenticated accounts for shared reads/writes and ordinary API reads/writes", async () => {
    await expect(route("conversations/chat-a")).rejects.toThrow("Sign in");
    await expect(route("presence")).rejects.toThrow("Sign in");
    await expect(route("conversations/chat-a/presence", "POST", undefined, { typing: false })).rejects.toThrow("Sign in");
    expect(() => authorizeTeamApi(auth, request(), "/api/dashboard")).toThrow("Sign in");
    expect(() => authorizeTeamApi(auth, request("POST"), "/api/console/sessions")).toThrow("Sign in");
    expect((await route("session"))?.data).toMatchObject({ enabled: true, user: null });
    expect(collaboration.hasConversation("chat-a")).toBe(false);
  });
  it("lets viewers browse and send presence without granting chat mutation permissions", async () => {
    expect((await route("conversations/chat-a/presence", "POST", "viewer", { typing: false }))?.data).toMatchObject({ viewer: { role: "viewer" }, canWrite: false });
    expect(authorizeTeamApi(auth, request("GET", cookies.viewer), "/api/console/sessions")?.role).toBe("viewer");
    expect(() => authorizeTeamApi(auth, request("POST", cookies.viewer), "/api/console/sessions")).toThrow("read-only");
    expect(() => assertTeamConsoleMutation(request("POST", cookies.viewer), "chat-a", auth, collaboration, gateway)).toThrow("viewers");
  });
  it("keeps engine settings and machine bridge restricted to owners", () => {
    for (const path of ["/api/control/reset-database", "/api/workflow-engine/call", "/api/console/settings", "/api/console/connections", "/api/console/plugins/install", "/api/console/github/connect", "/api/console/checks"]) {
      expect(() => authorizeTeamApi(auth, request("POST", cookies.editor), path), path).toThrow();
      expect(authorizeTeamApi(auth, request("POST", cookies.owner), path)?.role).toBe("owner");
    }
    expect(() => authorizeTeamApi(auth, request("GET", cookies.editor), "/api/backends/remote/proxy/api/dashboard")).toThrow("workspace owner");
  });
  it("allows independently authenticated writers to mutate any shared conversation with no exclusive lease", async () => {
    await route("conversations/chat-a", "GET", "owner");
    const mutations: Array<[string, string]> = [["POST", "messages"], ["PATCH", "configuration"], ["POST", "cancel"], ["POST", "clear"], ["POST", "continue"], ["POST", "harness"], ["POST", "save"], ["POST", "archive"], ["POST", "delete"], ["DELETE", "queue"], ["POST", "decisions/decision-a"], ["POST", "workers/stop"], ["POST", "workers/worker-a/messages"], ["DELETE", ""]];
    for (const [method, action] of mutations) {
      const path = "/api/console/sessions/chat-a/" + action;
      expect(authorizeTeamApi(auth, request(method, cookies.editor), path)?.role).toBe("editor");
      expect(() => assertTeamConsoleMutation(request(method, cookies.editor), "chat-a", auth, collaboration, gateway)).not.toThrow();
      expect(() => assertTeamConsoleMutation(request(method, cookies.owner), "chat-a", auth, collaboration, gateway)).not.toThrow();
    }
    const otherSession = (await auth.login({ userId: "owner", password: "test-only-password" }, "owner-again")).setCookie.split(";")[0]!;
    expect(() => assertTeamConsoleMutation(request("POST", otherSession), "chat-a", auth, collaboration, gateway)).not.toThrow();
    auth.logout(request("POST", cookies.editor));
    expect(() => assertTeamConsoleMutation(request("POST", cookies.editor), "chat-a", auth, collaboration, gateway)).toThrow("authenticated");
    expect((await route("conversations/chat-a", "GET", "owner"))?.data).not.toHaveProperty("controller");
  });
  it("rejects spoofed identities, missing resources and removed control/proposal endpoints", async () => {
    await expect(route("conversations/chat-a/presence", "POST", "editor", { typing: true, userId: "owner" })).rejects.toThrow("Invalid presence update");
    await expect(route("conversations/missing", "GET", "editor")).rejects.toThrow("No such gateway");
    expect(collaboration.hasConversation("missing")).toBe(false);
    await expect(route("conversations/chat-a/control", "POST", "editor", { action: "claim" })).rejects.toThrow("not found");
    await expect(route("conversations/chat-a/proposals", "POST", "editor", { text: "Inspect" })).rejects.toThrow("not found");
  });
  it("reports participants beside chats and assets only after validating underlying resources", async () => {
    await route("conversations/chat-a/presence", "POST", "editor", { typing: true });
    const validate = vi.fn((kind: string, id: string) => { if (kind !== "report" || id !== "report-a") throw new Error("Unknown report"); });
    expect((await route("rooms/report/report-a/presence", "POST", "viewer", { typing: false }, validate))?.data).toMatchObject({ kind: "report", id: "report-a", canWrite: false });
    expect(validate).toHaveBeenCalledWith("report", "report-a");
    const overview = (await route("presence", "GET", "owner"))!.data as { rooms: Array<{ kind: string; id: string; presence: Array<{ userId: string }> }> };
    expect(overview.rooms.map(room => [room.kind, room.id, room.presence[0]?.userId])).toEqual([["conversation", "chat-a", "editor"], ["report", "report-a", "viewer"]]);
    await expect(route("rooms/report/missing/presence", "POST", "editor", { typing: false }, validate)).rejects.toThrow("Unknown report");
    await expect(route("rooms/workflow/workflow-a/presence", "POST", "editor", { typing: false })).rejects.toThrow("not configured");
    await route("conversations/chat-a/presence", "POST", "editor", { typing: true, viewing: false });
    expect(((await route("presence", "GET", "owner"))!.data as typeof overview).rooms.map(room => room.kind)).toEqual(["report"]);
  });
  it("keeps local account-free operation unchanged when team mode is disabled", async () => {
    const localAuth = new TeamAuth({ origin });
    expect(authorizeTeamApi(localAuth, request("POST"), "/api/console/sessions")).toBeNull();
    expect(() => assertTeamConsoleMutation(request("POST"), "chat-a", localAuth, undefined, gateway)).not.toThrow();
    await expect(handleTeamRequest(request(), new URL("/api/team/presence", origin), localAuth, undefined, gateway, async () => undefined)).rejects.toThrow("not configured");
  });
});
