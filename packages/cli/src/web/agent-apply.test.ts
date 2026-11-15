import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SENTINEL_PRESETS, createSecurityWorkflowTemplate, parseAgentFile } from "@0/engine/shared";
import { SecurityWorkflowStore, SentinelStore } from "@0/engine/storage";
import { loadAgentDocuments } from "../agent-files.js";
import { AgentFileApplier, presetAgentFile, type AgentApplyRequest, type AgentDocument } from "./agent-apply.js";
import { WebSentinelService } from "./sentinels.js";

const dirs: string[] = [];
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), "zero-agents-as-code-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const file = (extra = "", body = "## Role\nReview pull requests.\n", id = "reviewer") => `---\napiVersion: 0security/v1\nid: ${id}\nname: Reviewer\ndescription: Reviews PRs\nskills: [pr-diff-review]\nscope:\n  repos: [acme/app]\n${extra}---\n\n${body}`;
const SCHEDULE = "triggers:\n  - on: schedule\n    frequency: weekly\n    weekday: 1\n    time: '09:00'\n    timezone: Europe/Zurich\n  - on: github-pr\n    repo: acme/app\n    commentOnPr: true\n";
const doc = (path: string, content: string): AgentDocument => ({ path, content });

function fixture() {
  const dir = tmp();
  const dbPath = join(dir, "control.db");
  const store = new SentinelStore(dbPath);
  const workflows = new SecurityWorkflowStore(dbPath);
  const applier = new AgentFileApplier(store, workflows);
  const request = (documents: AgentDocument[], extra: Partial<AgentApplyRequest> = {}): AgentApplyRequest => ({ documents, root: "/repo/agents", ...extra });
  return { dir, dbPath, store, workflows, applier, request };
}

