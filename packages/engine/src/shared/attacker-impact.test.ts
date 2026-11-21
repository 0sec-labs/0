import { describe, expect, it } from "vitest";
import { attackerImpactSentence, describeAttackerImpact } from "./attacker-impact.js";

const assessed = { reachability_tier: "remote-unauth", blast_radius: "An unauthenticated caller can run any shell command as the service account.", weaponizability: "rce", business_impact: "headline", rationale: "exec() takes req.body.host unchecked" };

describe("what an attacker can do", () => {
  it("states who, what and the outcome for an assessed finding", () => {
    expect(describeAttackerImpact({ impactAssessment: assessed })).toEqual({
      can: "An unauthenticated caller can run any shell command as the service account.",
      who: "anyone who can reach it over the network, without logging in", gets: "run their own code",
    });
    expect(attackerImpactSentence({ impactAssessment: assessed })).toContain("They can: run their own code.");
  });
  it("says nothing when there is no assessment, a malformed one, or only a heuristic guess", () => {
    expect(describeAttackerImpact({})).toBeUndefined();
    expect(describeAttackerImpact({ impactAssessment: { blast_radius: "" } })).toBeUndefined();
    expect(describeAttackerImpact({ impactAssessment: "text" })).toBeUndefined();
    expect(describeAttackerImpact({ impactAssessment: { ...assessed, assessment_source: "heuristic" } })).toBeUndefined();
  });
});
