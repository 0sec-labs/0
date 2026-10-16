import { describe, expect, it } from "vitest";
import type { Finding, ImpactAssessment } from "@0/shared";
import { osecDB } from "./database.js";
const assessment: ImpactAssessment = { reachability_tier: "remote-auth", blast_radius: "Customer billing records", weaponizability: "info-leak", business_impact: "headline", rationale: "Production service affects paying customers.", assessment_source: "provided" };
function fixture() {
  const db = new osecDB(":memory:");
  db.createScan({ target: "https://example.test", depth: "default", format: "json", runtime: "api" }, "scan");
  db.saveFinding("scan", { id: "finding", templateId: "test", title: "Leak", description: "Evidence", severity: "medium", cvssScore: 5.4, category: "sensitive-data-exposure", status: "verified", evidence: { request: "request", response: "response" }, timestamp: Date.now(), verification_result: { status: "reproduced", finding_id: "finding" }, reviewAnnotation: "Operator reviewed original evidence" } as unknown as Finding);
  return db;
}
describe("finding impact metadata persistence", () => {
  it("changes the business-priority queue after an operator assessment and clear", () => {
    const db = fixture();
    try {
      db.saveFinding("scan", { id: "technical-critical", templateId: "critical-test", title: "Critical technical issue", description: "Different evidence", severity: "critical", category: "other", status: "discovered", evidence: { request: "GET /development HTTP/1.1", response: "Crash" }, timestamp: Date.now() } as Finding);
      expect(db.listFindingsByBusinessPriority({ limit: 1 })[0]?.id).toBe("technical-critical");
      db.updateFindingImpactAssessment("finding", assessment);
      expect(db.listFindingsByBusinessPriority({ limit: 1 })[0]?.id).toBe("finding");
      db.updateFindingImpactAssessment("finding", null);
      expect(db.listFindingsByBusinessPriority({ limit: 1 })[0]?.id).toBe("technical-critical");
    } finally { db.close(); }
  });
  it("updates and clears only impact assessment, preserving technical evidence and gates", () => {
    const db = fixture();
    try {
      const before = db.getFinding("finding")!;
      expect(db.updateFindingImpactAssessment("finding", assessment)).toBe(true);
      const updated = db.getFinding("finding")!;
      expect(JSON.parse(updated.impactAssessment!)).toEqual(assessment);
      const { impactAssessment: _before, ...original } = before;
      const { impactAssessment: _after, ...rest } = updated;
      expect(rest).toEqual(original);
      expect(db.updateFindingImpactAssessment("finding", null)).toBe(true);
      expect(db.getFinding("finding")).toEqual({ ...before, impactAssessment: null });
    } finally { db.close(); }
  });
  it("rejects malformed assessment before writing and does not affect unknown rows", () => {
    const db = fixture();
    try {
      const before = db.getFinding("finding");
      expect(() => db.updateFindingImpactAssessment("finding", { ...assessment, business_impact: "certain" } as unknown as ImpactAssessment)).toThrow();
      expect(db.getFinding("finding")).toEqual(before);
      expect(db.updateFindingImpactAssessment("missing", assessment)).toBe(false);
      expect(db.updateFindingImpactAssessment("missing", null)).toBe(false);
    } finally { db.close(); }
  });
});
