import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addAuditSink, closeAuditLog, listAudit, recordAudit, redactAuditDetail, type AuditSinkEvent } from "./audit-log.js";

const dirs: string[] = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "zero-audit-")); dirs.push(dir); return { dbPath: join(dir, "audit.db") }; };
afterEach(() => { closeAuditLog(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("recordAudit", () => {
  it("stores whitelisted detail only and strips secrets", () => {
    const target = fresh();
    recordAudit({ actor: "operator (browser)", action: "settings.change", subject: "theme", detail: {
      key: "theme", old: "dark", new: "light", apiKey: "sk-abcdefghijklmnopqrstuvwx", env: { A: "b" },
      reason: "token=abcd1234 and Bearer abcdefghijklmnop and ghp_abcdefghijklmnopqrstuv", id: "x".repeat(500),
    } }, target);
    const [event] = listAudit({}, target).events;
    expect(event!.detail).toMatchObject({ key: "theme", old: "dark", new: "light" });
    expect(event!.detail).not.toHaveProperty("apiKey");
    expect(event!.detail).not.toHaveProperty("env");
    expect(JSON.stringify(event)).not.toMatch(/sk-abc|abcd1234|ghp_|abcdefghijklmnop/);
    expect(String(event!.detail.id).length).toBeLessThanOrEqual(200);
  });
  it("masks old/new when the setting key itself is secret-named", () => {
    expect(redactAuditDetail({ key: "providerApiKey", old: "plain1", new: "plain2" })).toEqual({ key: "providerApiKey", old: "[redacted]", new: "[redacted]" });
  });
  it("keeps boolean old/new values of token-named keys, which carry no secret", () => {
    expect(redactAuditDetail({ key: "showTokenUsage", old: false, new: true })).toEqual({ key: "showTokenUsage", old: false, new: true });
  });
  it("keeps only the newest rows past the cap", () => {
    const target = { ...fresh(), maxRows: 5 };
    for (let i = 0; i < 12; i++) recordAudit({ actor: "system", action: `a.${i}` }, target);
    const events = listAudit({ limit: 100 }, target).events;
    expect(events.length).toBeLessThanOrEqual(5 + 4);
    expect(events[0]!.action).toBe("a.11");
    expect(events.length).toBeLessThan(12);
  });
  it("never throws and is append-only", () => {
    expect(() => recordAudit({ actor: "system", action: "x" }, { dbPath: "/dev/null/nope/audit.db" })).not.toThrow();
    expect(listAudit({}, { dbPath: "/dev/null/nope/audit.db" })).toEqual({ events: [], nextBefore: null });
    const target = fresh();
    expect(() => recordAudit({ actor: undefined as unknown as string, action: undefined as unknown as string, detail: 5 as never }, target)).not.toThrow();
    recordAudit({ actor: "system", action: "kept" }, target);
    expect(listAudit({}, target).events.map(e => e.action)).toContain("kept");
  });
  it("pages newest first and filters by action, subject or actor", () => {
    const target = fresh();
    for (let i = 0; i < 5; i++) recordAudit({ actor: i === 2 ? "engine" : "system", action: "a", subject: `s${i}` }, target);
    const first = listAudit({ limit: 2 }, target);
    expect(first.events.map(e => e.subject)).toEqual(["s4", "s3"]);
    expect(listAudit({ limit: 2, before: first.nextBefore! }, target).events.map(e => e.subject)).toEqual(["s2", "s1"]);
    expect(listAudit({ q: "s3" }, target).events).toHaveLength(1);
    expect(listAudit({ q: "engine" }, target).events).toHaveLength(1);
    expect(listAudit({ q: "%" }, target).events).toHaveLength(0);
  });
});

describe("audit sinks", () => {
  it("receive each stored event after redaction, matching the local log", () => {
    const target = fresh(); const seen: AuditSinkEvent[] = [];
    const remove = addAuditSink(event => { seen.push(event); });
    recordAudit({ actor: "alex", action: "settings.change", subject: "theme", detail: { key: "theme", new: "light", apiKey: "sk-abcdefghijklmnopqrstuvwx" } }, target);
    remove();
    expect(seen).toHaveLength(1);
    const [stored] = listAudit({}, target).events;
    expect(seen[0]).toEqual({ ts: stored!.ts, actor: "alex", action: "settings.change", subject: "theme", outcome: "ok", detail: stored!.detail });
    expect(JSON.stringify(seen[0])).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });
  it("never break auditing, and removal stops delivery", () => {
    const target = fresh(); const seen: string[] = [];
    const removeBad = addAuditSink(() => { throw new Error("sink down"); });
    const removeGood = addAuditSink(event => { seen.push(event.action); });
    expect(() => recordAudit({ actor: "a", action: "one" }, target)).not.toThrow();
    removeGood(); recordAudit({ actor: "a", action: "two" }, target); removeBad();
    expect(seen).toEqual(["one"]);
    expect(listAudit({}, target).events.map(event => event.action)).toEqual(["two", "one"]);
  });
  it("cannot alter the stored event by mutating what they receive", () => {
    const target = fresh();
    const remove = addAuditSink(event => { event.detail["key"] = "tampered"; });
    recordAudit({ actor: "a", action: "x", detail: { key: "theme" } }, target); remove();
    expect(listAudit({}, target).events[0]!.detail).toEqual({ key: "theme" });
  });
});
