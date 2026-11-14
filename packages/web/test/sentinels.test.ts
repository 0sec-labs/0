import { describe, expect, test } from "vitest";
import { createSentinelClient } from "../src/sentinels/api";
import {
  SentinelApiError, avatarInitials, fieldsFromForm, formFromPreset, formFromSentinel, isConflict, orderSentinels, parseLines, parseView, presentStatus, sentinelHref,
  type Sentinel, type SentinelPreset,
} from "../src/sentinels/model";
import { v } from "../src/lib/vocabulary";

const base = { id: "s1", name: "Pen Tester", mission: "m", avatar: { color: "#ef4444", emoji: "T" }, role: "pen-tester", skills: [], scope: { repos: [], targets: [], domains: [], outOfScope: [], production: false }, autonomy: "observe", toolAccess: "read-web", budget: { perRunUsd: 2, dailyUsd: 10, perRunTimeCapMs: 900_000, dailyTimeCapMs: 7_200_000, maxRunsPerDay: 20 }, notifications: { channels: ["in-app"], on: [], quiet: false }, memory: { enabled: true, autoLearn: false }, crew: { maxConcurrent: 4, maxDepth: 2, crewHost: null }, status: "paused", automationIds: [], homeMissionId: null, owner: "local", version: 3, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" } as Sentinel;
const make = (patch: Partial<Sentinel>): Sentinel => ({ ...base, ...patch });
const preset = { id: "pen-tester", name: "Pen Tester", avatar: { color: "#ef4444", emoji: "T" }, job: "Run tests.", autonomy: "observe", requiredInputs: [], expectedOutputs: [], feasibility: "live", feasibilityNote: "", sentinel: { skills: [], toolAccess: "read-web", instructions: "" }, suggestedAutomations: [] } as SentinelPreset;

describe("form model", () => {
  test("preset defaults are inert", () => {
    const form = formFromPreset(preset);
    expect(form).toMatchObject({ name: "Pen Tester", autonomy: "observe", toolAccess: "read-web", production: false, repos: "", targets: "" });
    const parsed = fieldsFromForm(form);
    expect(parsed.ok && parsed.fields.scope).toEqual({ repos: [], targets: [], domains: [], outOfScope: [], production: false });
    expect(parsed.ok && parsed.fields.budget).toMatchObject({ perRunUsd: 2, dailyUsd: 10, maxRunsPerDay: 20 });
  });
  test("blank form needs a name and a sane budget", () => {
    expect(fieldsFromForm(formFromPreset(undefined))).toEqual({ ok: false, error: "Give the Sentinel a name." });
    const form = { ...formFromPreset(preset), perRunUsd: "20", dailyUsd: "5" };
    expect(fieldsFromForm(form)).toEqual({ ok: false, error: "The per-run budget cannot exceed the daily budget." });
    expect(fieldsFromForm({ ...formFromPreset(preset), maxRunsPerDay: "1.5" }).ok).toBe(false);
    expect(fieldsFromForm({ ...formFromPreset(preset), mission: "x".repeat(161) }).ok).toBe(false);
  });
  test("scope lines split into repos, targets and domains and de-duplicate", () => {
    expect(parseLines("a\n b ,a\n\n")).toEqual(["a", "b"]);
    const parsed = fieldsFromForm({ ...formFromPreset(preset), repos: "org/app", targets: "https://x.test/app\nexample.com\nexample.com", outOfScope: "admin.example.com" });
    expect(parsed.ok && parsed.fields.scope).toEqual({ repos: ["org/app"], targets: ["https://x.test/app"], domains: ["example.com"], outOfScope: ["admin.example.com"], production: false });
  });
  test("editing keeps the stored daily time cap when it is larger", () => {
    const parsed = fieldsFromForm(formFromSentinel(make({})), make({}));
    expect(parsed.ok && parsed.fields.budget.dailyTimeCapMs).toBe(7_200_000);
  });
});

describe("presentation", () => {
  test("status, ordering and avatar", () => {
    expect(presentStatus(make({ status: "active" })).label).toBe("Active");
    expect(presentStatus(make({ status: "active", attention: { needsYou: true, pendingDecisions: 1 } })).needsYou).toBe(true);
    expect(presentStatus(make({ status: "archived", attention: { needsYou: true, pendingDecisions: 1 } })).label).toBe("Archived");
    const rows = orderSentinels([make({ id: "a", name: "Paused", status: "paused" }), make({ id: "b", name: "Live", status: "active" }), make({ id: "c", name: "Ask", status: "active", attention: { needsYou: true, pendingDecisions: 2 } }), make({ id: "d", status: "archived" })]);
    expect(rows.map(row => row.id)).toEqual(["c", "b", "a"]);
    expect(avatarInitials(make({ avatar: { color: "#000000" }, name: "Secrets Hunter" }))).toBe("SH");
    expect(avatarInitials(make({}))).toBe("T");
  });
  test("routes and vocabulary", () => {
    expect(sentinelHref("a b")).toBe("/sentinels/a%20b");
    expect(sentinelHref("x", "files")).toBe("/sentinels/x?view=files");
    expect(parseView("bogus")).toBe("overview");
    expect(parseView("settings")).toBe("settings");
    expect(v("Create {a sentinel}")).toBe("Create a sentinel");
  });
});

function fake(handler: (path: string, init?: RequestInit) => { status: number; body?: unknown; type?: string }) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = createSentinelClient(async (path, init) => {
    calls.push({ path, init });
    const { status, body, type = "application/json" } = handler(path, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body ?? {}), { status, headers: { "content-type": type } });
  });
  return { client, calls };
}

