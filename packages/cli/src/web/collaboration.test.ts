import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollaborationService, type CollaborationIdentity } from "./collaboration.js";

let directory: string;
let now: number;
let identities: Map<string, CollaborationIdentity>;
let service: CollaborationService;
const actor = (userId: string, role: CollaborationIdentity["role"] = "editor", workspaceId = "team-a"): CollaborationIdentity => ({ userId, displayName: userId.toUpperCase(), workspaceId, role });
function reopen() { return new CollaborationService({ workspaceId: "team-a", stateDir: directory, resolveSession: session => identities.get(session), now: () => now, leaseMs: 3000, presenceMs: 2000 }); }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "0-collaboration-")); now = 10000;
  identities = new Map([["owner-session", actor("alice", "owner")], ["bob-session", actor("bob")], ["alice-other-session", actor("alice", "owner")], ["viewer-session", actor("reader", "viewer")], ["foreign-session", actor("mallory", "owner", "team-b")]]);
  service = reopen(); service.register("chat-a", "owner-session");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("authenticated workspace collaboration", () => {
  it("requires a real authenticated workspace session for every read and mutation", () => {
    expect(() => service.snapshot("chat-a", "missing")).toThrow("authenticated team session");
    expect(() => service.snapshot("chat-a", "foreign-session")).toThrow("does not belong");
    expect(() => service.heartbeat("chat-a", "bob-session", { typing: true, userId: "alice" })).toThrow("booleans");
    expect(() => service.propose("chat-a", "bob-session", { text: "Inspect", submittedBy: { userId: "alice" } })).toThrow("text only");
    expect(() => service.assertController("chat-a", "missing", "made-up")).toThrow("authenticated");
    expect(() => service.acquireController("chat-a", "foreign-session")).toThrow("does not belong");
  });
  it("allows viewers to join and read but not mutate agent control or propose actions", () => {
    expect(service.heartbeat("chat-a", "viewer-session", { typing: false }).viewer.role).toBe("viewer");
    expect(() => service.acquireController("chat-a", "viewer-session")).toThrow("viewers");
    expect(() => service.propose("chat-a", "viewer-session", { text: "Run command" })).toThrow("viewers");
    const controller = service.acquireController("chat-a", "owner-session");
    expect(() => service.assertController("chat-a", "viewer-session", controller.leaseToken)).toThrow("viewers");
  });
  it("persists attributable membership while deriving current role from authenticated session", () => {
    service.heartbeat("chat-a", "bob-session", { typing: true });
    const snapshot = reopen().snapshot("chat-a", "bob-session");
    expect(snapshot.members.map(member => member.userId)).toEqual(["alice", "bob"]);
    expect(snapshot.members.find(member => member.userId === "bob")?.role).toBe("editor");
    identities.set("bob-session", actor("bob", "viewer"));
    expect(snapshot.viewer.role).toBe("editor");
    expect(service.snapshot("chat-a", "bob-session").viewer.role).toBe("viewer");
    expect(() => service.acquireController("chat-a", "bob-session")).toThrow("viewers");
    const path = join(directory, readdirSync(directory).find(name => name.endsWith(".json"))!);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it("keeps leases exclusive across instances and distinct authenticated sessions of the same user", () => {
    const lease = service.acquireController("chat-a", "owner-session");
    const peer = reopen();
    expect(() => peer.acquireController("chat-a", "bob-session")).toThrow("Another authenticated session");
    expect(() => peer.acquireController("chat-a", "alice-other-session")).toThrow("Another authenticated session");
    expect(peer.snapshot("chat-a", "alice-other-session").canControl).toBe(false);
    expect(() => peer.assertController("chat-a", "alice-other-session", lease.leaseToken)).toThrow("current controller lease");
    expect(peer.assertController("chat-a", "owner-session", lease.leaseToken).userId).toBe("alice");
    expect(JSON.stringify(peer.snapshot("chat-a", "bob-session"))).not.toContain(lease.leaseToken);
    expect(JSON.stringify(peer.snapshot("chat-a", "bob-session"))).not.toContain("owner-session");
  });
  it("expires leases and fences old holders after a takeover", () => {
    const old = service.acquireController("chat-a", "owner-session");
    now += 3001;
    expect(service.snapshot("chat-a", "bob-session").controller).toBeNull();
    const next = service.acquireController("chat-a", "bob-session");
    expect(next.leaseToken).not.toBe(old.leaseToken);
    expect(() => service.assertController("chat-a", "owner-session", old.leaseToken)).toThrow("current controller lease");
    expect(() => service.renewController("chat-a", "owner-session", old.leaseToken)).toThrow("current controller lease");
    expect(() => service.releaseController("chat-a", "owner-session", old.leaseToken)).toThrow("current controller lease");
    expect(service.snapshot("chat-a", "bob-session").canControl).toBe(true);
  });
  it("renews only the holder's lease and ends viewing/typing presence after expiry or logout", () => {
    const lease = service.acquireController("chat-a", "owner-session");
    now += 1000;
    service.heartbeat("chat-a", "bob-session", { typing: true });
    expect(service.snapshot("chat-a", "owner-session").controller?.expiresAt).toBe(13000);
    service.heartbeat("chat-a", "owner-session", { typing: false });
    expect(service.snapshot("chat-a", "owner-session").controller?.expiresAt).toBe(14000);
    expect(service.renewController("chat-a", "owner-session", lease.leaseToken).leaseToken).toBe(lease.leaseToken);
    service.heartbeat("chat-a", "bob-session", { typing: true, viewing: false });
    expect(service.snapshot("chat-a", "owner-session").presence.find(item => item.userId === "bob")?.typing).toBe(false);
    identities.delete("bob-session");
    expect(service.snapshot("chat-a", "owner-session").presence.map(item => item.userId)).toEqual(["alice"]);
    now += 2001;
    expect(service.snapshot("chat-a", "owner-session").presence).toEqual([]);
    identities.delete("owner-session");
    expect(() => service.assertController("chat-a", "owner-session", lease.leaseToken)).toThrow("authenticated");
  });
  it("attributes proposals to server identity and prevents non-controller resolution", () => {
    const proposal = service.propose("chat-a", "bob-session", { text: " Inspect the finding " });
    expect(proposal).toMatchObject({ text: "Inspect the finding", submittedBy: { userId: "bob", displayName: "BOB" }, status: "pending" });
    const lease = service.acquireController("chat-a", "owner-session");
    expect(() => service.rejectProposal("chat-a", "bob-session", proposal.id, lease.leaseToken)).toThrow("current controller lease");
    expect(service.rejectProposal("chat-a", "owner-session", proposal.id, lease.leaseToken)).toMatchObject({ status: "rejected", resolvedBy: { userId: "alice" } });
    expect(() => service.rejectProposal("chat-a", "owner-session", proposal.id, lease.leaseToken)).toThrow("already been");
    service.register("chat-b", "owner-session");
    const second = service.acquireController("chat-b", "owner-session");
    expect(() => service.rejectProposal("chat-b", "owner-session", proposal.id, second.leaseToken)).toThrow("not found");
  });
  it("admits a proposal exactly once while another accept races with dispatch", async () => {
    const proposal = service.propose("chat-a", "bob-session", { text: "Inspect evidence" });
    const lease = service.acquireController("chat-a", "owner-session");
    let finish!: () => void;
    const dispatch = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = service.acceptProposal("chat-a", "owner-session", proposal.id, lease.leaseToken, dispatch);
    expect(dispatch).toHaveBeenCalledWith("Inspect evidence", { userId: "bob", displayName: "BOB" }, proposal.id);
    expect(reopen().snapshot("chat-a", "owner-session").proposals[0]?.status).toBe("dispatching");
    await expect(reopen().acceptProposal("chat-a", "owner-session", proposal.id, lease.leaseToken, dispatch)).rejects.toThrow("already been");
    finish();
    expect(await first).toMatchObject({ status: "accepted", resolvedBy: { userId: "alice" } });
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(service.acceptProposal("chat-a", "owner-session", proposal.id, lease.leaseToken, dispatch)).rejects.toThrow("already been");
  });
  it("never retries an uncertain failed dispatch or replays a crash-interrupted dispatch", async () => {
    const proposal = service.propose("chat-a", "bob-session", { text: "Inspect evidence" });
    const lease = service.acquireController("chat-a", "owner-session");
    const dispatch = vi.fn(() => { throw new Error("SECRET provider error"); });
    const result = await service.acceptProposal("chat-a", "owner-session", proposal.id, lease.leaseToken, dispatch);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("may have applied");
    expect(result.error).not.toContain("SECRET");
    await expect(reopen().acceptProposal("chat-a", "owner-session", proposal.id, lease.leaseToken, dispatch)).rejects.toThrow("already been");
    const pending = service.propose("chat-a", "bob-session", { text: "Separate action" });
    void service.acceptProposal("chat-a", "owner-session", pending.id, lease.leaseToken, () => new Promise(() => {}));
    expect(reopen().snapshot("chat-a", "owner-session").proposals.find(item => item.id === pending.id)?.status).toBe("dispatching");
    await expect(reopen().acceptProposal("chat-a", "owner-session", pending.id, lease.leaseToken, dispatch)).rejects.toThrow("already been");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("requires owner permission for legacy sharing and refuses corrupted persisted attribution", () => {
    expect(() => service.importConversation("private-chat", "bob-session")).toThrow("workspace owner");
    expect(service.importConversation("private-chat", "owner-session").conversationId).toBe("private-chat");
    const path = join(directory, readdirSync(directory).find(name => name.endsWith(".json"))!);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...saved, workspaceId: "foreign-team" }));
    expect(() => service.snapshot("chat-a", "owner-session")).toThrow("Invalid collaboration storage");
    expect(() => service.propose("chat-a", "bob-session", { text: "Do not overwrite" })).toThrow("Invalid collaboration storage");
  });
  it("fails closed while another writer is alive and recovers a dead writer lock", () => {
    const path = join(directory, readdirSync(directory).find(name => name.endsWith(".json"))!);
    writeFileSync(path + ".lock", String(process.pid));
    expect(() => service.acquireController("chat-a", "owner-session")).toThrow("busy");
    writeFileSync(path + ".lock", "2147483647");
    expect(service.acquireController("chat-a", "owner-session").snapshot.canControl).toBe(true);
    expect(readdirSync(directory).some(name => name.endsWith(".lock") || name.endsWith(".recovery"))).toBe(false);
  });
});
