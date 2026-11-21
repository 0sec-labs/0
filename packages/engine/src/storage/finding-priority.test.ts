import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImpactAssessment } from "../shared/index.js";
import { SecurityWorkflowStore } from "./security-workflows.js";
import { osecDB } from "./database.js";
import type { ShimmedDatabase } from "./wasm-shim.js";
const fixtures: Array<{ db: osecDB; path: string }> = [];
afterEach(() => { vi.restoreAllMocks(); for (const { db, path } of fixtures.splice(0)) { db.close(); rmSync(path, { recursive: true, force: true }); } });
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "0-priority-db-"));
  const db = new osecDB(join(path, "history.db")); fixtures.push({ db, path });
  const first = db.createScan({ target: "https://example.test", depth: "default", format: "json" });
  const second = db.createScan({ target: "https://example.test", depth: "default", format: "json" });
  const sqlite = (db as unknown as { sqlite: ShimmedDatabase }).sqlite;
  const statement = sqlite.prepare(`INSERT INTO findings(id,scanId,templateId,title,description,severity,category,status,fingerprint,evidenceRequest,evidenceResponse,timestamp,impactAssessment) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insert = (id: string, timestamp: number, assessment: unknown, opts: { scanId?: string; family?: string; severity?: string; status?: string } = {}) => statement.run(id, opts.scanId ?? first, "fixture", id, "Body should only load after ranking", opts.severity ?? "high", "other", opts.status ?? "discovered", opts.family ?? id, "Sensitive evidence", "response", timestamp, assessment === null ? null : typeof assessment === "string" ? assessment : JSON.stringify(assessment));
  return { db, sqlite, insert, first, second, dbPath: join(path, "history.db") };
}
function assessment(business_impact: ImpactAssessment["business_impact"]): ImpactAssessment {
  return { business_impact, reachability_tier: "remote-auth", blast_radius: "Customer billing records", weaponizability: "info-leak", rationale: "Billing records of other tenants can be read from the deployed service.", assessment_source: "provided" };
}

describe("database selection by severity", () => {
  it("orders families by severity then recency, whatever their impact assessment says, and counts every occurrence", () => {
    const { db, insert, first, second } = fixture();
    insert("old-shared", 100, assessment("headline"), { family: "shared", scanId: first, severity: "low" });
    insert("new-shared", 200, assessment("noise"), { family: "shared", scanId: second, severity: "low" });
    insert("critical-alone", 50, null, { family: "alone", scanId: first, severity: "critical" });
    insert("high-recent", 300, null, { family: "recent", scanId: second, severity: "high" });
    const families = db.listFindingFamiliesBySeverity({ limit: 10 });
    expect(families.map(family => family.latest.id)).toEqual(["critical-alone", "high-recent", "new-shared"]);
    expect(families.find(family => family.key === "shared")).toMatchObject({ count: 2, scanCount: 2 });
  });
  it("applies the limit after the global ordering, so an old critical finding is not pushed out by recent low ones", () => {
    const { db, sqlite, insert, first } = fixture();
    // More than one metadata page of recent low findings, in one transaction so the test stays fast.
    sqlite.transaction(() => { for (let n = 0; n < 600; n++) insert(`recent-${String(n).padStart(4, "0")}`, 1000 + n, null, { scanId: first, severity: "low" }); })();
    insert("older-critical", 1, null, { scanId: first, severity: "critical" });
    expect(db.listFindingFamiliesBySeverity({ limit: 1 })[0]?.latest.id).toBe("older-critical");
    expect(db.listFindingsBySeverity({ limit: 1 })[0]?.id).toBe("older-critical");
  });
  it("validates the limit and applies filters", () => {
    const { db, insert, first } = fixture();
    insert("a", 1, null, { scanId: first, severity: "high" }); insert("b", 2, null, { scanId: first, severity: "low" });
    expect(db.listFindingsBySeverity({ severity: "low", limit: 5 }).map(row => row.id)).toEqual(["b"]);
    expect(() => db.listFindingsBySeverity({ limit: -1 })).toThrow();
  });
});
