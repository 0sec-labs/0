import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SentinelStore } from "./sentinels.js";
import { createShimmedDatabase } from "./wasm-shim.js";

const dirs: string[] = [];
const dbPath = () => { const dir = mkdtempSync(join(tmpdir(), "zero-turns-")); dirs.push(dir); return join(dir, "control.db"); };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const base = (sentinelId: string, kind: "schedule" | "github-pr" | "manual" = "schedule", extra: Record<string, unknown> = {}) =>
  ({ sentinelId, sentinelVersion: 1, trigger: { kind, ...(kind === "schedule" ? { triggerId: "t1" } : {}) }, status: "running" as const, skills: [], ...extra });

describe("agent turn ledger", () => {
  it("writes one turn per activation with the origin mapped and a per-Sentinel sequence", () => {
    const store = new SentinelStore(":memory:");
    const agent = store.create({ name: "A" });
    store.createActivation(base(agent.id, "schedule"), { via: "schedule", idempotencyKey: "k1" });
    store.createActivation(base(agent.id, "github-pr", { trigger: { kind: "github-pr", triggerId: "t2", event: { pr: 7, headSha: "abc" } } }), { via: "webhook" });
    store.createActivation(base(agent.id, "manual"));
    const turns = store.listTurns(agent.id).sort((a, b) => a.seq! - b.seq!);
    expect(turns.map(turn => [turn.origin, turn.seq, turn.detail.via])).toEqual([["schedule", 1, "schedule"], ["github", 2, "webhook"], ["user", 3, "manual"]]);
    expect(turns[0]).toMatchObject({ idempotencyKey: "k1", triggerId: "t1", status: "running" });
    expect(turns[1]!.detail.event).toEqual({ pr: 7, headSha: "abc" });
    store.close();
  });

  it("invariant: every activation has exactly one turn, and updates mirror onto it", () => {
    const store = new SentinelStore(":memory:");
    const agent = store.create({ name: "A" });
    const a = store.createActivation(base(agent.id));
    store.createActivation(base(agent.id, "schedule", { status: "skipped", error: "Waiting on you" }));
    store.updateActivation(a.id, { missionId: "m1", status: "completed", costUsd: 0.42, finishedAt: "2026-01-01T00:00:00.000Z", note: "n" });
    const turns = store.listTurns(agent.id);
    expect(turns).toHaveLength(store.listActivations(agent.id).length);
    expect(new Set(turns.map(turn => turn.legacyActivationId))).toEqual(new Set(store.listActivations(agent.id).map(item => item.id)));
    expect(turns.find(turn => turn.legacyActivationId === a.id)).toMatchObject({ status: "completed", sessionId: "m1", costUsd: 0.42, note: "n", finishedAt: "2026-01-01T00:00:00.000Z" });
    expect(turns.find(turn => turn.status === "skipped")).toMatchObject({ skippedReason: "Waiting on you" });
    store.close();
  });

  it("a replayed cause never fails the activation path and is stored without the key", () => {
    const store = new SentinelStore(":memory:");
    const agent = store.create({ name: "A" });
    store.createActivation(base(agent.id), { idempotencyKey: "same" });
    expect(() => store.createActivation(base(agent.id), { idempotencyKey: "same" })).not.toThrow();
    const turns = store.listTurns(agent.id);
    expect(turns).toHaveLength(2);
    expect(turns.filter(turn => turn.idempotencyKey === "same")).toHaveLength(1);
    expect(store.getTurnByKey(agent.id, "same")).toBeTruthy();
    store.close();
  });

  it("projects activations from before the ledger as origin legacy without rewriting them", () => {
    const path = dbPath();
    const first = new SentinelStore(path);
    const agent = first.create({ name: "Old" });
    const mirrored = first.createActivation(base(agent.id));
    first.close();
    // Compat fixture: an activation written by an engine that had no ledger (no turn row).
    const raw = createShimmedDatabase(path);
    const legacy = { id: "old-1", sentinelId: agent.id, sentinelVersion: 1, trigger: { kind: "github-pr", triggerId: "t9", event: { pr: 3 } }, status: "failed", missionId: "child-1", skills: [], error: "boom", costUsd: 1.5, startedAt: "2020-01-01T00:00:00.000Z", finishedAt: "2020-01-01T00:01:00.000Z" };
    raw.prepare("INSERT INTO sentinel_activations (id, sentinel_id, status, mission_id, automation_id, activation_json, started_at, finished_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)").run(legacy.id, agent.id, legacy.status, legacy.missionId, JSON.stringify(legacy), legacy.startedAt, legacy.finishedAt);
    raw.close();
    const store = new SentinelStore(path);
    const turns = store.listTurns(agent.id);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ origin: "legacy", detail: { via: "github-pr", triggerId: "t9", event: { pr: 3 } }, status: "failed", sessionId: "child-1", error: "boom", costUsd: 1.5, legacyActivationId: "old-1" });
    expect(turns[0]).toMatchObject({ legacyActivationId: mirrored.id, origin: "schedule" });
    expect(store.getActivation("old-1")).toMatchObject({ status: "failed" });
    expect(store.listTurns(agent.id, 1)).toHaveLength(1);
    store.close();
  });

  it("deleting the Sentinel removes its turns and its activations", () => {
    const store = new SentinelStore(":memory:");
    const agent = store.create({ name: "A" });
    store.createActivation(base(agent.id));
    store.delete(agent.id);
    expect(store.listTurns(agent.id)).toEqual([]);
    expect(store.listActivations(agent.id)).toEqual([]);
    store.close();
  });

  it("opening an older database creates the table without touching existing rows", () => {
    const path = dbPath();
    const raw = createShimmedDatabase(path);
    raw.exec("CREATE TABLE sentinel_activations (id TEXT PRIMARY KEY, sentinel_id TEXT NOT NULL, status TEXT NOT NULL, mission_id TEXT, automation_id TEXT, activation_json TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT)");
    raw.close();
    const store = new SentinelStore(path);
    expect(store.listTurns("none")).toEqual([]);
    store.close();
    expect(() => new SentinelStore(path).close()).not.toThrow();
  });

  describe("trigger turn reservation", () => {
    const input = (agentId: string, extra: Record<string, unknown> = {}) => ({ agentId, origin: "schedule" as const, detail: { via: "schedule" }, triggerId: "t1", sessionId: "home", ownerPid: 1, nowIso: new Date().toISOString(), ...extra });

    it("a replayed cause is a no-op, but a failed delivery of it may be retried", () => {
      const store = new SentinelStore(":memory:");
      const agent = store.create({ name: "A" });
      const first = store.reserveTurn(input(agent.id, { idempotencyKey: "k" }));
      if (!("turn" in first)) throw new Error("expected a turn");
      expect(store.reserveTurn(input(agent.id, { idempotencyKey: "k" }))).toMatchObject({ duplicate: { id: first.turn.id } });
      store.updateTurn(first.turn.id, { status: "failed" });
      expect(store.reserveTurn(input(agent.id, { idempotencyKey: "k" }))).toHaveProperty("turn");
      store.close();
    });

    it("skips a trigger's second queued occurrence; a running one does not block", () => {
      const store = new SentinelStore(":memory:");
      const agent = store.create({ name: "A" });
      const first = store.reserveTurn(input(agent.id));
      if (!("turn" in first)) throw new Error("expected a turn");
      expect(store.reserveTurn(input(agent.id))).toMatchObject({ skipped: { status: "skipped", skippedReason: "Still working on the previous one" } });
      store.updateTurn(first.turn.id, { status: "running" });
      expect(store.reserveTurn(input(agent.id))).toHaveProperty("turn");
      store.close();
    });

    it("supersedes a queued older commit of the same pull request only", () => {
      const store = new SentinelStore(":memory:");
      const agent = store.create({ name: "A" });
      const pr = (n: number, sha: string) => input(agent.id, { origin: "github", detail: { via: "poll", event: { pr: n, headSha: sha } }, coalesce: { pr: n }, idempotencyKey: `g:${n}:${sha}` });
      const one = store.reserveTurn(pr(1, "a"));
      const two = store.reserveTurn(pr(2, "a"));
      const newer = store.reserveTurn(pr(1, "b"));
      if (!("turn" in one) || !("turn" in two) || !("turn" in newer)) throw new Error("expected turns");
      expect(newer.superseded.map(turn => turn.id)).toEqual([one.turn.id]);
      expect(store.getTurn(one.turn.id)).toMatchObject({ status: "skipped", skippedReason: "Superseded by a newer commit" });
      expect(store.getTurn(two.turn.id)!.status).toBe("queued");
      store.close();
    });

    it("records a skipped cause once", () => {
      const store = new SentinelStore(":memory:");
      const agent = store.create({ name: "A" });
      const skip = { agentId: agent.id, origin: "github" as const, detail: {}, reason: "Waiting on you", idempotencyKey: "k:waiting", nowIso: new Date().toISOString() };
      const a = store.recordSkippedTurn(skip);
      expect(store.recordSkippedTurn(skip).id).toBe(a.id);
      expect(store.listTurns(agent.id)).toHaveLength(1);
      store.close();
    });

    it("opens the circuit after three failures in a row, and a success or a person resets the count", () => {
      const store = new SentinelStore(":memory:");
      const agent = store.create({ name: "A" });
      const automation = { automationId: "a1", kind: "schedule", schedule: { frequency: "minutes", every: 5 }, enabled: true };
      const trigger = store.createTrigger(agent.id, automation);
      expect(store.noteTurnResult(trigger.id, { status: "failed", error: "x" })).toMatchObject({ disabled: false });
      expect(store.noteTurnResult(trigger.id, { status: "completed" })!.trigger.consecutiveFailures).toBe(0);
      store.noteTurnResult(trigger.id, { status: "failed" }); store.noteTurnResult(trigger.id, { status: "failed" });
      expect(store.noteTurnResult(trigger.id, { status: "failed", error: "boom" })).toMatchObject({ disabled: true, trigger: { enabled: false, lastStatus: "failing", consecutiveFailures: 3 } });
      expect(store.getTrigger(trigger.id)!.lastError).toContain("boom");
      expect(store.listDueTriggers(Date.now() + 10 * 86_400_000)).toEqual([]);
      // Turns that were interrupted by an engine stop are not the trigger's fault.
      const other = store.createTrigger(agent.id, automation);
      for (let i = 0; i < 5; i++) store.noteTurnResult(other.id, { status: "failed", countsAsFailure: false });
      expect(store.getTrigger(other.id)).toMatchObject({ enabled: true, consecutiveFailures: 0 });
      store.updateTrigger(trigger.id, { enabled: true });
      expect(store.getTrigger(trigger.id)).toMatchObject({ enabled: true, consecutiveFailures: 0 });
      store.close();
    });
  });
});