describe("apply", () => {
  it("creates an Agent paused, with its charter, scope, marker and its triggers", () => {
    const f = fixture();
    const result = f.applier.apply(f.request([doc("reviewer.md", file(SCHEDULE))]));
    expect(result.ok).toBe(true);
    expect(result.counts).toMatchObject({ create: 1 });
    const [agent] = f.store.list();
    expect(agent).toMatchObject({ name: "Reviewer", mission: "Reviews PRs", status: "paused", autonomy: "observe", toolAccess: "read-only", skills: ["pr-diff-review"] });
    expect(agent!.scope).toMatchObject({ repos: ["acme/app"], production: false });
    expect(agent!.managedBy).toMatchObject({ id: "reviewer", path: "reviewer.md", root: "/repo/agents" });
    expect(f.store.getFile(agent!.id, "AGENTS.md")!.content).toBe("## Role\nReview pull requests.\n");
    const triggers = f.store.listTriggers(agent!.id);
    expect(triggers.map(trigger => trigger.kind).sort()).toEqual(["github-pr", "schedule"]);
    expect(triggers.every(trigger => trigger.enabled)).toBe(true);
    expect(f.workflows.list().filter(workflow => workflow.ownerSentinelId === agent!.id)).toHaveLength(2);
  });

  it("is idempotent: a second apply changes nothing, including ids, versions and trigger schedules", () => {
    const f = fixture();
    const content = file(`status: active\n${SCHEDULE}`);
    f.applier.apply(f.request([doc("reviewer.md", content)]));
    const before = { agents: f.store.list(), triggers: f.store.listTriggers(), workflows: f.workflows.list() };
    const second = f.applier.apply(f.request([doc("reviewer.md", content)]));
    expect(second.counts).toMatchObject({ unchanged: 1, create: 0, update: 0 });
    expect(f.store.list()).toEqual(before.agents);
    expect(f.store.listTriggers()).toEqual(before.triggers);
    expect(f.workflows.list()).toEqual(before.workflows);
    expect(f.applier.plan(f.request([doc("reviewer.md", content)])).items[0]!.action).toBe("unchanged");
  });

  it("active files enable triggers and acknowledge the review gate; paused files do not", () => {
    const f = fixture();
    f.applier.apply(f.request([doc("a.md", file(`status: active\n${SCHEDULE}`))]));
    const [agent] = f.store.list();
    expect(agent!.status).toBe("active");
    expect(agent!.reviewedFingerprint).toBeTruthy();
    expect(f.store.listTriggers(agent!.id).every(trigger => trigger.enabled)).toBe(true);
    f.applier.apply(f.request([doc("a.md", file(SCHEDULE.replace(/(    timezone: Europe\/Zurich\n)/, "$1    enabled: false\n")))]));
    expect(f.store.get(agent!.id)!.status).toBe("paused");
    expect(f.store.listTriggers(agent!.id).filter(trigger => trigger.enabled).map(trigger => trigger.kind)).toEqual(["github-pr"]);
  });

  it("updates changed fields, keeps the instance id, and reports what changed", () => {
    const f = fixture();
    f.applier.apply(f.request([doc("reviewer.md", file())]));
    const id = f.store.list()[0]!.id;
    const changed = file("access: changes\nbudget:\n  dailyUsd: 3\n", "New charter.\n").replace("name: Reviewer", "name: Renamed");
    expect(f.applier.apply(f.request([doc("reviewer.md", changed)])).items[0]).toMatchObject({ action: "error" });
    const plan = f.applier.plan(f.request([doc("reviewer.md", changed)], { allowChanges: true }));
    expect(plan.items[0]).toMatchObject({ action: "update", agentId: id });
    expect(plan.items[0]!.changes).toEqual(expect.arrayContaining(["name", "access", "budget", "charter"]));
    expect(f.store.get(id)!.name).toBe("Reviewer");
    f.applier.apply(f.request([doc("reviewer.md", changed)], { allowChanges: true }));
    const agent = f.store.get(id)!;
    expect(agent).toMatchObject({ name: "Renamed", autonomy: "act", budget: { dailyUsd: 3 } });
    expect(f.store.list()).toHaveLength(1);
    expect(f.store.getFile(id, "AGENTS.md")).toMatchObject({ content: "New charter.\n", revision: 3, author: "file:reviewer.md" });
  });

  it("detects drift made in the app and puts the file back", () => {
    const f = fixture();
    const content = file();
    f.applier.apply(f.request([doc("reviewer.md", content)]));
    const agent = f.store.list()[0]!;
    f.store.update(agent.id, { version: agent.version, name: "Edited in the app" });
    const plan = f.applier.plan(f.request([doc("reviewer.md", content)]));
    expect(plan.items[0]).toMatchObject({ action: "error", drift: true, changes: ["name"], details: [{ field: "name", instance: "Edited in the app", file: "Reviewer" }] });
    expect(f.applier.apply(f.request([doc("reviewer.md", content)])).ok).toBe(false);
    expect(f.store.get(agent.id)!.name).toBe("Edited in the app");
    f.applier.apply(f.request([doc("reviewer.md", content)], { force: true }));
    expect(f.store.get(agent.id)!.name).toBe("Reviewer");
    expect(f.store.get(agent.id)!.managedBy).toBeDefined();
  });

  it("changes in triggers: add, edit, remove", () => {
    const f = fixture();
    f.applier.apply(f.request([doc("r.md", file(SCHEDULE))]));
    const agent = f.store.list()[0]!;
    f.applier.apply(f.request([doc("r.md", file("triggers:\n  - on: schedule\n    frequency: daily\n    time: '08:30'\n    timezone: UTC\n"))]));
    const triggers = f.store.listTriggers(agent.id);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.schedule).toMatchObject({ frequency: "daily", time: "08:30" });
    expect(f.workflows.list().filter(workflow => workflow.ownerSentinelId === agent.id)).toHaveLength(1);
    f.applier.apply(f.request([doc("r.md", file())]));
    expect(f.store.listTriggers(agent.id)).toHaveLength(0);
    expect(f.workflows.list().filter(workflow => workflow.ownerSentinelId === agent.id)).toHaveLength(0);
  });

  it("applies nothing when any file is invalid", () => {
    const f = fixture();
    const result = f.applier.apply(f.request([doc("good.md", file()), doc("bad.md", file("bogus: 1\n", "x", "other"))]));
    expect(result.ok).toBe(false);
    expect(result.items.find(item => item.path === "bad.md")!.errors![0]).toMatchObject({ line: expect.any(Number), path: "bogus" });
    expect(f.store.list()).toHaveLength(0);
  });

  it("rejects duplicate ids and files asking for more access than the operator allowed", () => {
    const f = fixture();
    const duplicate = f.applier.plan(f.request([doc("a.md", file()), doc("b.md", file())]));
    expect(duplicate.items.find(item => item.path === "b.md")!.errors![0]!.message).toContain("also used");
    const denied = f.applier.apply(f.request([doc("a.md", file("access: changes\n"))]));
    expect(denied.ok).toBe(false);
    expect(denied.items[0]!.errors![0]!.message).toContain("allow");
    expect(f.store.list()).toHaveLength(0);
    expect(f.applier.apply(f.request([doc("a.md", file("access: changes\n"))], { allowChanges: true })).ok).toBe(true);
    expect(f.store.list()[0]).toMatchObject({ autonomy: "act", toolAccess: "exec" });
  });

  it("never turns production on, and does not resume an Agent the budget breaker paused", () => {
    const f = fixture();
    expect(f.applier.apply(f.request([doc("a.md", file("scope:\n  production: true\n"))])).ok).toBe(false);
    f.applier.apply(f.request([doc("a.md", file("status: active\n"))]));
    const agent = f.store.list()[0]!;
    f.store.setStatus(agent.id, "paused", undefined, { kind: "budget", message: "Daily budget reached.", at: new Date().toISOString() });
    const result = f.applier.apply(f.request([doc("a.md", file("status: active\n"))]));
    expect(result.items[0]!.warnings![0]).toContain("budget");
    expect(f.store.get(agent.id)!.status).toBe("paused");
  });

  it("an Agent whose charter comes from a referenced file", () => {
    const f = fixture();
    const content = file("instructions: _charter.md\n", "");
    const result = f.applier.apply(f.request([{ path: "a.md", content, charter: "From the charter file.\n" }]));
    expect(result.ok).toBe(true);
    expect(f.store.getFile(f.store.list()[0]!.id, "AGENTS.md")!.content).toBe("From the charter file.\n");
    expect(f.applier.apply(f.request([{ path: "a.md", content }])).ok).toBe(false);
  });
});

