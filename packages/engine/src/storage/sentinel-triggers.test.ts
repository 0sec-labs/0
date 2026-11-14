import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SentinelStore, SentinelStoreError } from "./sentinels.js";
import { SecurityWorkflowStore } from "./security-workflows.js";
import { createSecurityWorkflowTemplate } from "../shared/security-workflow-templates.js";
import { sentinelNeedsReview } from "../shared/sentinels.js";

const dirs: string[] = [];
const open = () => { const dir = mkdtempSync(join(tmpdir(), "zero-sentinel-trig-")); dirs.push(dir); return join(dir, "control.db"); };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const code = (fn: () => unknown) => { try { fn(); } catch (error) { return error instanceof SentinelStoreError ? error.statusCode : -1; } return 0; };
const NOW = Date.parse("2026-03-02T10:00:00Z");

describe("Sentinel triggers", () => {
  it("creates schedule and PR triggers, rejects unavailable kinds and bad shapes", () => {
    const store = new SentinelStore(":memory:");
    const s = store.create({ name: "A" });
    const trigger = store.createTrigger(s.id, { automationId: "wf1", kind: "schedule", schedule: { frequency: "minutes", every: 30 } }, NOW);
    expect(trigger).toMatchObject({ enabled: false, nextFireAt: "2026-03-02T10:30:00.000Z", version: 1 });
    const pr = store.createTrigger(s.id, { automationId: "wf1", kind: "github-pr", github: { repo: "o/r" } }, NOW);
    expect(pr.github?.pollMs).toBe(120_000);
    for (const kind of ["github-push", "webhook", "finding-created"]) expect(code(() => store.createTrigger(s.id, { automationId: "wf1", kind }, NOW))).toBe(422);
    expect(code(() => store.createTrigger(s.id, { automationId: "wf1", kind: "schedule" }, NOW))).toBe(400);
    expect(code(() => store.createTrigger(s.id, { automationId: "wf1", kind: "github-pr", github: { repo: "nope" } }, NOW))).toBe(400);
    expect(code(() => store.createTrigger("missing", { automationId: "wf1", kind: "manual" }, NOW))).toBe(404);
    expect(store.listTriggers(s.id)).toHaveLength(2);
    store.close();
  });

  it("claims one occurrence with compare-and-set, skips ahead and recovers stale claims", () => {
    const store = new SentinelStore(":memory:");
    const s = store.create({ name: "A" });
    const t = store.createTrigger(s.id, { automationId: "wf1", kind: "schedule", schedule: { frequency: "minutes", every: 10 }, enabled: true }, NOW);
    expect(store.listDueTriggers(NOW)).toHaveLength(0);
    const due = Date.parse(t.nextFireAt!);
    expect(store.listDueTriggers(due)).toHaveLength(1);
    const next = new Date(due + 600_000).toISOString();
    const claim = store.claimTrigger(t.id, next, due)!;
    expect(claim.activeClaim).toBeTruthy();
    expect(store.claimTrigger(t.id, next, due)).toBeNull();
    expect(store.deleteTrigger(t.id)).toBe(false);
    expect(store.releaseTrigger(t.id, "wrong", {})).toBeNull();
    store.releaseTrigger(t.id, claim.activeClaim!, { lastStatus: "running" }, due);
    expect(store.getTrigger(t.id)).toMatchObject({ lastStatus: "running", nextFireAt: next });
    expect(store.getTrigger(t.id)?.activeClaim).toBeUndefined();
    // A crashed engine's claim is stale after ten minutes.
    const again = store.claimTrigger(t.id, new Date(due + 1_200_000).toISOString(), due + 600_000)!;
    expect(again.activeClaim).toBeTruthy();
    expect(store.claimTrigger(t.id, null, due + 600_000 + 60_000)).toBeNull();
    store.close();
  });

  it("editing a trigger's timing disables it until re-enabled; version conflicts are refused", () => {
    const store = new SentinelStore(":memory:");
    const s = store.create({ name: "A" });
    const t = store.createTrigger(s.id, { automationId: "wf1", kind: "schedule", schedule: { frequency: "daily", time: "09:00", timezone: "UTC" }, enabled: true }, NOW);
    const edited = store.updateTrigger(t.id, { schedule: { frequency: "daily", time: "10:00", timezone: "UTC" } }, 1, NOW);
    expect(edited.enabled).toBe(false);
    expect(edited.nextFireAt).toBe("2026-03-03T10:00:00.000Z");
    expect(code(() => store.updateTrigger(t.id, { enabled: true }, 1, NOW))).toBe(409);
    expect(store.updateTrigger(t.id, { enabled: true }, 2, NOW).enabled).toBe(true);
    store.close();
  });
});

