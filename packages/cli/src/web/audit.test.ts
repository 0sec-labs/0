import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { closeAuditLog, listAudit } from "@0/engine/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { audit, auditActor, auditConsoleRequest, auditDenial, configureAudit, describeConsoleAudit, handleAuditLogRequest } from "./audit.js";

let dir = ""; let dbPath = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "zero-audit-web-")); dbPath = join(dir, "audit.db"); configureAudit(dbPath); });
afterEach(() => { configureAudit(null); closeAuditLog(); rmSync(dir, { recursive: true, force: true }); });
const events = () => listAudit({}, { dbPath }).events;
const finish = (status: number) => { const res = Object.assign(new EventEmitter(), { statusCode: status }) as unknown as ServerResponse; return { res, done: () => res.emit("finish") }; };

describe("console audit wiring", () => {
  it("records MCP create with a fingerprint hash and env names but no values", () => {
    const { res, done } = finish(201);
    const secret = "sk-supersecretvalue1234567890";
    auditConsoleRequest(res, "mcp-servers", "POST", { config: { name: "files", transport: "stdio", command: "npx", args: ["-y", "srv"], env: { API_KEY: secret, MODE: "x" } }, enable: true }, { engineRequest: false });
    done();
    const [event] = events();
    expect(event).toMatchObject({ actor: "operator (browser)", action: "mcp.create", subject: "files", outcome: "ok" });
    expect(event!.detail).toMatchObject({ name: "files", transport: "stdio", envKeys: ["API_KEY", "MODE"], enabled: true });
    expect(String(event!.detail.fingerprint)).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(event)).not.toContain(secret);
  });
  it("records settings changes with key and values but masks secret-named keys", () => {
    expect(describeConsoleAudit("settings", "PATCH", { key: "theme", value: "dark" })).toMatchObject({ action: "settings.change", subject: "theme", detail: { key: "theme", new: "dark" } });
    const { res, done } = finish(200);
    auditConsoleRequest(res, "settings", "PATCH", { key: "providerApiKey", value: "hunter2hunter2" }, { engineRequest: false }); done();
    expect(JSON.stringify(events())).not.toContain("hunter2");
  });
  it("records approve/deny decisions, denials and skips failed validation", () => {
    for (const approve of [true, false]) { const { res, done } = finish(200); auditConsoleRequest(res, "sessions/s1/decisions/d1", "POST", { approve }, { engineRequest: false }); done(); }
    expect(events().map(e => e.action)).toEqual(["decision.denied", "decision.approved"]);
    const bad = finish(400); auditConsoleRequest(bad.res, "mcp-servers", "POST", {}, { engineRequest: false }); bad.done();
    const denied = finish(403); auditConsoleRequest(denied.res, "sentinels/a/run", "POST", {}, { engineRequest: false }); denied.done();
    expect(events()[0]).toMatchObject({ action: "sentinel.run", outcome: "denied" });
    expect(events()).toHaveLength(3);
  });
  it("does not log reads and attributes the engine bearer", () => {
    expect(describeConsoleAudit("settings", "GET", undefined)).toBeNull();
    expect(auditActor({ engineRequest: true })).toBe("engine");
    expect(auditActor({ engineRequest: false, teamEnabled: true, displayName: "Ada" })).toBe("operator Ada (browser)");
    auditDenial({ method: "POST" }, "/api/console/mcp-servers", "browser_only", "engine");
    expect(events()[0]).toMatchObject({ actor: "engine", action: "access.browser_only", outcome: "denied", detail: { callerKind: "engine", route: "/api/console/mcp-servers", method: "POST" } });
  });
  it("writes nothing until configured", () => {
    configureAudit(null); audit({ actor: "system", action: "x" });
    expect(events()).toHaveLength(0);
  });
});

describe("GET audit-log", () => {
  it("pages, filters, and restricts team mode to owners", () => {
    for (let i = 0; i < 3; i++) audit({ actor: "system", action: i === 1 ? "mcp.delete" : "a", subject: `s${i}` });
    const solo = { teamEnabled: false };
    const page = handleAuditLogRequest("audit-log", "GET", new URLSearchParams("limit=2"), solo)!;
    expect((page.data as { events: unknown[]; nextBefore: number }).events).toHaveLength(2);
    expect((handleAuditLogRequest("audit-log", "GET", new URLSearchParams("q=mcp"), solo)!.data as { events: unknown[] }).events).toHaveLength(1);
    expect(handleAuditLogRequest("audit-log", "GET", new URLSearchParams(), { teamEnabled: true, role: "member" })).toMatchObject({ status: 403, data: { code: "owner_required" } });
    expect(handleAuditLogRequest("audit-log", "GET", new URLSearchParams(), { teamEnabled: true })).toMatchObject({ status: 403 });
    expect(handleAuditLogRequest("audit-log", "GET", new URLSearchParams(), { teamEnabled: true, role: "owner" })!.status).toBe(200);
    expect(handleAuditLogRequest("audit-log", "POST", new URLSearchParams(), solo)!.status).toBe(405);
    expect(handleAuditLogRequest("other", "GET", new URLSearchParams(), solo)).toBeNull();
  });
});