describe("prune", () => {
  it("removes only managed Agents from the same root, and only with prune", () => {
    const f = fixture();
    const human = f.store.create({ name: "Made in the app" });
    f.applier.apply(f.request([doc("a.md", file(SCHEDULE, "x\n", "a")), doc("b.md", file("", "x\n", "b"))]));
    f.applier.apply({ documents: [doc("c.md", file("", "x\n", "c"))], root: "/other/root" });
    expect(f.store.list()).toHaveLength(4);

    const keepB = f.request([doc("a.md", file(SCHEDULE, "x\n", "a"))]);
    f.applier.apply(keepB);
    expect(f.store.list()).toHaveLength(4);
    const plan = f.applier.plan({ ...keepB, prune: true });
    expect(plan.items.filter(item => item.action === "prune").map(item => item.id)).toEqual(["b"]);
    expect(f.store.list()).toHaveLength(4);

    f.applier.apply({ ...keepB, prune: true });
    const names = f.store.list().map(agent => agent.managedBy?.id ?? agent.name).sort();
    expect(names).toEqual(["Made in the app", "a", "c"]);
    expect(f.store.get(human.id)).not.toBeNull();
  });

  it("removes the automations and triggers of a pruned Agent but not those of others", () => {
    const f = fixture();
    f.applier.apply(f.request([doc("a.md", file(SCHEDULE, "x\n", "a")), doc("b.md", file(SCHEDULE, "x\n", "b"))]));
    expect(f.workflows.list()).toHaveLength(4);
    f.applier.apply({ ...f.request([doc("a.md", file(SCHEDULE, "x\n", "a"))]), prune: true });
    expect(f.workflows.list()).toHaveLength(2);
    expect(f.store.listTriggers()).toHaveLength(2);
  });

  it("refuses to prune everything when no valid file is given (an empty or unmounted folder)", () => {
    const f = fixture();
    f.applier.apply(f.request([doc("a.md", file())]));
    expect(() => f.applier.apply({ ...f.request([]), prune: true })).toThrow(/Refusing to prune/);
    expect(() => f.applier.apply({ ...f.request([doc("bad.md", "nope")]), prune: true })).toThrow(/Refusing to prune/);
    expect(f.store.list()).toHaveLength(1);
  });

  it("an id change is a new Agent, and the old one is removed only with prune", () => {
    const f = fixture();
    f.applier.apply(f.request([doc("a.md", file("", "x\n", "old"))]));
    f.applier.apply(f.request([doc("a.md", file("", "x\n", "new"))]));
    expect(f.store.list().map(agent => agent.managedBy!.id).sort()).toEqual(["new", "old"]);
    f.applier.apply({ ...f.request([doc("a.md", file("", "x\n", "new"))]), prune: true });
    expect(f.store.list().map(agent => agent.managedBy!.id)).toEqual(["new"]);
  });
});

