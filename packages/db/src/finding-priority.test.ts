import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImpactAssessment } from "@0/shared";
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

describe("bounded business-priority database selection", () => {
  it("pages all latest family metadata without bodies or holding cursors between yields", () => {
    const { db, dbPath, sqlite, insert, first, second } = fixture();
    sqlite.transaction(() => { for (let n=0;n<510;n++) insert(`item-${String(n).padStart(4,"0")}`,n,null); })();
    insert("old-family",1,assessment("headline"),{family:"family",scanId:first});
    insert("new-family",2,assessment("noise"),{family:"family",scanId:second});
    const queries=vi.spyOn(sqlite,"prepare");
    const iterator=db.iterateLatestFindingMetadata();
    const firstRow=iterator.next().value;
    expect(firstRow).toBeDefined();
    const writer=new osecDB(dbPath);
    try { expect(writer.updateFindingImpactAssessment("old-family",assessment("modest"))).toBe(true); }
    finally { writer.close(); }
    const metadata=[firstRow,...iterator];
    expect(metadata).toHaveLength(511);
    expect(metadata.filter(row=>row.familyKey==="family").map(row=>row.id)).toEqual(["new-family"]);
    expect(metadata.every(row=>!("description" in row)&&!("evidenceRequest" in row))).toBe(true);
    expect(queries.mock.calls.some(([sql])=>sql.includes("SELECT * FROM findings"))).toBe(false);
    expect(db.getFindingFamilyMetadata("family")).toEqual({count:2,scanIds:[first,second].sort()});
    expect(db.getFindingFamilyMetadata("family",{scanId:first})).toEqual({count:1,scanIds:[first]});
  });
  it("reads priority queues while the engine control store remains open and releases locks for later writers", () => {
    const { db, dbPath, insert } = fixture();
    insert("urgent", 1, assessment("headline"));
    const control = new SecurityWorkflowStore(dbPath);
    let reopened: osecDB | undefined;
    try {
      const definition = control.save({ name: "Owned workflow", instructions: "", target: "https://example.test", nodes: [{ id: "start", type: "trigger", label: "Start", enabled: true }, { id: "audit", type: "audit", label: "Audit", enabled: true }], edges: [{ source: "start", target: "audit" }] });
      expect(control.get(definition.id)).toMatchObject({ id: definition.id });
      expect(db.listFindingFamiliesByBusinessPriority({ limit: 1 })[0].latest.id).toBe("urgent");
      expect(db.listFindingsByBusinessPriority({ limit: 1 })[0].id).toBe("urgent");
      reopened = new osecDB(dbPath);
      expect(reopened.updateFindingImpactAssessment("urgent", assessment("noise"))).toBe(true);
      expect(control.get(definition.id)).toMatchObject({ id: definition.id });
      expect(db.listFindingFamiliesByBusinessPriority({ limit: 1 })[0].latest.impactAssessment).toContain('"business_impact":"noise"');
    } finally { reopened?.close(); control.close(); }
  });
  it("selects an older urgent family beyond metadata pages before loading limited evidence bodies", () => {
    const { db, sqlite, insert } = fixture();
    sqlite.transaction(() => { for (let n = 0; n < 510; n++) insert(`new-${String(n).padStart(4, "0")}`, n + 100, assessment("noise"), { severity: "critical" }); insert("zz-old-urgent", 1, assessment("headline"), { severity: "low" }); })();
    const queries = vi.spyOn(sqlite, "prepare");
    const selected = db.listFindingFamiliesByBusinessPriority({ limit: 1 });
    expect(selected.map(item => item.latest.id)).toEqual(["zz-old-urgent"]);
    const bodyQueries = queries.mock.calls.map(([query]) => query).filter(query => /SELECT \* FROM findings/.test(query));
    expect(bodyQueries).toEqual(["SELECT * FROM findings WHERE id IN (?)"]);
    expect(queries.mock.calls.some(([query]) => query.includes("ORDER BY f.id LIMIT 500"))).toBe(true);
  });
  it("ranks only the latest family assessment and preserves historical counts, votes and active roles", () => {
    const { db, sqlite, insert, first, second } = fixture();
    insert("old", 1, assessment("headline"), { family: "family", scanId: first });
    insert("latest", 100, assessment("noise"), { family: "family", scanId: second });
    insert("other", 2, assessment("notable"));
    sqlite.prepare(`INSERT INTO verdicts(id,findingId,agentRole,verdict,timestamp) VALUES('old-vote','old','verifier','TRUE_POSITIVE',1),('new-vote','latest','verifier','FALSE_POSITIVE',2)`).run();
    for (const [id, scanId, agentRole] of [["session-old", first, "verifier"], ["session-new", second, "verifier"], ["research", first, "researcher"]]) db.saveSession({ id, scanId, agentRole, turnCount: 1, status: "running", messages: [{ private: "Must not enter priority metadata" }], toolContext: { secret: "context" } });
    const families = db.listFindingFamiliesByBusinessPriority({ limit: 2 });
    expect(families.map(item => item.key)).toEqual(["other", "family"]);
    const family = families[1];
    expect(family).toMatchObject({ latest: { id: "latest" }, count: 2, scanCount: 2, verdictCounts: { truePositive: 1, falsePositive: 1, unsure: 0, total: 2 } });
    expect(family.activeSessions.map(item => item.agentRole).sort()).toEqual(["researcher", "verifier"]);
    expect(family.activeSessions.every(item => !("messages" in item) && !("toolContext" in item))).toBe(true);
  });
  it("uses schema-validated business assessments rather than forged labels or heuristic severity baselines", () => {
    const { db, insert } = fixture();
    insert("forged", 3, { business_impact: "headline" }, { severity: "critical" });
    insert("heuristic", 2, { ...assessment("headline"), assessment_source: "heuristic" }, { severity: "critical" });
    insert("legitimate", 1, assessment("notable"), { severity: "low" });
    expect(db.listFindingFamiliesByBusinessPriority({ limit: 1 })[0].latest.id).toBe("legitimate");
  });
  it("does not discard valid multibyte schema-bounded rationale while ranking", () => {
    const { db, insert } = fixture();
    insert("unicode-urgent", 1, { ...assessment("headline"), rationale: "Affected customer records: " + "损".repeat(7900) }, { severity: "low" });
    insert("unknown", 2, null, { severity: "critical" });
    expect(db.listFindingFamiliesByBusinessPriority({ limit: 1 })[0].latest.id).toBe("unicode-urgent");
  });
  it("does not resurrect an obsolete family state when filtering by severity or status", () => {
    const { db, insert, first, second } = fixture();
    insert("old", 1, assessment("headline"), { family: "family", severity: "critical", status: "verified", scanId: first });
    insert("new", 2, assessment("noise"), { family: "family", severity: "low", scanId: second });
    expect(db.listFindingFamiliesByBusinessPriority({ severity: "critical" })).toEqual([]);
    expect(db.listFindingFamiliesByBusinessPriority({ status: "verified" })).toEqual([]);
    expect(db.listFindingFamiliesByBusinessPriority({ scanId: first, severity: "critical" })[0]).toMatchObject({ latest: { id: "old" }, count: 1, scanCount: 1 });
  });
  it("keeps historical rows independent for the native --all list while capping after global priority", () => {
    const { db, insert } = fixture();
    insert("old", 1, assessment("headline"), { family: "family" });
    insert("new", 2, assessment("noise"), { family: "family" });
    expect(db.listFindingsByBusinessPriority({ limit: 1 }).map(item => item.id)).toEqual(["old"]);
    expect(db.listFindingsByBusinessPriority({ limit: 2 }).map(item => item.id)).toEqual(["old", "new"]);
    expect(db.listFindingFamiliesByBusinessPriority({ limit: 1 }).map(item => item.latest.id)).toEqual(["new"]);
  });
  it("bounds malformed or oversized assessment reads and validates finite retrieval limits", () => {
    const { db, insert } = fixture();
    insert("large", 2, `${" ".repeat(90000)}${JSON.stringify(assessment("headline"))}`, { severity: "critical" });
    insert("valid", 1, assessment("notable"), { severity: "low" });
    expect(db.listFindingFamiliesByBusinessPriority({ limit: 1 })[0].latest.id).toBe("valid");
    expect(db.listFindingFamiliesByBusinessPriority({ limit: 0 })).toEqual([]);
    expect(() => db.listFindingFamiliesByBusinessPriority({ limit: -1 })).toThrow("0 and 5000");
    expect(() => db.listFindingsByBusinessPriority({ limit: 5001 })).toThrow("0 and 5000");
  });
});
