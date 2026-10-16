import { describe, expect, it } from "vitest";
import { accessMilestoneFromArtifact, appendAccessMilestone } from "./access-milestone.js";
const artifact = () => ({ tool: "access_control_workflow", workflow: "access_control_workflow", verdict: "confirmed",
  owner_identity: "owner", actor_identity: "anonymous", observation_url: "https://target.test/private/resource?token=secret",
  expected_state: "private-marker", observation_before: { status: 200, truncated: false, field_present: true, json_pointer_value: "before" },
  observation_after: { status: 200, truncated: false, field_present: true, json_pointer_value: "private-marker" },
  steps: [{ step_index: 0, url: "https://target.test/private/resource", method: "POST", status: 200 }] });
describe("evidence-grounded access milestones", () => {
  it("projects observed transitions with conditional authorization and unknown cleanup", () => {
    const milestone = accessMilestoneFromArtifact("tool_artifact", artifact(), "scan")!;
    expect(milestone.status).toBe("conditional"); expect(milestone.cleanup).toBe("unknown");
    expect(milestone.asset).toBe("https://target.test");
    expect(milestone.summary).not.toContain("private-marker");
    expect(milestone.summary).toContain("Authorization impact requires validation");
  });
  it("never treats finding/model/replay assertions as compromise", () => {
    for (const type of ["finding_ingested", "verification_result", "tool_call_completed"]) {
      expect(accessMilestoneFromArtifact(type, { ...artifact(), title: "RCE confirmed", status: "verified" }, "scan")).toBeNull();
    }
  });
  it("fails closed on source-only, unverified, denied, incomplete or unchanged evidence", () => {
    const cases = [ { verdict: "inconclusive" }, { verdict: "no_change" }, { steps: [] }, { actor_identity: "owner" },
      { observation_after: { status: 403, truncated: false, field_present: true, json_pointer_value: "private-marker" } },
      { observation_after: { status: 200, truncated: true, field_present: true, json_pointer_value: "private-marker" } },
      { observation_before: artifact().observation_after }, { expected_state: "different" },
      { steps: [{ ...artifact().steps[0], error: "transport failed" }] }, { observation_before: null } ];
    for (const changed of cases) expect(accessMilestoneFromArtifact("tool_artifact", { ...artifact(), ...changed }, "scan")).toBeNull();
  });
  it("deduplicates polling/reconnect receipts by assessment, class and exact asset", () => {
    const milestone = accessMilestoneFromArtifact("tool_artifact", artifact(), "scan")!;
    let rows = appendAccessMilestone([], { milestone, at: 1 });
    rows = appendAccessMilestone(rows, { milestone: accessMilestoneFromArtifact("tool_artifact", artifact(), "scan")!, at: 2 });
    expect(rows).toHaveLength(1); expect(rows[0].at).toBe(1);
    rows = appendAccessMilestone(rows, { milestone: accessMilestoneFromArtifact("tool_artifact", artifact(), "another-scan")!, at: 3 });
    expect(rows).toHaveLength(2);
    for (let i = 0; i < 100; i++) rows = appendAccessMilestone(rows, { milestone: { ...milestone, key: String(i) }, at: i });
    expect(rows).toHaveLength(80);
    expect(rows[0].milestone.key).toBe("20"); expect(rows.at(-1)?.milestone.key).toBe("99");
    rows = appendAccessMilestone(rows, { milestone: { ...milestone, key: "99" }, at: 1000 });
    expect(rows).toHaveLength(80); expect(rows.at(-1)?.at).toBe(99);
  });
});