describe("export", () => {
  it("exports an Agent as a valid file that applies back to no change", () => {
    const f = fixture();
    f.applier.apply(f.request([doc("a.md", file(`web: true\nstatus: active\n${SCHEDULE}`, "## Role\nCharter with: colon and # hash.\n", "a"))]));
    const agent = f.store.list()[0]!;
    const exported = f.applier.exportAgent(agent.id);
    expect(exported).toMatchObject({ id: "a", path: "a.md" });
    expect(parseAgentFile(exported.content).ok).toBe(true);
    const second = fixture();
    second.applier.apply(second.request([doc("a.md", exported.content)]));
    expect(second.applier.plan(second.request([doc("a.md", exported.content)])).items[0]!.action).toBe("unchanged");
    expect(f.applier.plan(f.request([doc("a.md", exported.content)])).items[0]!.action).toBe("unchanged");
  });

  it("exports an Agent made in the app, with an id from its name", () => {
    const f = fixture();
    const made = f.store.create({ name: "Prüfer für Zürich!", instructions: "Look at things." });
    const exported = f.applier.exportAgent(made.id);
    expect(exported.id).toBe("prufer-fur-zurich");
    const parsed = parseAgentFile(exported.content);
    expect(parsed.ok && parsed.file.name).toBe("Prüfer für Zürich!");
  });

  it("every preset exports as a valid file that applies", () => {
    for (const preset of SENTINEL_PRESETS) {
      const exported = presetAgentFile(preset);
      const parsed = parseAgentFile(exported.content);
      expect(parsed.ok, preset.id).toBe(true);
      const f = fixture();
      const result = f.applier.apply(f.request([doc(exported.path, exported.content)], { allowChanges: true }));
      expect(result.ok, `${preset.id}: ${JSON.stringify(result.items[0]?.errors)}`).toBe(true);
      const agent = f.store.list()[0]!;
      expect(agent.autonomy).toBe(preset.autonomy === "observe" ? "observe" : "act");
      expect(agent.skills).toEqual(preset.sentinel.skills);
      expect(f.store.listTriggers(agent.id)).toHaveLength(preset.suggestedAutomations.length);
      expect(f.applier.plan(f.request([doc(exported.path, exported.content)], { allowChanges: true })).items[0]!.action).toBe("unchanged");
    }
  });
});

describe("loadAgentDocuments", () => {
  it("reads a directory, skips symlinks, hidden, README and underscore files, and resolves instructions", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "a.md"), file("instructions: _a.md\n", "", "a"));
    writeFileSync(join(dir, "_a.md"), "Charter A.\n");
    writeFileSync(join(dir, "README.md"), "# readme");
    writeFileSync(join(dir, ".hidden.md"), "x");
    writeFileSync(join(dir, "nested", "b.md"), file("", "b\n", "b"));
    const outside = tmp();
    writeFileSync(join(outside, "secret.md"), "outside");
    symlinkSync(join(outside, "secret.md"), join(dir, "link.md"));
    const loaded = await loadAgentDocuments(dir);
    expect(loaded.problems).toEqual([]);
    expect(loaded.documents.map(document => document.path)).toEqual(["a.md", "nested/b.md"]);
    expect(loaded.documents[0]!.charter).toBe("Charter A.\n");
  });
  it("refuses an instructions file that is a symlink out of the folder", async () => {
    const dir = tmp(); const outside = tmp();
    writeFileSync(join(outside, "secret.md"), "outside");
    symlinkSync(join(outside, "secret.md"), join(dir, "_c.md"));
    writeFileSync(join(dir, "a.md"), file("instructions: _c.md\n", "", "a"));
    const loaded = await loadAgentDocuments(dir);
    expect(loaded.documents).toHaveLength(0);
    expect(loaded.problems[0]!.message).toContain("charter");
  });
  it("flags oversized files and handles a single file", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "big.md"), file("", "x".repeat(200_000), "big"));
    writeFileSync(join(dir, "small.md"), file());
    expect((await loadAgentDocuments(dir)).problems[0]!.message).toContain("larger");
    const single = await loadAgentDocuments(join(dir, "small.md"));
    expect(single).toMatchObject({ root: dir, documents: [{ path: "small.md" }] });
    await expect(loadAgentDocuments(join(dir, "missing.md"))).rejects.toThrow();
  });
});

