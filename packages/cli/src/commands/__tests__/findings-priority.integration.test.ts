import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { osecDB } from "@0/engine/storage";
import { registerFindingsCommand } from "../findings.js";
vi.mock("../../state/runtime.js", () => ({ isBunRuntime: () => false, canUseOpenTui: () => false }));
const paths: string[] = [];
vi.mock("@0/engine/storage", async importOriginal => ({ ...await importOriginal<typeof import("@0/engine/storage")>(), listOsecRunDatabasePaths: () => paths, resolveOsecDbPath: () => paths[0] }));
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); paths.length = 0; for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "0-cli-priority-")); directories.push(directory);
  const path = join(directory, "history.db"); paths.push(path);
  const db = new osecDB(path);
  const scan = db.createScan({ target: "https://example.test", depth: "default", format: "json" });
  const sqlite = (db as unknown as { sqlite: { prepare(query: string): { run(...values: unknown[]): unknown }; transaction<T>(operation: () => T): () => T } }).sqlite;
  const statement = sqlite.prepare("INSERT INTO findings(id,scanId,templateId,title,description,severity,category,status,fingerprint,evidenceRequest,evidenceResponse,timestamp,impactAssessment) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  function insert(id: string, timestamp: number, family = id, severity = "low") {
    statement.run(id, scan, "template", id, "Observed evidence", severity, "sql-injection", "confirmed", family, "request", "response", timestamp, null);
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
describe("plain findings ordering", () => {
  it("lists the most severe finding first, beyond the database and display limits", async () => {
    const { db, path, insert, sqlite } = fixture();
    try { sqlite.transaction(() => { for (let n = 0; n < 1100; n++) insert(`recent-${String(n).padStart(4, "0")}`, 100 + n); insert("older-critical", 1, undefined, "critical"); })(); }
    finally { db.close(); }
    const text = await output(["findings", "list", "--db-path", path, "--limit", "1"]);
    expect(text).toContain("older-critical"); expect(text).not.toContain("recent-");
    expect(text).toContain("Technical severity:"); expect(text).not.toContain("Business priority");
    const detail = await output(["findings", "show", "older-critical", "--db-path", path]);
    expect(detail).toContain("Technical severity:"); expect(detail).not.toContain("Business");
  });
  it("uses the latest occurrence across databases, with exact family hit and scan counts, before ordering", async () => {
    const first = fixture(); const second = fixture();
    try {
      first.insert("old-shared", 1, "shared", "low");
      first.insert("legitimate-high", 2, "legitimate", "high");
      second.insert("new-shared", 100, "shared", "low");
    } finally { first.db.close(); second.db.close(); }
    const text = await output(["findings", "list", "--limit", "2"]);
    expect(text.indexOf("legitimate-high")).toBeLessThan(text.indexOf("new-shared"));
    expect(text).not.toContain("old-shared"); expect(text).toContain("2 hits / 2 scans");
    expect(text.match(/fp:shared/g)).toHaveLength(1);
  });
  it("retains historical rows in --all and applies filters to those rows", async () => {
    const { db, path, insert } = fixture();
    try { insert("old-low-history", 1, "shared", "low"); insert("new-high-history", 100, "shared", "high"); }
    finally { db.close(); }
    const text = await output(["findings", "list", "--all", "--db-path", path, "--limit", "2"]);
    expect(text.indexOf("new-high-history")).toBeLessThan(text.indexOf("old-low-history"));
    const filtered = await output(["findings", "list", "--all", "--db-path", path, "--severity", "low", "--limit", "2"]);
    expect(filtered).toContain("old-low-history"); expect(filtered).not.toContain("new-high-history");
  });
});
