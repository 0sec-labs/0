// `0 findings triage ...` (hidden alias kept for one release): false-positive reasons become
// notes in the one Memory. The findings database is faked; Memory is real, under a temp HOME.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as Array<{ id: string; title: string; category: string }>, triaged: [] as unknown[][] }));
vi.mock("@0/engine/storage", () => ({
  osecDB: class { listFindings() { return db.rows; } updateFindingTriage(...args: unknown[]) { db.triaged.push(args); } close() {} },
}));

import { registerTriageCommand } from "../triage.js";

let home: string; let saved: string | undefined; let out: string[]; let err: string[];
beforeEach(() => {
  saved = process.env.HOME; home = mkdtempSync(join(tmpdir(), "triage-")); process.env.HOME = home;
  db.rows = [{ id: "f1aaaaaa", title: "Reflected XSS", category: "xss" }, { id: "f1bbbbbb", title: "SQLi", category: "sqli" }]; db.triaged = [];
  out = []; err = []; process.exitCode = 0;
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { err.push(a.join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; rmSync(home, { recursive: true, force: true }); process.exitCode = 0; });

const run = async (...args: string[]) => { const program = new Command().exitOverride(); registerTriageCommand(program); await program.parseAsync(["node", "0", "triage", ...args, "--db-path", join(home, "x.db")]); };

describe("triage memory aliases", () => {
  it("adds a false-positive note, lists it and removes it", async () => {
    await run("memory", "add", "--finding", "f1a", "--reason", "React escapes output");
    expect(out.join("\n")).toContain("Remembered m_");
    out.length = 0; await run("memory", "list");
    const line = out.join("\n"); expect(line).toContain("Reflected XSS"); expect(line).toContain("React escapes output");
    const id = /m_[a-z0-9]+/.exec(line)![0]; out.length = 0;
    await run("memory", "remove", id); expect(out.join("\n")).toContain("Forgot");
    out.length = 0; await run("memory", "list"); expect(out.join("\n")).toContain("Nothing remembered yet.");
  });
  it("reports an ambiguous or unknown finding and writes nothing", async () => {
    await run("memory", "add", "--finding", "f1", "--reason", "r"); expect(err.join("")).toContain("ambiguous"); expect(process.exitCode).toBe(1);
    await run("memory", "add", "--finding", "zzz", "--reason", "r"); expect(err.join("")).toContain("not found");
    out.length = 0; await run("memory", "list"); expect(out.join("\n")).toContain("Nothing remembered yet.");
  });
  it("mark-fp suppresses the finding and remembers why", async () => {
    await run("mark-fp", "f1bbbbbb", "--reason", "parameterized");
    expect(db.triaged).toEqual([["f1bbbbbb", "suppressed", "parameterized"]]);
    out.length = 0; await run("memory", "list"); expect(out.join("\n")).toContain("parameterized");
  });
});