describe("service routes and directory apply", () => {
  const service = (ceiling?: "read-only" | "changes") => {
    const dir = tmp();
    const dbPath = join(dir, "control.db");
    const svc = new WebSentinelService({ dbPath, ...(ceiling ? { fileAccessCeiling: ceiling } : {}), missions: { create: vi.fn(() => ({ id: "m" })), send: vi.fn(async () => ({})), pendingDecisions: () => 0 } });
    const call = async (method: string, path: string, body?: unknown, actor?: Parameters<WebSentinelService["handle"]>[4]) => (await svc.handle(`/api/console/${path}`, method, body, new URLSearchParams(), actor))!;
    return { svc, call, dir, dbPath };
  };
  const body = (documents: AgentDocument[]) => ({ documents, root: "/r" });

  it("plan writes nothing; apply writes; viewers and editors cannot apply; viewers cannot plan", async () => {
    const s = service();
    const plan = await s.call("POST", "sentinels/plan", body([doc("a.md", file())]));
    expect(plan.status).toBe(200);
    expect(((await s.call("GET", "sentinels")).data as { sentinels: unknown[] }).sentinels).toHaveLength(0);
    for (const role of ["viewer", "editor"] as const) expect((await s.call("POST", "sentinels/apply", body([doc("a.md", file())]), { userId: "u", displayName: "U", role })).status).toBe(403);
    expect((await s.call("POST", "sentinels/apply", body([doc("a.md", file())]), { userId: "o", displayName: "O", role: "owner" })).status).toBe(200);
    // Outside team mode the caller is the local operator and has no role.
    expect((await s.call("POST", "sentinels/apply", body([doc("a.md", file())]), { userId: "local", displayName: "Local operator" })).status).toBe(200);
    const list = (await s.call("GET", "sentinels")).data as { sentinels: Array<{ id: string; managedBy?: { path: string } }> };
    expect(list.sentinels[0]!.managedBy!.path).toBe("a.md");
    const exported = await s.call("GET", `sentinels/${list.sentinels[0]!.id}/file`);
    expect((exported.data as { content: string }).content).toContain("apiVersion: 0security/v1");
    await s.svc.dispose();
  });

  it("the API cannot set or clear the managed marker, and unknown body keys are refused", async () => {
    const s = service();
    await s.call("POST", "sentinels/apply", body([doc("a.md", file())]));
    const agent = ((await s.call("GET", "sentinels")).data as { sentinels: Array<{ id: string; version: number }> }).sentinels[0]!;
    expect((await s.call("PATCH", `sentinels/${agent.id}`, { version: agent.version, managedBy: null })).status).toBe(400);
    const forged = await s.call("POST", "sentinels", { name: "Forged", managedBy: { id: "x", path: "x", root: "x", hash: "x", appliedAt: "x" } });
    expect(forged.status).toBe(400);
    expect((await s.call("POST", "sentinels/apply", { ...body([]), extra: true })).status).toBe(400);
    await s.svc.dispose();
  });

  it("the policy ceiling decides, whatever a request asks", async () => {
    const readOnly = service("read-only");
    const asked = await readOnly.call("POST", "sentinels/apply", { ...body([doc("a.md", file("access: changes\n"))]), allowChanges: true });
    expect((asked.data as { ok: boolean }).ok).toBe(false);
    await readOnly.svc.dispose();
    const open = service();
    expect(((await open.call("POST", "sentinels/apply", body([doc("a.md", file("access: changes\n"))]))).data as { ok: boolean }).ok).toBe(false);
    expect(((await open.call("POST", "sentinels/apply", { ...body([doc("a.md", file("access: changes\n"))]), allowChanges: true })).data as { ok: boolean }).ok).toBe(true);
    await open.svc.dispose();
  });

  it("applies a directory (also a read-only one) and reports problems without throwing", async () => {
    const s = service();
    const dir = tmp();
    writeFileSync(join(dir, "a.md"), file(SCHEDULE));
    const first = await s.svc.applyDirectory(dir);
    expect(first).toMatchObject({ ok: true, result: { counts: { create: 1 } } });
    expect((await s.svc.applyDirectory(dir)).result!.counts).toMatchObject({ unchanged: 1 });
    writeFileSync(join(dir, "b.md"), "not an agent");
    const broken = await s.svc.applyDirectory(dir);
    expect(broken.ok).toBe(false);
    expect((await s.svc.applyDirectory(join(dir, "missing"))).ok).toBe(false);
    await s.svc.dispose();
  });

  it("serves a preset as a file", async () => {
    const s = service();
    const response = await s.call("GET", "sentinel-presets/pen-tester/file");
    expect(response.status).toBe(200);
    expect(parseAgentFile((response.data as { content: string }).content).ok).toBe(true);
    expect((await s.call("GET", "sentinel-presets/nope/file")).status).toBe(404);
    await s.svc.dispose();
  });
});

