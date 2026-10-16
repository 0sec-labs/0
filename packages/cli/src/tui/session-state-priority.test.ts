import { describe, expect, it } from "vitest";
import { getFindingPriority } from "@0/shared";
import { applySessionEvent, createInitialSessionState } from "./session-state.js";

const impactAssessment = {
  reachability_tier: "remote-auth", weaponizability: "info-leak", blast_radius: "Tenant records",
  business_impact: "notable", rationale: "Tenant data is affected.", assessment_source: "provided",
};

function finding(data: unknown) {
  const state = applySessionEvent(createInitialSessionState(".", "quick", "audit"), {
    type: "finding", message: "[critical] Tenant leak", data,
  });
  return state.stages.flatMap((stage) => stage.findings)[0];
}

describe("session findings business assessment", () => {
  it("retains validated event assessments for the sidebar", () => {
    const item = finding({ severity: "critical", impactAssessment });
    expect(item.impactAssessment).toEqual(impactAssessment);
    expect(getFindingPriority(item).label).toBe("High");
  });

  it("does not turn technical severity or invalid event data into assessed priority", () => {
    expect(getFindingPriority(finding({ severity: "critical" })).label).toBe("Not assessed");
    expect(getFindingPriority(finding({ severity: "critical", impactAssessment: { business_impact: "headline" } })).assessed).toBe(false);
    expect(getFindingPriority(finding({ severity: "critical", impactAssessment: { ...impactAssessment, assessment_source: "heuristic" } })).assessed).toBe(false);
  });
});
