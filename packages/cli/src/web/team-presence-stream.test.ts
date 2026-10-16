import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamAuth, hashTeamPassword, getSessionId } from "./team-auth.js";
import { CollaborationService } from "./collaboration.js";
import { handleTeamPresenceStream } from "./team-presence-stream.js";

class Response extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  writes: string[] = [];
  writableEnded = false;
  destroyed = false;
  backpressured = false;
  writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; return this; }
  flushHeaders() {}
  write(body: string) { this.writes.push(body); return !this.backpressured; }
  end() { this.writableEnded = true; this.emit("close"); }
}
let hash: string, directory: string, auth: TeamAuth, service: CollaborationService, ownerCookie: string, viewerCookie: string;
function request(cookie?: string): IncomingMessage {
  return Object.assign(new EventEmitter(), { method: "GET", headers: cookie ? { cookie } : {}, socket: new EventEmitter() }) as IncomingMessage;
}
function open(cookie = viewerCookie, response = new Response()) {
  const req = request(cookie);
  expect(handleTeamPresenceStream(req, response as unknown as ServerResponse, new URL("http://127.0.0.1:48123/api/team/events"), auth, service)).toBe(true);
  return { req, response };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeAll(async () => { hash = await hashTeamPassword("test-stream-password"); });
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "0-team-stream-"));
  auth = new TeamAuth({ origin: "http://127.0.0.1:48123", now: () => Date.now(), config: { workspace: { id: "team-a", name: "Team" }, users: [
    { id: "owner", name: "Alice", role: "owner", passwordHash: hash }, { id: "viewer", name: "Bob", role: "viewer", passwordHash: hash },
  ] } });
  ownerCookie = (await auth.login({ userId: "owner", password: "test-stream-password" }, "owner")).setCookie.split(";")[0]!;
  viewerCookie = (await auth.login({ userId: "viewer", password: "test-stream-password" }, "viewer")).setCookie.split(";")[0]!;
  service = new CollaborationService({ workspaceId: "team-a", stateDir: directory, resolveSession: id => auth.resolveSessionId(id) });
  service.register("chat-a", getSessionId(request(ownerCookie))!);
});
afterEach(() => { vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });

describe("authenticated presence push stream", () => {
  it("rejects missing authentication before opening headers and ignores other routes", () => {
    const res = new Response();
    expect(() => handleTeamPresenceStream(request(), res as unknown as ServerResponse, new URL("http://localhost/api/team/events"), auth, service)).toThrow("Sign in");
    expect(res.status).toBe(0);
    expect(handleTeamPresenceStream(request(), res as unknown as ServerResponse, new URL("http://localhost/api/team/presence"), auth, service)).toBe(false);
  });
  it("pushes an initial overview and actual joins, typing changes and leave without polling", async () => {
    const { response } = open();
    expect(response.status).toBe(200);
    expect(response.headers["Content-Type"]).toContain("text/event-stream");
    expect(response.writes[0]).toContain('event: presence\ndata: {"workspaceId":"team-a"');
    service.heartbeat("chat-a", getSessionId(request(ownerCookie))!, { typing: false });
    await tick();
    expect(response.writes.at(-1)).toContain('"displayName":"Alice"');
    const beforeRefresh = response.writes.length;
    service.heartbeat("chat-a", getSessionId(request(ownerCookie))!, { typing: false });
    await tick();
    expect(response.writes).toHaveLength(beforeRefresh);
    service.heartbeat("chat-a", getSessionId(request(ownerCookie))!, { typing: true });
    await tick(); expect(response.writes.at(-1)).toContain('"typing":true');
    service.heartbeat("chat-a", getSessionId(request(ownerCookie))!, { typing: false, viewing: false });
    await tick(); expect(response.writes.at(-1)).toContain('"rooms":[]');
    response.end();
  });
  it("coalesces slow readers to the latest overview and bounded changed invalidations", async () => {
    const response = new Response(); response.backpressured = true;
    open(viewerCookie, response);
    const session = getSessionId(request(ownerCookie))!;
    for (let index = 0; index < 45; index++) {
      service.heartbeat("chat-a", session, { typing: index % 2 === 0 });
      service.notifyChanged("report", "report-" + index);
      await tick();
    }
    expect(response.writes).toHaveLength(1);
    response.backpressured = false; response.emit("drain");
    expect(response.writes).toHaveLength(3);
    expect(response.writes[1]).toContain('"typing":true');
    expect(response.writes[2]).toBe('event: changed\ndata: {"all":true}\n\n');
    response.end();
  });
  it("sends targeted resource invalidations and revalidates identity before every event", () => {
    const { response } = open();
    service.notifyChanged("workflow", "workflow-a");
    expect(response.writes.at(-1)).toBe('event: changed\ndata: {"kind":"workflow","id":"workflow-a"}\n\n');
    auth.logout(request(viewerCookie));
    service.notifyChanged("report", "report-a");
    expect(response.writableEnded).toBe(true);
    expect(response.writes.at(-1)).not.toContain("report-a");
  });
  it("closes expired or logged-out streams on keepalive and removes timers/listeners on abort", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { req, response } = open();
    const count = response.writes.length;
    vi.advanceTimersByTime(10000);
    expect(response.writes).toHaveLength(count + 1);
    auth.logout(req);
    vi.advanceTimersByTime(10000);
    expect(response.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const second = open(ownerCookie);
    second.req.emit("aborted");
    expect(vi.getTimerCount()).toBe(0);
    expect(second.req.listenerCount("aborted")).toBe(0);
    expect(second.response.listenerCount("drain")).toBe(0);
    const previousWrites = second.response.writes.length;
    service.notifyChanged("report", "r");
    await tick();
    expect(second.response.writes).toHaveLength(previousWrites);
  });
  it("expires idle room presence through its live subscription and closes expired auth sessions", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { response } = open();
    service.heartbeat("chat-a", getSessionId(request(ownerCookie))!, { typing: true });
    await tick();
    vi.advanceTimersByTime(21000); await tick();
    expect(response.writes.at(-1)).toContain('"rooms":[]');
    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000);
    vi.advanceTimersByTime(10000);
    expect(response.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
