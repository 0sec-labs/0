import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
