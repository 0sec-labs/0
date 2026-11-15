import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerReportsCommand } from "../reports.js";
import { importCiReport } from "../../report-import.js";
import { assertLocalEngineAvailable } from "../../local-engine.js";
vi.mock("../../report-import.js", () => ({ importCiReport: vi.fn() }));
vi.mock("../../local-engine.js", () => ({ assertLocalEngineAvailable: vi.fn() }));
let directory: string;
function program() { const root = new Command().exitOverride().configureOutput({writeErr: () => {}}); registerReportsCommand(root); return root; }
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "0-report-command-")); vi.mocked(importCiReport).mockReturnValue({scanId: "ci-fixture", alreadyImported: false, dbPath: join(directory,"workspace.db")}); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); rmSync(directory, { recursive: true, force: true }); });
describe("reports import command", () => {
  it("requires explicit destination before touching a database", async () => {
    await expect(program().parseAsync(["reports", "import", "missing.json"], {from:"user"})).rejects.toThrow();
    expect(importCiReport).not.toHaveBeenCalled();
  });
  it("reads report and metadata and checks destination engine ownership", async () => {
    const report = join(directory,"report.json"), metadata = join(directory,"run.json"), dbPath = join(directory,"workspace.db");
    writeFileSync(report,'{"findings":[]}'); writeFileSync(metadata,'{"schemaVersion":1}');
    await program().parseAsync(["reports","import",report,"--metadata",metadata,"--db-path",dbPath],{from:"user"});
    expect(assertLocalEngineAvailable).toHaveBeenCalledWith(dbPath);
    expect(importCiReport).toHaveBeenCalledWith({reportJson:'{"findings":[]}',metadataJson:'{"schemaVersion":1}',dbPath});
  });
  it("rejects directories as artifacts before an import", async () => {
    const folder=join(directory,"folder"); mkdirSync(folder);
    await expect(program().parseAsync(["reports","import",folder,"--db-path",join(directory,"x.db")],{from:"user"})).rejects.toThrow("regular file");
    expect(importCiReport).not.toHaveBeenCalled();
  });
  it("refuses to write a destination owned by a live engine", async () => {
    const report=join(directory,"report.json"),dbPath=join(directory,"x.db");writeFileSync(report,"{}");
    vi.mocked(assertLocalEngineAvailable).mockImplementationOnce(() => {throw new Error("Engine is running");});
    await expect(program().parseAsync(["reports","import",report,"--db-path",dbPath],{from:"user"})).rejects.toThrow("running");
    expect(importCiReport).not.toHaveBeenCalled();expect(existsSync(dbPath)).toBe(false);
  });
});

describe("reports export command", () => {
  const scanReport = { target: "/Users/me/app", scanDepth: "quick", startedAt: "2026-11-14T00:00:00.000Z", completedAt: "2026-11-14T00:00:01.000Z", durationMs: 1000,
    summary: { totalAttacks: 1, totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 }, warnings: [],
    findings: [{ id: "f1", templateId: "t", title: "Finding", description: "quotes SECRET", severity: "high", category: "xss", status: "confirmed", evidence: { response: "SECRET" } }] };
  it("prints a share-safe report without evidence, descriptions or local paths", async () => {
    const report = join(directory, "report.json"); writeFileSync(report, JSON.stringify(scanReport));
    await program().parseAsync(["reports", "export", report], { from: "user" });
    const printed = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(printed).not.toContain("SECRET"); expect(printed).not.toContain("/Users/me");
    expect(JSON.parse(printed)).toMatchObject({ schemaVersion: 1, kind: "0.share-safe-report", target: "app" });
  });
  it("includes descriptions only on request and can write a private file", async () => {
    const report = join(directory, "report.json"), out = join(directory, "share.json"); writeFileSync(report, JSON.stringify(scanReport));
    await program().parseAsync(["reports", "export", report, "--include-description", "--output", out], { from: "user" });
    expect(readFileSync(out, "utf8")).toContain("quotes SECRET");
    expect(console.log).not.toHaveBeenCalled();
  });
  it("rejects files that are not scan reports", async () => {
    const report = join(directory, "report.json"); writeFileSync(report, '{"findings":[]}');
    await expect(program().parseAsync(["reports", "export", report], { from: "user" })).rejects.toThrow("Not a 0 scan report");
  });
});
