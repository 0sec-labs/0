import { describe, expect, it } from "vitest";
import { createSentinelClient } from "./api";
import { SENTINEL_TRIGGER_APPROVAL, describeTrigger, orderSentinels, presentStatus, type Sentinel } from "./model";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const base = { id: "s", name: "S", status: "active", updatedAt: "2026-01-01T00:00:00Z" } as Sentinel;

describe("agent review", () => {
  it("shows Needs review ahead of Needs you and Active", () => {
    expect(presentStatus({ status: "active", attention: { needsYou: true, needsReview: true, pendingDecisions: 1 } }).label).toBe("Needs review");
    expect(presentStatus({ status: "active", attention: { needsYou: true, needsReview: false, pendingDecisions: 1 } }).label).toBe("Needs you");
    expect(presentStatus({ status: "paused" }).label).toBe("Paused");
  });
  it("sorts review-gated Agents first", () => {
    const rows = orderSentinels([{ ...base, id: "a", name: "A" }, { ...base, id: "b", name: "B", attention: { needsYou: false, needsReview: true, pendingDecisions: 0 } }]);
    expect(rows.map(row => row.id)).toEqual(["b", "a"]);
  });
  it("describes triggers", () => {
    expect(describeTrigger({ kind: "schedule", summary: "Every day at 09:00" })).toBe("Every day at 09:00");
    expect(describeTrigger({ kind: "github-pr", github: { repo: "o/r", pollMs: 120000 } })).toBe("Pull requests on o/r");
    expect(describeTrigger({ kind: "github-pr", github: { repo: "o/r", pollMs: 120000, commentOnPr: true, includeForks: true } })).toBe("Pull requests on o/r, comments on, forks included");
  });
});

describe("agent client", () => {
  it("sends the approval only when enabling a trigger", async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const client = createSentinelClient(async (path, init) => { calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) }); return json({ trigger: { id: "t" } }); });
    await client.updateTrigger("s", "t", 3, { enabled: true });
    await client.updateTrigger("s", "t", 4, { enabled: false });
    expect(calls[0]).toEqual({ path: "/api/console/sentinels/s/triggers/t", body: { expectedVersion: 3, enabled: true, approval: SENTINEL_TRIGGER_APPROVAL } });
    expect(calls[1]!.body).toEqual({ expectedVersion: 4, enabled: false });
  });
  it("posts acknowledge", async () => {
    const calls: string[] = [];
    const client = createSentinelClient(async path => { calls.push(path); return json({ sentinel: base }); });
    await client.acknowledge("s", 2);
    expect(calls).toEqual(["/api/console/sentinels/s/acknowledge"]);
  });
  it("maps privileged denials to clear messages", async () => {
    const client = createSentinelClient(async () => json({ code: "owner_required", error: "raw" }, 403));
    await expect(client.acknowledge("s", 1)).rejects.toThrow("Only team owners can do this. Ask an owner to make the change.");
  });
});
