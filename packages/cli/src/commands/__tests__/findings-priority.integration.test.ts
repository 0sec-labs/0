import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { osecDB } from "@0/db";
import type { ImpactAssessment } from "@0/shared";
import { registerFindingsCommand } from "../findings.js";
vi.mock("../../tui/runtime.js", () => ({ isBunRuntime: () => false, canUseOpenTui: () => false }));
const paths: string[] = [];
vi.mock("@0/db", async importOriginal => ({ ...await importOriginal<typeof import("@0/db")>(), listOsecRunDatabasePaths: () => paths, resolveOsecDbPath: () => paths[0] }));
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); paths.length = 0; for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "0-cli-priority-")); directories.push(directory);
  const path = join(directory, "history.db"); paths.push(path);
  const db = new osecDB(path);
  const scan = db.createScan({ target: "https://example.test", depth: "default", format: "json" });
  const sqlite = (db as unknown as { sqlite: { prepare(query: string): { run(...values: unknown[]): unknown }; transaction<T>(operation: () => T): () => T } }).sqlite;
  const statement = sqlite.prepare("INSERT INTO findings(id,scanId,templateId,title,description,severity,category,status,fingerprint,evidenceRequest,evidenceResponse,timestamp,impactAssessment) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  function insert(id: string, timestamp: number, priority: ImpactAssessment["business_impact"], family = id, severity = "critical") {
    const impact: ImpactAssessment = { reachability_tier: "remote-unauth", blast_radius: "Production payment approvals", weaponizability: "integrity-tampering", business_impact: priority, assessment_source: "provided", rationale: `Business rationale for ${id}` };
    statement.run(id, scan, "template", id, "Observed evidence", severity, "sql-injection", "confirmed", family, "request", "response", timestamp, JSON.stringify(impact));
  }
  return { db, path, insert, sqlite };
}
async function output(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  log.mockClear();
  const program = new Command(); registerFindingsCommand(program);
  await program.parseAsync(args, { from: "user" });
  return log.mock.calls.map(call => String(call[0])).join("\n");
}
describe("plain findings business-priority persistence", () => {
  it("selects an older urgent finding before the database/display limits rather than recent technical critical rows", async () => {
    const { db, path, insert, sqlite } = fixture();
    try { sqlite.transaction(() => { for (let n = 0; n < 1100; n++) insert(`recent-${String(n).padStart(4, "0")}`, 100 + n, "noise"); insert("older-urgent", 1, "headline", undefined, "low"); })(); }
    finally { db.close(); }
    const text = await output(["findings", "list", "--db-path", path, "--limit", "1"]);
    expect(text).toContain("older-urgent"); expect(text).not.toContain("recent-");
    expect(text).toContain("Business priority: Urgent"); expect(text).toContain("Business impact rationale:"); expect(text).toContain("Technical severity:");
    const detail = await output(["findings", "show", "older-urgent", "--db-path", path]);
    expect(detail).toContain("Business priority: Urgent");
    expect(detail.indexOf("Business impact rationale:")).toBeLessThan(detail.indexOf("Technical severity:"));
  });
  it("uses the latest cross-database assessment and exact family hit/scan counts before global priority ordering", async () => {
    const first = fixture(); const second = fixture();
    try {
      first.insert("old-urgent-shared", 1, "headline", "shared", "low");
      first.insert("legitimate-urgent", 2, "headline", "legitimate", "low");
      second.insert("new-low-shared", 100, "noise", "shared");
    } finally { first.db.close(); second.db.close(); }
    const text = await output(["findings", "list", "--limit", "2"]);
    expect(text.indexOf("legitimate-urgent")).toBeLessThan(text.indexOf("new-low-shared"));
    expect(text).not.toContain("old-urgent-shared"); expect(text).toContain("2 hits / 2 scans");
    expect(text.match(/fp:shared/g)).toHaveLength(1);
  });
  it("retains historical rows in --all and applies technical filters to those rows", async () => {
    const { db, path, insert } = fixture();
    try { insert("old-urgent-history", 1, "headline", "shared", "low"); insert("new-low-history", 100, "noise", "shared"); }
    finally { db.close(); }
    const text = await output(["findings", "list", "--all", "--db-path", path, "--limit", "2"]);
    expect(text.indexOf("old-urgent-history")).toBeLessThan(text.indexOf("new-low-history"));
    const filtered = await output(["findings", "list", "--all", "--db-path", path, "--severity", "low", "--limit", "2"]);
    expect(filtered).toContain("old-urgent-history"); expect(filtered).not.toContain("new-low-history");
  });
});