describe("Sentinel review gate, ledger and ownership", () => {
  it("flags needs-review when scope or model change and clears on acknowledge", () => {
    const store = new SentinelStore(":memory:");
    const s = store.create({ name: "A" });
    expect(sentinelNeedsReview(s)).toBe(false);
    const renamed = store.update(s.id, { version: 1, name: "B", mission: "x" });
    expect(sentinelNeedsReview(renamed)).toBe(false);
    const widened = store.update(s.id, { version: 2, scope: { targets: ["https://prod.example"], production: true } });
    expect(sentinelNeedsReview(widened)).toBe(true);
    const swapped = store.acknowledge(s.id, widened.version);
    expect(sentinelNeedsReview(swapped)).toBe(false);
    const remodeled = store.update(s.id, { version: swapped.version, model: { providerId: "openai", model: "x" } });
    expect(sentinelNeedsReview(remodeled)).toBe(true);
    // Resuming with acknowledge also lifts it.
    expect(sentinelNeedsReview(store.setStatus(s.id, "active", remodeled.version, undefined, true))).toBe(false);
    store.close();
  });

  it("sums a rolling ledger (running runs count up to now, skipped runs do not) and records pause reasons", () => {
    const store = new SentinelStore(":memory:");
    const s = store.create({ name: "A" });
    const base = { sentinelId: s.id, sentinelVersion: 1, trigger: { kind: "schedule" as const }, skills: [] };
    store.createActivation({ ...base, status: "completed", costUsd: 1.5, startedAt: "2026-03-02T08:00:00.000Z", finishedAt: "2026-03-02T08:10:00.000Z" });
    store.createActivation({ ...base, status: "running", costUsd: 0.5, startedAt: "2026-03-02T09:50:00.000Z" });
    store.createActivation({ ...base, status: "skipped", costUsd: 9, startedAt: "2026-03-02T09:00:00.000Z" });
    store.createActivation({ ...base, status: "completed", costUsd: 7, startedAt: "2026-03-01T00:00:00.000Z", finishedAt: "2026-03-01T01:00:00.000Z" });
    expect(store.ledger(s.id, "2026-03-01T10:00:00.000Z", NOW)).toEqual({ runs: 2, costUsd: 2, timeMs: 600_000 + 600_000 });
    const paused = store.setStatus(s.id, "paused", undefined, { kind: "budget", message: "Daily budget used.", at: "2026-03-02T10:00:00.000Z" });
    expect(paused.pauseReason?.message).toBe("Daily budget used.");
    expect(store.update(s.id, { version: paused.version, mission: "m" }).pauseReason).toBeDefined();
    expect(store.setStatus(s.id, "active").pauseReason).toBeUndefined();
    store.close();
  });

  it("validates ownerSentinelId on save and detaches automations on hard delete", () => {
    const path = open();
    const store = new SentinelStore(path);
    const workflows = new SecurityWorkflowStore(path);
    const template = createSecurityWorkflowTemplate("dependency-review", { target: "." });
    expect(() => workflows.save({ ...template, ownerSentinelId: "ghost" })).toThrow(/Owner Sentinel/);
    const s = store.create({ name: "A" });
    const owned = workflows.save({ ...template, ownerSentinelId: s.id, runIn: "sentinel-home" });
    const keep = workflows.save({ ...template, ownerSentinelId: s.id, runIn: "new-mission" });
    store.createTrigger(s.id, { automationId: owned.id, kind: "manual" });
    expect(store.delete(s.id)).toBe(true);
    expect(store.listTriggers()).toHaveLength(0);
    expect(workflows.clearOwnerSentinel(s.id).sort()).toEqual([owned.id, keep.id].sort());
    expect(workflows.get(owned.id)).toMatchObject({ ownerSentinelId: null, revision: 2 });
    expect(workflows.get(owned.id)?.runIn).toBeUndefined();
    expect(workflows.get(keep.id)?.runIn).toBe("new-mission");
    store.close(); workflows.close();
  });
});