describe("client", () => {
  test("old servers hide the feature instead of erroring", async () => {
    for (const status of [404, 405]) expect((await fake(() => ({ status, body: { error: "Not found" } })).client.list())).toEqual({ supported: false, sentinels: [] });
    expect(await fake(() => ({ status: 200, body: "<html></html>", type: "text/html" })).client.list()).toEqual({ supported: false, sentinels: [] });
    expect(await fake(() => ({ status: 200, body: { sentinels: [base] } })).client.list()).toMatchObject({ supported: true, sentinels: [{ id: "s1" }] });
    await expect(fake(() => ({ status: 500, body: { error: "boom" } })).client.list()).rejects.toThrow("boom");
  });
  test("run sends the approval literal and the reviewed version", async () => {
    const { client, calls } = fake(() => ({ status: 202, body: { activation: {}, sentinel: base } }));
    await client.run("s1", 3, "  scan it ");
    expect(calls[0]!.path).toBe("/api/console/sentinels/s1/run");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ approval: "launch-authorized-run", version: 3, task: "scan it" });
    await client.run("s1", 4, "  ");
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ approval: "launch-authorized-run", version: 4 });
  });
  test("file saves carry the revision and surface conflicts", async () => {
    const { client, calls } = fake(() => ({ status: 409, body: { error: "File changed. Reload before saving." } }));
    const error = await client.saveFile("s1", "reports/a b.md", "x", 2).catch(cause => cause);
    expect(isConflict(error)).toBe(true);
    expect(calls[0]!.path).toBe("/api/console/sentinels/s1/files/reports/a%20b.md");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ content: "x", revision: 2 });
    expect(isConflict(new SentinelApiError("x", 500))).toBe(false);
  });
  test("pause, update and delete pin the version", async () => {
    const { client, calls } = fake(() => ({ status: 200, body: { sentinel: base, ok: true } }));
    await client.setPaused("s1", false, 3); await client.update("s1", 3, { name: "n" }); await client.remove("s1", 3);
    expect(calls.map(call => [call.init?.method, call.path])).toEqual([["POST", "/api/console/sentinels/s1/resume"], ["PATCH", "/api/console/sentinels/s1"], ["DELETE", "/api/console/sentinels/s1?version=3"]]);
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ version: 3, name: "n" });
  });
});
