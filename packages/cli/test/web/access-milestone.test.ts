import { describe, expect, it } from "vitest";
import { parseHuntEvent } from "../../../dashboard/src/lib/hunt-stream.js";
import { appendAccessMilestone } from "@0/shared";
const receipt = { protocol: "0.presentation/v1", kind: "event", source: "core", sequence: 1, scanId: "scan-a", at: "2026-10-05T10:00:00Z", eventType: "tool_artifact",
  payload: { presentationEventId: "proof-event", tool: "access_control_workflow", workflow: "access_control_workflow", verdict: "confirmed", owner_identity: "owner", actor_identity: "anonymous",
    expected_state: "secret-marker", observation_url: "https://target.test/private?secret=hidden",
    observation_before: { status: 200, truncated: false, field_present: true, json_pointer_value: "old" },
    observation_after: { status: 200, truncated: false, field_present: true, json_pointer_value: "secret-marker" },
    steps: [{ step_index: 0, method: "POST", url: "https://target.test/private", status: 200 }] } };
describe("live access milestone transport", () => {
  it("projects retained canonical artifacts with evidence scope and timestamp", () => {
    const parsed = parseHuntEvent(JSON.stringify(receipt));
    expect(parsed?.kind).toBe("access_milestone");
    if (parsed?.kind !== "access_milestone") throw new Error("missing milestone");
    expect(parsed.scanId).toBe("scan-a"); expect(parsed.ts).toBe(Date.parse(receipt.at) / 1000);
    expect(parsed.milestone.asset).toBe("https://target.test"); expect(parsed.milestone.evidenceEventId).toBe("proof-event");
  });
  it("polling and reconnect replay retain the first milestone even after tool-card eviction", () => {
    const first = parseHuntEvent(JSON.stringify(receipt));
    const replay = parseHuntEvent(JSON.stringify({ ...receipt, sequence: 1000, at: "2026-10-05T11:00:00Z" }));
    if (first?.kind !== "access_milestone" || replay?.kind !== "access_milestone") throw new Error("missing milestone");
    const rows = appendAccessMilestone(appendAccessMilestone([], { milestone: first.milestone, ts: first.ts }), { milestone: replay.milestone, ts: replay.ts });
    expect(rows).toHaveLength(1); expect(rows[0].ts).toBe(first.ts);
  });
  it("rejects malformed and out-of-range verification timestamps", () => {
    expect(parseHuntEvent(JSON.stringify({ ...receipt, at: "not-a-date" }))).toBeNull();
    expect(parseHuntEvent(JSON.stringify({ ...receipt, payload: { ...receipt.payload, ts: 1e20 } }))).toBeNull();
  });
  it("ignores model/native claims, missing assessment identity and inconclusive receipts", () => {
    expect(parseHuntEvent(JSON.stringify({ schema: "0.events/v1", kind: "access_milestone", milestone: { headline: "Compromised" } }))).toBeNull();
    expect(parseHuntEvent(JSON.stringify({ ...receipt, scanId: undefined }))).toBeNull();
    expect(parseHuntEvent(JSON.stringify({ ...receipt, payload: { ...receipt.payload, verdict: "inconclusive" } }))).toBeNull();
  });
});
