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

const readArtifact = (status = "confirmed") => ({ tool: "access_control_probe", url: "https://target.test/private?secret=hidden", method: "GET", access_proof: {
  schema: "0.access-proof/v1", authority: "operator-fixture", access_class: "unauthorized-read", status,
  baseline_status: 200, owner_marker_observed: true, comparison_marker_observed: status === "confirmed", cleanup: "not-required",
  baseline_observation: { status: 200, truncated: false, marker_observed: true, response_digest: "sha256:" + "a".repeat(64) },
  comparison_observations: [{ status: status === "confirmed" ? 200 : 403, truncated: false, marker_observed: status === "confirmed", response_digest: "sha256:" + "b".repeat(64) }],
} });
describe("operator-owned read milestones", () => {
  it("shows confirmed reads without exposing paths, credentials or markers", () => {
    const milestone = accessMilestoneFromArtifact("tool_artifact", readArtifact(), "scan", "proof")!;
    expect(milestone).toMatchObject({ status: "confirmed", accessClass: "unauthorized-read", cleanup: "not-required", evidenceEventId: "proof", asset: "https://target.test" });
    expect(milestone.summary).not.toContain("hidden");
    expect(milestone.headline).toContain("confirmed");
  });
  it("requires the host-owned contract and successful matching observations", () => {
    const artifact = readArtifact();
    for (const changed of [{ authority: "model" }, { baseline_status: 403 }, { owner_marker_observed: false }, { comparison_marker_observed: false }, { schema: "unknown" }]) {
      expect(accessMilestoneFromArtifact("tool_artifact", { ...artifact, access_proof: { ...artifact.access_proof, ...changed } }, "scan")).toBeNull();
    }
    expect(accessMilestoneFromArtifact("finding_ingested", artifact, "scan")).toBeNull();
    expect(accessMilestoneFromArtifact("tool_artifact", { ...artifact, access_proof: undefined }, "scan")).toBeNull();
  });
  it("escalates a blocked resource proof once and never downgrades confirmed access", () => {
    const blocked = accessMilestoneFromArtifact("tool_artifact", readArtifact("blocked"), "scan")!;
    const confirmed = accessMilestoneFromArtifact("tool_artifact", readArtifact(), "scan")!;
    let rows = appendAccessMilestone([], { milestone: blocked, at: 1 });
    rows = appendAccessMilestone(rows, { milestone: confirmed, at: 2 });
    expect(rows).toHaveLength(1); expect(rows[0].at).toBe(2); expect(rows[0].milestone.status).toBe("confirmed");
    rows = appendAccessMilestone(rows, { milestone: blocked, at: 3 });
    expect(rows[0].milestone.status).toBe("confirmed"); expect(rows[0].at).toBe(2);
  });
});

const stateArtifact = () => ({ ...artifact(), observation_url: "https://target.test/private?secret=hidden",
  observation_before: { ...artifact().observation_before, redacted: false, value_type: "string" },
  observation_after: { ...artifact().observation_after, redacted: false, value_type: "string" },
  steps: artifact().steps.map(step => ({ ...step, truncated: false, request_marker_sent: true })),
  state_access_proof: { schema: "0.state-access-proof/v1", authority: "operator-fixture", access_class: "unauthorized-write", status: "confirmed", challenge_bound: true,
    proof_id: "00000000-0000-4000-8000-000000000001", fixture_digest: "sha256:" + "a".repeat(64), baseline_digest: "sha256:" + "b".repeat(64), observed_digest: "sha256:" + "c".repeat(64),
    cleanup: "required", verified_at: 1000, generation: 1, cleanup_revision: 0 } });
describe("retained state proof presentation", () => {
  it("shows separate confidence, severity, access and precise cleanup without private values", () => {
    const milestone = accessMilestoneFromArtifact("tool_artifact", stateArtifact(), "scan", "original")!;
    expect(milestone).toMatchObject({ status: "confirmed", accessClass: "unauthorized-write", severity: "unassessed", confidence: 1, cleanup: "required", verifiedAt: 1000 });
    expect(milestone.summary).not.toContain("private-marker");
    expect(milestone.asset).toBe("https://target.test");
    expect(milestone.limitations?.join(" ")).toContain("other side effects");
  });
  it("rejects invalid/unsupported proof claims and contradictory cleanup observations", () => {
    const original = stateArtifact();
    for (const changed of [{ authority: "model" }, { access_class: "shell" }, { fixture_digest: "fake" }, { cleanup: "completed" }, { cleanup_revision: -1 }, { generation: 0 }]) {
      expect(accessMilestoneFromArtifact("tool_artifact", { ...original, state_access_proof: { ...original.state_access_proof, ...changed } }, "scan")).toBeNull();
    }
    expect(accessMilestoneFromArtifact("tool_call_completed", original, "scan")).toBeNull();
    expect(accessMilestoneFromArtifact("tool_artifact", { tool: "access_control_cleanup", observation_url: original.observation_url,
      state_access_proof: { ...original.state_access_proof, cleanup: "completed", cleanup_at: 2000, cleanup_revision: 1 },
      observation: { status: 200, truncated: false, value_digest: original.state_access_proof.observed_digest } }, "scan")).toBeNull();
  });
  it("keeps cleanup revisions monotonic during reconnect and allows a new proof generation", () => {
    const original = stateArtifact();
    const required = accessMilestoneFromArtifact("tool_artifact", original, "scan", "original")!;
    const restored = accessMilestoneFromArtifact("tool_artifact", { tool: "access_control_cleanup", observation_url: original.observation_url,
      state_access_proof: { ...original.state_access_proof, cleanup: "completed", cleanup_at: 1000, cleanup_revision: 2, evidence_event_id: "original" },
      observation: { status: 200, truncated: false, value_digest: original.state_access_proof.baseline_digest } }, "scan", "cleanup")!;
    expect(restored).toMatchObject({ evidenceEventId: "original", cleanupEvidenceEventId: "cleanup" });
    let rows = appendAccessMilestone([{ milestone: required }], { milestone: restored });
    rows = appendAccessMilestone(rows, { milestone: required });
    expect(rows).toHaveLength(1); expect(rows[0].milestone.cleanup).toBe("completed");
    const newProof = accessMilestoneFromArtifact("tool_artifact", { ...original,
      state_access_proof: { ...original.state_access_proof, proof_id: "00000000-0000-4000-8000-000000000002", generation: 2 } }, "scan", "new")!;
    rows = appendAccessMilestone(rows, { milestone: newProof });
    expect(rows[0].milestone.cleanup).toBe("required");
    expect(rows[0].milestone.evidenceEventId).toBe("new");
  });
  it("retains the strongest proof through lower-impact traffic instead of evicting it", async () => {
    const { visibleAccessMilestones } = await import("./access-milestone.js");
    const confirmed = accessMilestoneFromArtifact("tool_artifact", stateArtifact(), "scan")!;
    const conditional = accessMilestoneFromArtifact("tool_artifact", artifact(), "scan")!;
    let rows = [{ milestone: confirmed }];
    for (let i = 0; i < 100; i++) rows = appendAccessMilestone(rows, { milestone: { ...conditional, key: String(i) } });
    expect(rows).toHaveLength(80);
    expect(visibleAccessMilestones(rows)[0].milestone).toBe(confirmed);
  });
});
