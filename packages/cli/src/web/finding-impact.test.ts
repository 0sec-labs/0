import { afterEach, describe, expect, it } from "vitest";
import { osecDB } from "@0/db";
import type { Finding } from "@0/shared";
import { handleFindingImpactRequest } from "./finding-impact.js";
const databases: osecDB[] = [];
const assessment = { reachability_tier: "remote-auth", blast_radius: "Customer payment records", weaponizability: "info-leak", business_impact: "headline", rationale: "Customer billing service exposes records.", assessment_source: "model" };
function fixture() {
  const db = new osecDB(":memory:"); databases.push(db);
  db.createScan({ target: "https://example.test", depth: "default", format: "json" }, "scan");
  db.saveFinding("scan", { id: "finding-1", templateId: "test", title: "Leak", description: "Evidence", severity: "medium", category: "other", status: "discovered", evidence: { request: "GET /billing HTTP/1.1", response: "Response" }, timestamp: Date.now() } as Finding);
  return db;
}
const route = "/api/findings/finding-1/impact-assessment";
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
describe("operator finding business impact endpoint", () => {
  it("normalizes operator provenance and clears metadata without modifying technical state", () => {
    const db = fixture(); const before = db.getFinding("finding-1")!;
    expect(handleFindingImpactRequest(route, "POST", assessment, { db })).toEqual({ status: 200, data: { findingId: "finding-1", impactAssessment: { ...assessment, assessment_source: "provided" } } });
    const { impactAssessment: _impact, ...technical } = db.getFinding("finding-1")!;
    const { impactAssessment: _original, ...expected } = before;
    expect(technical).toEqual(expected);
    expect(handleFindingImpactRequest(route, "DELETE", {}, { db })).toEqual({ status: 200, data: { findingId: "finding-1", impactAssessment: null } });
    expect(db.getFinding("finding-1")).toEqual({ ...before, impactAssessment: null });
  });
  it("rejects malformed metadata and authority fields before writes", () => {
    const db = fixture(); const before = db.getFinding("finding-1");
    for (const input of [null, [], {}, { ...assessment, business_impact: "urgent" }, { ...assessment, blast_radius: " " }, { ...assessment, rationale: "x".repeat(8193) }, { ...assessment, severity: "critical" }, { ...assessment, dbPath: "/other.db" }, { ...assessment, approval: true }, { ...assessment, verification_result: { status: "reproduced" } }]) {
      expect(handleFindingImpactRequest(route, "POST", input, { db })?.status).toBe(400);
      expect(db.getFinding("finding-1")).toEqual(before);
    }
    expect(handleFindingImpactRequest(route, "DELETE", { severity: "critical" }, { db })?.status).toBe(400);
  });
  it("limits updates to exact IDs in the selected engine and handles route/method errors", () => {
    const db = fixture(); const other = new osecDB(":memory:"); databases.push(other);
    expect(handleFindingImpactRequest(route, "POST", assessment, { db: other })?.status).toBe(404);
    expect(handleFindingImpactRequest("/api/findings/finding/impact-assessment", "POST", assessment, { db })?.status).toBe(404);
    expect(handleFindingImpactRequest(route, "GET", undefined, { db })?.status).toBe(405);
    expect(handleFindingImpactRequest("/api/findings/%GG/impact-assessment", "POST", assessment, { db })?.status).toBe(400);
    expect(handleFindingImpactRequest("/api/findings/finding-1", "POST", assessment, { db })).toBeNull();
    expect(db.getFinding("finding-1")?.impactAssessment).toBeNull();
  });
});