describe("syncing with Agents that already exist", () => {
  const rawUpdate = (dbPath: string, id: string, patch: Record<string, unknown>) => {
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT sentinel_json FROM sentinels WHERE id = ?").get(id) as { sentinel_json: string };
    db.prepare("UPDATE sentinels SET sentinel_json = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.sentinel_json), ...patch }), id);
    db.close();
  };
  /** A store as older versions left it: stored propose/run/observe/act values, per-run budget caps, a removed crew block, an emoji avatar, a hidden CREW.md, shared names, an unmanaged automation. */
  function legacyStore() {
    const f = fixture();
    const propose = f.store.create({ name: "Legacy Propose", mission: "Asked first", skills: ["pr-diff-review"], instructions: "Ask before acting." });
    rawUpdate(f.dbPath, propose.id, { autonomy: "propose", toolAccess: "read-only", crew: { members: ["x"] }, budget: { dailyUsd: 5, maxRunsPerDay: 7, perRunUsd: 1, maxMinutes: 30 }, avatar: { color: "#112233", emoji: "🔥" } });
    const run = f.store.create({ name: "Legacy Run" });
    rawUpdate(f.dbPath, run.id, { autonomy: "run", toolAccess: "exec" });
    const web = f.store.create({ name: "Legacy Web" });
    rawUpdate(f.dbPath, web.id, { autonomy: "observe", toolAccess: "read-web", status: "active" });
    const act = f.store.create({ name: "Legacy Act" });
    rawUpdate(f.dbPath, act.id, { autonomy: "act", toolAccess: "exec" });
    f.store.putFile(act.id, "CREW.md", "removed feature", null, "human", "x");
    const preset = SENTINEL_PRESETS.find(item => item.id === "pr-security-reviewer")!;
    const fromPreset = f.store.create({ ...preset.sentinel });
    const workflow = f.workflows.save({ ...createSecurityWorkflowTemplate("repository-review", { target: "acme/app" }), ownerSentinelId: fromPreset.id, runIn: "new-mission" });
    f.store.createTrigger(fromPreset.id, { automationId: workflow.id, kind: "github-pr", github: { repo: "acme/app", commentOnPr: true }, enabled: true });
    f.store.create({ name: "Twin" });
    f.store.create({ name: "Twin" });
    return { ...f, ids: { propose: propose.id, run: run.id, web: web.id, act: act.id, fromPreset: fromPreset.id } };
  }
  const documentsOf = (applier: AgentFileApplier) => applier.exportAll().map(item => doc(item.path, item.content));

  it("export changes nothing, gives every Agent a unique id, and leaves hidden legacy files out", () => {
    const f = legacyStore();
    const before = JSON.stringify([f.store.list(), f.store.listTriggers(), f.workflows.list()]);
    const files = f.applier.exportAll();
    expect(JSON.stringify([f.store.list(), f.store.listTriggers(), f.workflows.list()])).toBe(before);
    expect(files).toHaveLength(7);
    expect(new Set(files.map(item => item.id)).size).toBe(7);
    expect(files.filter(item => item.id.startsWith("twin")).map(item => item.id).sort()[0]).toBe("twin");
    expect(files.every(item => parseAgentFile(item.content).ok)).toBe(true);
    expect(f.store.list().every(agent => !agent.managedBy)).toBe(true);
    const byId = new Map(files.map(item => [item.id, parseAgentFile(item.content)]));
    const legacy = byId.get("legacy-propose")!;
    expect(legacy.ok && legacy.file).toMatchObject({ access: "changes", budget: { dailyUsd: 5, maxRunsPerDay: 7 }, avatar: { color: "#112233" } });
    expect(JSON.stringify(files)).not.toContain("removed feature");
    const preset = byId.get("pr-security-reviewer")!;
    expect(preset.ok && preset.file).toMatchObject({ preset: "pr-security-reviewer", triggers: [{ on: "github-pr", repo: "acme/app", commentOnPr: true, template: "repository-review" }] });
  });

  it("round trip: instance -> export -> apply with --adopt -> no diff, and nothing in the stored Agents is rewritten", () => {
    const f = legacyStore();
    const documents = documentsOf(f.applier);
    const stored = new Map(f.store.list().map(agent => [agent.id, JSON.stringify({ ...agent, managedBy: undefined, updatedAt: undefined })]));
    const triggersBefore = JSON.stringify(f.store.listTriggers());
    const workflowsBefore = JSON.stringify(f.workflows.list());
    const plan = f.applier.plan(f.request(documents, { adopt: true, allowChanges: true }));
    expect(plan.ok, JSON.stringify(plan.items.filter(item => item.action === "error"))).toBe(true);
    expect(plan.items.every(item => item.action === "adopt" && item.changes.length === 0), JSON.stringify(plan.items.filter(item => item.changes.length))).toBe(true);
    f.applier.apply(f.request(documents, { adopt: true, allowChanges: true }));
    expect(f.store.list()).toHaveLength(7);
    for (const agent of f.store.list()) {
      expect(agent.managedBy).toBeDefined();
      expect(JSON.stringify({ ...agent, managedBy: undefined, updatedAt: undefined })).toBe(stored.get(agent.id));
    }
    expect(f.store.get(f.ids.propose)!.autonomy).toBe("propose");
    expect(JSON.stringify(f.store.listTriggers())).toBe(triggersBefore);
    expect(JSON.stringify(f.workflows.list())).toBe(workflowsBefore);
    const again = f.applier.plan(f.request(documents, { adopt: true, allowChanges: true }));
    expect(again.items.every(item => item.action === "unchanged")).toBe(true);
    expect(f.applier.exportAll().map(item => item.content)).toEqual(documents.map(document => document.content));
    expect(f.store.listManaged().find(agent => agent.id === f.ids.fromPreset)!.managedBy!.triggers).toMatchObject({ "github-pr-1": { created: false } });
  });

  it("never creates a silent duplicate: a file named like an unmanaged Agent needs --adopt or a new name", () => {
    const f = fixture();
    const existing = f.store.create({ name: "Reviewer", instructions: "Mine." });
    const content = file();
    const refused = f.applier.apply(f.request([doc("reviewer.md", content)]));
    expect(refused.ok).toBe(false);
    expect(refused.items[0]!.errors![0]!.message).toContain('duplicate named "Reviewer": use --adopt');
    expect(f.store.list()).toHaveLength(1);
    const adopted = f.applier.apply(f.request([doc("reviewer.md", content)], { adopt: true }));
    expect(adopted.items[0]).toMatchObject({ action: "adopt", agentId: existing.id });
    expect(f.store.list()).toHaveLength(1);
    expect(f.store.get(existing.id)!.managedBy).toMatchObject({ id: "reviewer" });
    expect(f.store.getFile(existing.id, "AGENTS.md")!.content).toContain("Review pull requests.");
    expect(f.applier.apply(f.request([doc("reviewer.md", content)])).counts.unchanged).toBe(1);
  });

  it("two Agents with one name: the plain file is ambiguous only when its id does not say which", () => {
    const f = fixture();
    f.store.create({ name: "Reviewer" });
    f.store.create({ name: "Reviewer" });
    const result = f.applier.plan(f.request([doc("x.md", file("", "x\n", "something-else"))], { adopt: true }));
    expect(result.items[0]!.errors![0]!.message).toContain("2 Agents are named");
  });

  it("accepting UI edits into the file: export, apply the exported file, and the edit stops being drift", () => {
    const f = fixture();
    f.applier.apply(f.request([doc("a.md", file("", "Charter.\n", "a"))]));
    const agent = f.store.list()[0]!;
    f.store.update(agent.id, { version: agent.version, name: "Better name", skills: ["pr-diff-review", "secrets-hunting"] });
    f.store.putFile(agent.id, "AGENTS.md", "Improved charter.\n", 2, "human", "someone");
    expect(f.store.get(agent.id) && f.applier.isEdited(f.store.get(agent.id)!)).toBe(true);
    const plan = f.applier.plan(f.request([doc("a.md", file("", "Charter.\n", "a"))]));
    expect(plan.items[0]!.details.map(detail => detail.field)).toEqual(expect.arrayContaining(["name", "skills", "charter"]));
    const exported = f.applier.exportAgent(agent.id);
    expect(exported.id).toBe("a");
    const accepted = f.applier.apply(f.request([doc("a.md", exported.content)]));
    expect(accepted.ok).toBe(true);
    expect(f.store.get(agent.id)).toMatchObject({ name: "Better name" });
    expect(f.applier.isEdited(f.store.get(agent.id)!)).toBe(false);
  });

  it("the Agents view says where the definition lives", async () => {
    const dir = tmp();
    const svc = new WebSentinelService({ dbPath: join(dir, "c.db"), missions: { create: vi.fn(() => ({ id: "m" })), send: vi.fn(async () => ({})), pendingDecisions: () => 0 } });
    const call = async (method: string, path: string, body?: unknown) => (await svc.handle(`/api/console/${path}`, method, body, new URLSearchParams()))!;
    await call("POST", "sentinels", { name: "By hand" });
    await call("POST", "sentinels/apply", { documents: [doc("a.md", file())], root: "/r" });
    const list = ((await call("GET", "sentinels")).data as { sentinels: Array<{ name: string; id: string; version: number; fileState: Record<string, unknown> }> }).sentinels;
    expect(list.find(item => item.name === "By hand")!.fileState).toEqual({ source: "app" });
    const managed = list.find(item => item.name === "Reviewer")!;
    expect(managed.fileState).toMatchObject({ source: "file", path: "a.md", edited: false });
    await call("PATCH", `sentinels/${managed.id}`, { version: managed.version, name: "Changed" });
    const after = ((await call("GET", `sentinels/${managed.id}`)).data as { sentinel: { fileState: { edited: boolean } } }).sentinel;
    expect(after.fileState.edited).toBe(true);
    const export_ = (await call("GET", "sentinels/export-all")).data as { files: unknown[] };
    expect(export_.files).toHaveLength(2);
    await svc.dispose();
  });
});

describe("examples/agents", () => {
  const examples = new URL("../../../../examples/agents/", import.meta.url).pathname;
  it("has the three example files, all valid", async () => {
    const loaded = await loadAgentDocuments(examples);
    expect(loaded.problems).toEqual([]);
    expect(loaded.documents.map(document => document.path)).toEqual(["dependency-watcher.md", "pen-tester.md", "pr-security-reviewer.md"]);
    for (const document of loaded.documents) { const parsed = parseAgentFile(document.content); expect(parsed.ok, document.path).toBe(true); expect(parsed.ok && parsed.file.status).toBe("paused"); }
  });
  it("apply cleanly and repeat as a no-op; the pen tester has no production scope", async () => {
    const f = fixture();
    const loaded = await loadAgentDocuments(examples);
    const request = f.request(loaded.documents, { allowChanges: true, root: examples });
    expect(f.applier.apply(request).ok).toBe(true);
    expect(f.applier.apply(request).counts).toMatchObject({ unchanged: 3 });
    const tester = f.store.list().find(agent => agent.managedBy!.id === "pen-tester")!;
    expect(tester).toMatchObject({ autonomy: "observe", toolAccess: "read-web", scope: { production: false, targets: ["https://staging.example.com"] } });
    expect(f.store.getFile(tester.id, "AGENTS.md")!.content).toContain("Out of scope by default");
  });
});
