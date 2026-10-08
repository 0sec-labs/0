import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollaborationService, type CollaborationIdentity } from "./collaboration.js";

let directory: string;
let now: number;
let identities: Map<string, CollaborationIdentity>;
let service: CollaborationService;
const actor = (userId: string, role: CollaborationIdentity["role"] = "editor", workspaceId = "team-a"): CollaborationIdentity => ({ userId, displayName: userId.toUpperCase(), workspaceId, role });
function reopen() { return new CollaborationService({ workspaceId: "team-a", stateDir: directory, resolveSession: session => identities.get(session), now: () => now, presenceMs: 2000 }); }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "0-collaboration-")); now = 10000;
  identities = new Map([["owner-session", actor("alice", "owner")], ["bob-session", actor("bob")], ["alice-other-session", actor("alice", "owner")], ["viewer-session", actor("reader", "viewer")], ["foreign-session", actor("mallory", "owner", "team-b")]]);
  service = reopen(); service.register("chat-a", "owner-session");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("authenticated shared resource rooms", () => {
  it("requires authenticated workspace sessions for reads, overview, presence and writes", () => {
    expect(() => service.snapshot("chat-a", "missing")).toThrow("authenticated team session");
    expect(() => service.overview("missing")).toThrow("authenticated team session");
    expect(() => service.snapshot("chat-a", "foreign-session")).toThrow("does not belong");
    expect(() => service.assertWriter("chat-a", "foreign-session")).toThrow("does not belong");
    expect(() => service.heartbeat("chat-a", "bob-session", { typing: true, userId: "alice" })).toThrow("Invalid presence update");
  });
  it("allows all owner/editor sessions to write directly without exclusive ownership", () => {
    expect(service.assertWriter("chat-a", "owner-session").userId).toBe("alice");
    expect(service.assertWriter("chat-a", "bob-session").userId).toBe("bob");
    expect(reopen().assertWriter("chat-a", "alice-other-session").userId).toBe("alice");
    expect(service.snapshot("chat-a", "bob-session").canWrite).toBe(true);
    expect(service.snapshot("chat-a", "alice-other-session").canWrite).toBe(true);
    expect(service.snapshot("chat-a", "bob-session")).not.toHaveProperty("controller");
    expect(service.snapshot("chat-a", "bob-session")).not.toHaveProperty("proposals");
    expect(() => service.assertWriter("missing", "bob-session")).toThrow("not found");
  });
  it("lets viewers join/view but denies resource writes and honors current role revocation", () => {
    expect(service.heartbeat("chat-a", "viewer-session", { typing: false }).viewer.role).toBe("viewer");
    expect(service.snapshot("chat-a", "viewer-session").canWrite).toBe(false);
    expect(() => service.assertWriter("chat-a", "viewer-session")).toThrow("viewers");
    identities.set("bob-session", actor("bob", "viewer"));
    expect(() => service.assertWriter("chat-a", "bob-session")).toThrow("viewers");
    identities.delete("owner-session");
    expect(() => service.assertWriter("chat-a", "owner-session")).toThrow("authenticated");
  });
  it("persists joined member attribution privately without persisting live presence", () => {
    service.heartbeat("chat-a", "bob-session", { typing: true });
    const snapshot = reopen().snapshot("chat-a", "bob-session");
    expect(snapshot.members.map(member => member.userId)).toEqual(["alice", "bob"]);
    expect(snapshot.presence).toEqual([]);
    const path = join(directory, readdirSync(directory).find(name => name.endsWith(".json"))!);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(snapshot)).not.toContain("bob-session");
  });
  it("aggregates presence by user across browser sessions and resource kind without leaking session credentials", () => {
    service.heartbeat("chat-a", "owner-session", { typing: false });
    service.heartbeat("chat-a", "alice-other-session", { typing: true });
    service.registerRoom("report", "chat-a", "bob-session");
    service.heartbeatRoom("report", "chat-a", "bob-session", { typing: false });
    service.registerRoom("workflow", "workflow-a", "viewer-session");
    service.heartbeatRoom("workflow", "workflow-a", "viewer-session", { typing: false });
    const overview = service.overview("viewer-session");
    expect(overview.rooms.map(room => [room.kind, room.id])).toEqual([["conversation", "chat-a"], ["report", "chat-a"], ["workflow", "workflow-a"]]);
    expect(overview.rooms[0]?.presence).toEqual([{ userId: "alice", displayName: "ALICE", viewing: true, typing: true, updatedAt: 10000 }]);
    expect(overview.rooms[1]?.presence[0]?.userId).toBe("bob");
    expect(JSON.stringify(overview)).not.toContain("owner-session");
    service.heartbeat("chat-a", "alice-other-session", { typing: true, viewing: false });
    expect(service.snapshot("chat-a", "bob-session").presence[0]?.typing).toBe(false);
  });
  it("expires viewing/typing presence, removes logout and never invents active participants", () => {
    service.heartbeat("chat-a", "bob-session", { typing: true });
    identities.delete("bob-session");
    expect(service.overview("viewer-session").rooms).toEqual([]);
    service.heartbeat("chat-a", "owner-session", { typing: true });
    now += 2001;
    expect(service.snapshot("chat-a", "viewer-session").presence).toEqual([]);
    expect(service.overview("viewer-session").rooms).toEqual([]);
  });
  it("tracks tabs sharing one authenticated cookie independently and aggregates their user presence", () => {
    const tabA = "e29cc625-63b4-4517-a7a8-08f3e2ae44f0";
    const tabB = "e29cc625-63b4-4517-a7a8-08f3e2ae44f1";
    service.heartbeat("chat-a", "bob-session", { typing: true, clientId: tabA });
    service.heartbeat("chat-a", "bob-session", { typing: false, clientId: tabB });
    expect(service.snapshot("chat-a", "viewer-session").presence).toEqual([{ userId: "bob", displayName: "BOB", viewing: true, typing: true, updatedAt: now }]);
    service.heartbeat("chat-a", "bob-session", { typing: false, viewing: false, clientId: tabA });
    expect(service.snapshot("chat-a", "viewer-session").presence[0]).toMatchObject({ userId: "bob", typing: false });
    // Legacy clients remain a separate compatible tab slot.
    service.heartbeat("chat-a", "bob-session", { typing: true });
    service.heartbeat("chat-a", "bob-session", { typing: false, viewing: false });
    expect(service.snapshot("chat-a", "viewer-session").presence[0]).toMatchObject({ userId: "bob", typing: false });
    service.heartbeat("chat-a", "bob-session", { typing: true, clientId: tabA });
    now += 2001;
    expect(service.overview("viewer-session").rooms).toEqual([]);
    service.heartbeat("chat-a", "bob-session", { typing: true, clientId: tabA });
    service.heartbeat("chat-a", "bob-session", { typing: true, clientId: tabB });
    identities.delete("bob-session");
    expect(service.snapshot("chat-a", "viewer-session").presence).toEqual([]);
  });
  it("rejects invalid tab IDs and bounds active tabs without blocking existing tab refresh or leave", () => {
    expect(() => service.heartbeat("chat-a", "bob-session", { typing: false, clientId: "owner-session" })).toThrow("Invalid presence update");
    for (let index = 0; index < 512; index++) service.heartbeat("chat-a", "bob-session", { typing: false, clientId: "00000000-0000-4000-8000-" + String(index).padStart(12, "0") });
    const tab = "00000000-0000-4000-8000-000000000000";
    expect(() => service.heartbeat("chat-a", "bob-session", { typing: true, clientId: tab })).not.toThrow();
    expect(() => service.heartbeat("chat-a", "bob-session", { typing: false, clientId: "00000000-0000-4000-8000-999999999999" })).toThrow("active tab limit");
    service.heartbeat("chat-a", "bob-session", { typing: false, viewing: false, clientId: tab });
    expect(() => service.heartbeat("chat-a", "bob-session", { typing: false, clientId: "00000000-0000-4000-8000-999999999999" })).not.toThrow();
  });
  it("migrates prior joined rooms and removes obsolete controller/proposal state", () => {
    const path = join(directory, readdirSync(directory).find(name => name.endsWith(".json"))!);
    const prior = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, workspaceId: prior.workspaceId, conversations: prior.rooms.map((room: Record<string, unknown>) => ({ ...room, lease: { token: "obsolete" }, proposals: [{ text: "obsolete" }] })) }));
    expect(reopen().snapshot("chat-a", "owner-session").members[0]?.userId).toBe("alice");
    service.heartbeat("chat-a", "bob-session", { typing: false });
    const updated = readFileSync(path, "utf8");
    expect(JSON.parse(updated).schemaVersion).toBe(2);
    expect(updated).not.toContain("obsolete");
  });
  it("fails closed on corrupted workspace storage and live locks, recovers dead writer locks", () => {
    const path = join(directory, readdirSync(directory).find(name => name.endsWith(".json"))!);
    writeFileSync(path + ".lock", String(process.pid));
    expect(() => service.heartbeat("chat-a", "owner-session", { typing: false })).toThrow("busy");
    writeFileSync(path + ".lock", "2147483647");
    expect(service.heartbeat("chat-a", "owner-session", { typing: false }).canWrite).toBe(true);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...saved, workspaceId: "foreign-team" }));
    expect(() => service.snapshot("chat-a", "owner-session")).toThrow("Invalid collaboration storage");
    expect(() => service.heartbeat("chat-a", "bob-session", { typing: false })).toThrow("Invalid collaboration storage");
  });
});
