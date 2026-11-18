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

    it("preserves failing status and lastError when releaseTrigger runs after the circuit breaker trips mid-claim", () => {
      const store = new SentinelStore(":memory:");
      const agent = store.create({ name: "A" });
      const now = Date.parse("2026-03-02T10:00:00Z");
      const trigger = store.createTrigger(agent.id, { automationId: "a1", kind: "github-pr", github: { repo: "o/r" }, enabled: true }, now);
      const claim = store.claimTrigger(trigger.id, new Date(now + 120_000).toISOString(), now)!;
      expect(claim.activeClaim).toBeTruthy();

      store.noteTurnResult(trigger.id, { status: "failed", error: "err-1" }, now + 1);
      store.noteTurnResult(trigger.id, { status: "failed", error: "err-2" }, now + 2);
      const tripped = store.noteTurnResult(trigger.id, { status: "failed", error: "boom-3" }, now + 3);
      expect(tripped).toMatchObject({ disabled: true, trigger: { enabled: false, lastStatus: "failing", consecutiveFailures: 3 } });
      const breakerError = tripped!.trigger.lastError!;
      expect(breakerError).toContain("Turned off after 3 failed turns in a row.");
      expect(breakerError).toContain("boom-3");

      // Stale release attempting to overwrite status, clear error, or re-enable must preserve failing state while releasing claim & saving processed cursor.
      const released = store.releaseTrigger(trigger.id, claim.activeClaim!, { enabled: true, lastStatus: "queued", lastError: undefined, cursor: { "4": "sha4" } }, now + 4);
      expect(released).toMatchObject({ enabled: false, lastStatus: "failing", lastError: breakerError, consecutiveFailures: 3, cursor: { "4": "sha4" } });
      expect(released?.activeClaim).toBeUndefined();
      // Wrong claim is still rejected.
      expect(store.releaseTrigger(trigger.id, claim.activeClaim!, { lastStatus: "idle" }, now + 5)).toBeNull();
      store.close();
    });

    it("keeps circuit-breaker failing state intact across later queued turn results until explicitly re-enabled", () => {
      const store = new SentinelStore(":memory:");
      const agent = store.create({ name: "A" });
      const trigger = store.createTrigger(agent.id, { automationId: "a1", kind: "github-pr", github: { repo: "o/r" }, enabled: true });

      store.noteTurnResult(trigger.id, { status: "failed", error: "e1" });
      store.noteTurnResult(trigger.id, { status: "failed", error: "e2" });
      const tripped = store.noteTurnResult(trigger.id, { status: "failed", error: "e3" })!;
      const breakerError = tripped.trigger.lastError!;
      expect(tripped).toMatchObject({ disabled: true, trigger: { enabled: false, lastStatus: "failing", consecutiveFailures: 3 } });

      // A later queued turn succeeding cannot silently reset or recover the breaker.
      const afterSuccess = store.noteTurnResult(trigger.id, { status: "completed" })!;
      expect(afterSuccess).toMatchObject({ disabled: false, trigger: { enabled: false, lastStatus: "failing", lastError: breakerError, consecutiveFailures: 3 } });

      // A later queued turn being cancelled preserves failing state and error.
      const afterCancel = store.noteTurnResult(trigger.id, { status: "cancelled" })!;
      expect(afterCancel).toMatchObject({ disabled: false, trigger: { enabled: false, lastStatus: "failing", lastError: breakerError, consecutiveFailures: 3 } });

      // A later queued turn failing increments failure streak without overwriting failing status or breaker error.
      const afterFail = store.noteTurnResult(trigger.id, { status: "failed", error: "e4" })!;
      expect(afterFail).toMatchObject({ disabled: false, trigger: { enabled: false, lastStatus: "failing", lastError: breakerError, consecutiveFailures: 4 } });

      // Explicit operator re-enable resets the breaker cleanly.
      const reenabled = store.updateTrigger(trigger.id, { enabled: true });
      expect(reenabled).toMatchObject({ enabled: true, lastStatus: "scheduled", consecutiveFailures: 0 });
      expect(reenabled.lastError).toBeUndefined();
      store.close();
    });

    it("refuses reserveTurn atomically when the trigger is disabled or failing without inserting rows, releasing keys, or superseding queued turns", () => {
      const store = new SentinelStore(":memory:");
      const agent = store.create({ name: "A" });
      const trigger = store.createTrigger(agent.id, { automationId: "a1", kind: "github-pr", github: { repo: "o/r" }, enabled: true });

      const prInput = (pr: number, sha: string) => ({
        agentId: agent.id,
        origin: "github" as const,
        detail: { via: "poll", triggerId: trigger.id, event: { pr, headSha: sha } },
        triggerId: trigger.id,
        sessionId: "home",
        idempotencyKey: `github:${trigger.id}:${pr}:${sha}`,
        coalesce: { pr },
        ownerPid: 1,
        nowIso: new Date().toISOString(),
      });

      // Seed one queued turn (PR #1) and one failed turn (PR #2) while enabled.
      const queuedPr1 = store.reserveTurn(prInput(1, "sha1"));
      const failedPr2 = store.reserveTurn(prInput(2, "sha2"));
      if (!("turn" in queuedPr1) || !("turn" in failedPr2)) throw new Error("expected turns");
      store.updateTurn(failedPr2.turn.id, { status: "failed", error: "e1" });

      // Trip the circuit breaker.
      store.noteTurnResult(trigger.id, { status: "failed", error: "e1" });
      store.noteTurnResult(trigger.id, { status: "failed", error: "e2" });
      const tripped = store.noteTurnResult(trigger.id, { status: "failed", error: "boom-3" })!;
      const breakerError = tripped.trigger.lastError!;
      expect(tripped.disabled).toBe(true);

      // Coalescing attempt for PR #1 must be refused and must NOT supersede queuedPr1.
      expect(store.reserveTurn(prInput(1, "sha1-newer"))).toEqual({ refused: breakerError });
      expect(store.getTurn(queuedPr1.turn.id)).toMatchObject({ status: "queued" });

      // Retry attempt for failed PR #2 must be refused and must NOT release its idempotency_key.
      expect(store.reserveTurn(prInput(2, "sha2"))).toEqual({ refused: breakerError });
      expect(store.getTurnByKey(agent.id, `github:${trigger.id}:2:sha2`)?.id).toBe(failedPr2.turn.id);

      // New PR #3 attempt must be refused with zero inserted rows.
      expect(store.reserveTurn(prInput(3, "sha3"))).toEqual({ refused: breakerError });
      expect(store.listTurns(agent.id)).toHaveLength(2);

      // Manually paused trigger (no lastError) refuses with fallback message and zero inserted rows.
      const paused = store.createTrigger(agent.id, { automationId: "a1", kind: "schedule", schedule: { frequency: "minutes", every: 5 }, enabled: false });
      expect(store.reserveTurn({
        agentId: agent.id, origin: "schedule", detail: { via: "schedule", triggerId: paused.id }, triggerId: paused.id,
        sessionId: "home", idempotencyKey: `schedule:${paused.id}:1`, ownerPid: 1, nowIso: new Date().toISOString(),
      })).toEqual({ refused: "Trigger is off." });
      expect(store.listTurns(agent.id)).toHaveLength(2);

      // Releasing a withdrawn turn's idempotency key allows re-reservation once the trigger is re-enabled.
      const released = store.updateTurn(queuedPr1.turn.id, { status: "skipped", skippedReason: breakerError, error: breakerError, releaseIdempotencyKey: true });
      expect(released.idempotencyKey).toBeUndefined();
      expect(store.getTurnByKey(agent.id, `github:${trigger.id}:1:sha1`)).toBeNull();
      store.updateTrigger(trigger.id, { enabled: true });
      const retried = store.reserveTurn(prInput(1, "sha1"));
      expect(retried).toHaveProperty("turn");
      store.close();
    });
  });
});

