import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { osecDB } from "@0/engine/storage";
import { importSarif, prepareSarifImport } from "./report-import.js";

const sarif = (results: unknown[]) => JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "foxguard", version: "0.14.0" } }, results }] });
const result = (ruleId: string, uri: string, line: number, level = "error") => ({ ruleId, level, message: { text: `${ruleId} at ${line}` }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }] });

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const database = () => { const dir = mkdtempSync(join(tmpdir(), "0-sarif-")); directories.push(dir); return join(dir, "0.db"); };

describe("SARIF import", () => {
  it("stores findings with the scanner, location and an unverified status", () => {
    const dbPath = database();
    const outcome = importSarif({ sarifJson: sarif([result("js/sqli", "src/db.ts", 10), result("js/xss", "src/ui.ts", 4, "warning")]), dbPath });
    expect(outcome).toMatchObject({ findings: 2, alreadyImported: false });
    const db = new osecDB(dbPath);
    try {
      const rows = db.getFindings(outcome.scanId);
      expect(rows.map(row => [row.tool, row.severity])).toEqual(expect.arrayContaining([["foxguard", "high"], ["foxguard", "medium"]]));
      expect(db.getFindingReviewFields(rows[0]!.id).reviewAnnotation?.path).toMatch(/^src\//);
      expect(rows.every(row => row.triageStatus === "new" && row.workflowStatus === "backlog")).toBe(true);
    } finally { db.close(); }
  });

  it("importing the same file twice leaves the same findings", () => {
    const dbPath = database();
    const text = sarif([result("r", "a.ts", 1), result("r", "a.ts", 2)]);
    const first = importSarif({ sarifJson: text, dbPath });
    const second = importSarif({ sarifJson: text, dbPath });
    expect(second.alreadyImported).toBe(true);
    expect(second.scanId).toBe(first.scanId);
    const db = new osecDB(dbPath);
    try { expect(db.getFindings(first.scanId)).toHaveLength(2); } finally { db.close(); }
  });

  it("keeps two results of the same rule at the same place apart, and takes a --tool label", () => {
    const prepared = prepareSarifImport(sarif([result("r", "a.ts", 1), result("r", "a.ts", 1)]), { tool: "ci-sast" });
    expect(prepared.findings).toHaveLength(2);
    expect(new Set(prepared.findings.map(finding => finding.id)).size).toBe(2);
    expect(prepared.findings.every(finding => finding.tool === "ci-sast")).toBe(true);
  });

  it("refuses a file that is not SARIF", () => {
    expect(() => prepareSarifImport(JSON.stringify({ findings: [] }))).toThrow("not a SARIF log");
  });
});
