import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecurityWorkflowStore } from "@0/engine/storage";
import { createSecurityWorkflowTemplate } from "@0/engine/shared";
import { WebSentinelService, type SentinelActor } from "./sentinels.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "zero-sentinel-web-"));
  dirs.push(dir);
  const dbPath = join(dir, "control.db");
  let counter = 0;
  const pending = new Map<string, number>();
  const missions = {
    create: vi.fn((_input: Record<string, unknown>) => ({ id: `mission-${++counter}` })),
    send: vi.fn(async (_id: string, _text: string, _author?: { userId: string; displayName: string }) => ({})),
    pendingDecisions: vi.fn((id: string) => pending.get(id) ?? 0),
  };
  const service = new WebSentinelService({ dbPath, missions });
  const workflows = new SecurityWorkflowStore(dbPath);
  const call = async (method: string, path: string, body?: unknown, actor?: SentinelActor) => {
    const url = new URL(`http://localhost${path}`);
    const result = await service.handle(url.pathname, method, body, url.searchParams, actor);
    return result!;
  };
  return { service, missions, pending, workflows, call, dbPath };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const P = "/api/console/sentinels";

describe("sentinel API", () => {
  it("ignores unrelated routes and lists presets", async () => {
    const f = fixture();
    expect(await f.service.handle("/api/console/workflow-definitions", "GET", undefined, new URLSearchParams())).toBeNull();
    const presets = await f.call("GET", "/api/console/sentinel-presets");
    expect(presets.status).toBe(200);
    expect((presets.data as { presets: unknown[] }).presets).toHaveLength(8);
    expect((await f.call("POST", "/api/console/sentinel-presets", {})).status).toBe(405);
  });

  it("creates inert Sentinels, from a preset or from scratch", async () => {
    const f = fixture();
    const created = await f.call("POST", P, { preset: "pen-tester", scope: { targets: ["https://staging.example.com"] } });
    expect(created.status).toBe(201);
    const data = created.data as { sentinel: { id: string; status: string; role: string; autonomy: string; attention: unknown; scope: { production: boolean } }; suggestedAutomations: unknown[] };
    expect(data.sentinel).toMatchObject({ status: "paused", role: "pen-tester", autonomy: "observe", attention: { needsYou: false, pendingDecisions: 0 } });
    expect(data.sentinel.scope.production).toBe(false);
    expect(data.suggestedAutomations.length).toBeGreaterThan(0);
    expect((await f.call("POST", P, { preset: "nope" })).status).toBe(400);
    expect((await f.call("POST", P, { name: "x", triggers: [] })).status).toBe(400);
    expect((await f.call("POST", P, { name: "Blank" })).status).toBe(201);
    expect(((await f.call("GET", P)).data as { sentinels: unknown[] }).sentinels).toHaveLength(2);
    expect((await f.call("GET", `${P}?status=bogus`)).status).toBe(400);
    expect(((await f.call("GET", `${P}?status=active`)).data as { sentinels: unknown[] }).sentinels).toHaveLength(0);
  });

  it("reads, patches with version checks, pauses, resumes and deletes", async () => {
    const f = fixture();
    const { sentinel } = (await f.call("POST", P, { name: "A" })).data as { sentinel: { id: string; version: number } };
    expect((await f.call("GET", `${P}/${sentinel.id}`)).status).toBe(200);
    expect((await f.call("GET", `${P}/missing`)).status).toBe(404);
    const patched = await f.call("PATCH", `${P}/${sentinel.id}`, { version: 1, name: "B" });
    expect(patched.status).toBe(200);
    expect((await f.call("PATCH", `${P}/${sentinel.id}`, { version: 1, name: "C" })).status).toBe(409);
    expect((await f.call("PATCH", `${P}/${sentinel.id}`, { name: "no version" })).status).toBe(400);
    expect((await f.call("POST", `${P}/${sentinel.id}/resume`, { version: 2 })).status).toBe(200);
    expect(((await f.call("POST", `${P}/${sentinel.id}/pause`, {})).data as { sentinel: { status: string } }).sentinel.status).toBe("paused");
    expect((await f.call("DELETE", `${P}/${sentinel.id}`)).status).toBe(409);
    expect((await f.call("DELETE", `${P}/${sentinel.id}?version=1`)).status).toBe(409);
    expect((await f.call("DELETE", `${P}/${sentinel.id}?version=4`)).status).toBe(200);
    expect((await f.call("GET", `${P}/${sentinel.id}`)).status).toBe(404);
  });

  it("runs a seeded mission through the chat session path and records the activation", async () => {
    const f = fixture();
    const { sentinel } = (await f.call("POST", P, { name: "Watcher", skills: ["scoped-fix"], instructions: "Watch deps.", scope: { targets: ["https://a.example"], outOfScope: ["https://a.example/admin"] } })).data as { sentinel: { id: string } };
    expect((await f.call("POST", `${P}/${sentinel.id}/run`, { version: 1 })).status).toBe(400);
    expect((await f.call("POST", `${P}/${sentinel.id}/run`, { approval: "launch-authorized-run", version: 9 })).status).toBe(409);
    const run = await f.call("POST", `${P}/${sentinel.id}/run`, { approval: "launch-authorized-run", version: 1, task: "Check now" });
    expect(run.status).toBe(202);
    expect(f.missions.create).toHaveBeenCalledTimes(2);
    const config = f.missions.create.mock.calls[1]![0];
    expect(config).toMatchObject({ autonomyMode: "standard", target: "https://a.example", workerPolicy: { allowedHttpMethods: ["GET", "HEAD", "OPTIONS"] }, scope: { in_scope: ["https://a.example"], out_of_scope: ["https://a.example/admin"] } });
    const [, text] = f.missions.send.mock.calls[0]!;
    expect(text).toContain("Watch deps.");
    expect(text).toContain("Skills allow-list for this run: scoped-fix");
    expect(text).toContain("Task: Check now");
    const activations = (await f.call("GET", `${P}/${sentinel.id}/activations`)).data as { activations: Array<{ status: string; missionId: string; parentMissionId: string; skills: string[] }> };
    expect(activations.activations[0]).toMatchObject({ status: "running", missionId: "mission-2", parentMissionId: "mission-1", skills: ["scoped-fix"] });
    expect(((await f.call("GET", `${P}/${sentinel.id}`)).data as { sentinel: { homeMissionId: string } }).sentinel.homeMissionId).toBe("mission-1");
    await f.call("POST", `${P}/${sentinel.id}/run`, { approval: "launch-authorized-run", version: 1 });
    expect(f.missions.create).toHaveBeenCalledTimes(3);
  });

  it("marks the activation failed when the mission cannot start, enforces the daily cap and refuses archived Sentinels", async () => {
    const f = fixture();
    const { sentinel } = (await f.call("POST", P, { name: "A", budget: { maxRunsPerDay: 1 } })).data as { sentinel: { id: string } };
    f.missions.send.mockRejectedValueOnce(Object.assign(new Error("No model configured."), { statusCode: 409 }));
    const body = { approval: "launch-authorized-run", version: 1 };
    const failed = await f.call("POST", `${P}/${sentinel.id}/run`, body);
    expect(failed).toMatchObject({ status: 409, data: { error: "No model configured." } });
    expect(((await f.call("GET", `${P}/${sentinel.id}/activations`)).data as { activations: Array<{ status: string }> }).activations[0]!.status).toBe("failed");
    expect((await f.call("POST", `${P}/${sentinel.id}/run`, body)).status).toBe(429);
    const archived = (await f.call("POST", P, { name: "Z", status: "archived" })).data as { sentinel: { id: string } };
    expect((await f.call("POST", `${P}/${archived.sentinel.id}/run`, body)).status).toBe(409);
  });

  it("derives Needs you from pending decisions in the home or running missions", async () => {
    const f = fixture();
    const { sentinel } = (await f.call("POST", P, { name: "A" })).data as { sentinel: { id: string } };
    await f.call("POST", `${P}/${sentinel.id}/run`, { approval: "launch-authorized-run", version: 1 });
    f.pending.set("mission-2", 2);
    const view = (await f.call("GET", `${P}/${sentinel.id}`)).data as { sentinel: { attention: { needsYou: boolean; pendingDecisions: number } } };
    expect(view.sentinel.attention).toEqual({ needsYou: true, needsReview: false, pendingDecisions: 2 });
    f.missions.pendingDecisions.mockImplementation(() => { throw new Error("closed"); });
    expect(((await f.call("GET", `${P}/${sentinel.id}`)).data as { sentinel: { attention: { needsYou: boolean } } }).sentinel.attention.needsYou).toBe(false);
  });

  it("serves virtual files with revisions and conflict checks", async () => {
    const f = fixture();
    const { sentinel } = (await f.call("POST", P, { name: "A" })).data as { sentinel: { id: string } };
    const list = (await f.call("GET", `${P}/${sentinel.id}/files`)).data as { files: Array<{ path: string }>; folders: string[] };
    expect(list.files.map(file => file.path)).toEqual(["AGENTS.md", "CREW.md", "NOTES.md"]);
    expect(list.folders).toEqual(["handoffs/", "reports/"]);
    const created = await f.call("PUT", `${P}/${sentinel.id}/files/reports/2026-01-01.md`, { content: "# Report", revision: null });
    expect(created.status).toBe(201);
    expect((await f.call("PUT", `${P}/${sentinel.id}/files/NOTES.md`, { content: "- note", revision: 1 })).status).toBe(200);
    expect((await f.call("PUT", `${P}/${sentinel.id}/files/NOTES.md`, { content: "stale", revision: 1 })).status).toBe(409);
    const read = (await f.call("GET", `${P}/${sentinel.id}/files/NOTES.md?revisions=1`)).data as { file: { content: string; revision: number }; revisions: unknown[] };
    expect(read.file).toMatchObject({ content: "- note", revision: 2 });
    expect(read.revisions).toHaveLength(2);
    expect((await f.call("PUT", `${P}/${sentinel.id}/files/..%2Fescape.md`, { content: "x", revision: null })).status).toBe(400);
    expect((await f.call("DELETE", `${P}/${sentinel.id}/files/AGENTS.md?revision=1`)).status).toBe(409);
    expect((await f.call("DELETE", `${P}/${sentinel.id}/files/reports/2026-01-01.md`)).status).toBe(409);
    expect((await f.call("DELETE", `${P}/${sentinel.id}/files/reports/2026-01-01.md?revision=1`)).status).toBe(200);
    expect((await f.call("GET", `${P}/${sentinel.id}/files/reports/2026-01-01.md`)).status).toBe(404);
  });

  it("returns owned automations and keeps owner fields on the workflow API", async () => {
    const f = fixture();
    const { sentinel } = (await f.call("POST", P, { name: "A" })).data as { sentinel: { id: string } };
    const owned = f.workflows.save({ ...createSecurityWorkflowTemplate("dependency-review", { target: "." }), ownerSentinelId: sentinel.id, runIn: "sentinel-home" });
    f.workflows.save(createSecurityWorkflowTemplate("dependency-review", { target: "." }));
    const result = (await f.call("GET", `${P}/${sentinel.id}/automations`)).data as { automations: Array<{ id: string; runIn: string }> };
    expect(result.automations.map(automation => automation.id)).toEqual([owned.id]);
    expect(result.automations[0]!.runIn).toBe("sentinel-home");
    expect(() => f.workflows.save({ ...createSecurityWorkflowTemplate("dependency-review", { target: "." }), runIn: "sentinel-home" })).toThrow(/owner/i);
  });

  it("applies team roles: viewers read, editors write, only owners or creators delete", async () => {
    const f = fixture();
    const viewer: SentinelActor = { userId: "v", displayName: "V", role: "viewer" };
    const editor: SentinelActor = { userId: "e", displayName: "E", role: "editor" };
    const other: SentinelActor = { userId: "o", displayName: "O", role: "editor" };
    const admin: SentinelActor = { userId: "a", displayName: "A", role: "owner" };
    expect((await f.call("POST", P, { name: "x" }, viewer)).status).toBe(403);
    const { sentinel } = (await f.call("POST", P, { name: "x" }, editor)).data as { sentinel: { id: string; owner: string } };
    expect(sentinel.owner).toBe("e");
    expect((await f.call("GET", P, undefined, viewer)).status).toBe(200);
    expect((await f.call("PATCH", `${P}/${sentinel.id}`, { version: 1, name: "y" }, viewer)).status).toBe(403);
    expect((await f.call("PUT", `${P}/${sentinel.id}/files/NOTES.md`, { content: "x", revision: 1 }, viewer)).status).toBe(403);
    expect((await f.call("POST", `${P}/${sentinel.id}/run`, { approval: "launch-authorized-run", version: 1 }, viewer)).status).toBe(403);
    expect((await f.call("DELETE", `${P}/${sentinel.id}?version=1`, undefined, other)).status).toBe(403);
    const registered: string[] = [];
    const run = await f.call("POST", `${P}/${sentinel.id}/run`, { approval: "launch-authorized-run", version: 1 }, { ...editor, onMissionCreated: id => registered.push(id) });
    expect(run.status).toBe(202);
    expect(registered).toEqual(["mission-1", "mission-2"]);
    expect(f.missions.send.mock.calls[0]![2]).toEqual({ userId: "e", displayName: "E" });
    expect((await f.call("DELETE", `${P}/${sentinel.id}?version=1`, undefined, admin)).status).toBe(200);
  });
});
