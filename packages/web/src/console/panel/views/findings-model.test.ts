import { describe, expect, it } from "vitest";
import type { FindingGroup } from "../../../types";
import { findingStatusLabel, groupBySeverity, isAcceptedFinding, isOpenFinding } from "./findings-model";

const group = (triageStatus: string, workflowStatus: string, status = "new"): FindingGroup =>
  ({
    fingerprint: `fp-${triageStatus}-${workflowStatus}`,
    count: 1,
    scanCount: 1,
    latest: { id: "f", title: "t", severity: "high", status, triageStatus, timestamp: 1 },
    workflow: { status: workflowStatus },
  }) as unknown as FindingGroup;

describe("accepted risk", () => {
  it("stays open and is labelled Accepted", () => {
    const accepted = group("accepted", "human_review");
    expect(isAcceptedFinding(accepted)).toBe(true);
    expect(isOpenFinding(accepted)).toBe(true);
    expect(findingStatusLabel(accepted)).toBe("Accepted");
  });
  it("is not accepted once closed or dismissed", () => {
    expect(isAcceptedFinding(group("accepted", "done"))).toBe(false);
    expect(isAcceptedFinding(group("suppressed", "cancelled"))).toBe(false);
    expect(findingStatusLabel(group("new", "backlog"))).toBe("Backlog");
  });
  it("filters by Accepted", () => {
    const groups = [group("accepted", "backlog"), group("new", "backlog"), group("accepted", "done")];
    const shown = groupBySeverity(groups, { status: "accepted", severity: "all" }).flatMap((entry) => entry.findings);
    expect(shown).toHaveLength(1);
  });
});
