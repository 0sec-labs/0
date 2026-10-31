import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { osecDB } from "@0/db";
import { registerHistoryCommand } from "../history.js";
import { writePresentationLine } from "../../presentation/process-output.js";

vi.mock("../../presentation/process-output.js", () => ({ writePresentationLine: vi.fn() }));

let directory: string;
let dbPath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "history-command-"));
  dbPath = join(directory, "history.sqlite");
});
afterEach(() => { vi.clearAllMocks(); rmSync(directory, { recursive: true, force: true }); });

function command(): Command {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerHistoryCommand(program);
  return program;
}
function seed(count: number): void {
  const database = new osecDB(dbPath);
  try {
    for (let index = 0; index < count; index++) database.createScan({ target: `https://fixture-${index}.test`, depth: "quick", format: "json" });
  } finally { database.close(); }
}

describe("history CLI limits", () => {
  it.each(["0", "-1", "1.5", "2rows", "NaN", "Infinity", "9007199254740992", "0x10", " "])("rejects invalid limit %s before opening a database", async value => {
    await expect(command().parseAsync(["history", "--db-path", dbPath, "--limit", value], { from: "user" }))
      .rejects.toMatchObject({ code: "commander.invalidArgument" });
    expect(existsSync(dbPath)).toBe(false);
    expect(writePresentationLine).not.toHaveBeenCalled();
  });

  it("limits actual retained scan rows using a validated integer", async () => {
    seed(3);
    await command().parseAsync(["history", "--db-path", dbPath, "--limit", "2"], { from: "user" });
    expect(vi.mocked(writePresentationLine).mock.calls.filter(call => call[1] === "history.list.line")).toHaveLength(2);
  });

  it("keeps the default limit of ten scan rows", async () => {
    seed(12);
    await command().parseAsync(["history", "--db-path", dbPath], { from: "user" });
    expect(vi.mocked(writePresentationLine).mock.calls.filter(call => call[1] === "history.list.line")).toHaveLength(10);
  });
});
