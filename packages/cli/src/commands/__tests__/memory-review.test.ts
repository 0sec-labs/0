import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileNoteStore } from "@0/engine";
import { registerMemoryCommand } from "../memory.js";
import type { CommandIo } from "../console-output.js";

let home: string; let work: string; let savedHome: string | undefined; let db: string;
const out: string[] = []; const err: string[] = []; let code = 0;
const io: CommandIo = { out: line => out.push(line), err: line => err.push(line), setExitCode: value => { code = value; } };

beforeEach(() => {
  savedHome = process.env.HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), "memrev-home-"))); work = realpathSync(mkdtempSync(join(tmpdir(), "memrev-work-")));
  process.env.HOME = home; db = join(home, "test.db");
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
});
async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerMemoryCommand(program, io);
  out.length = 0; err.length = 0; code = 0;
  await program.parseAsync(["node", "0", ...args, "--db-path", db]);
}
const json = () => JSON.parse(out.join("\n"));

describe("0 memory review and export", () => {
  it("lists, accepts (with edited text) and rejects proposed notes; proposals are not in the live list", async () => {
    const store = createFileNoteStore();
    const a = store.add({ text: "Deploys use the staging flag", source: "model", status: "proposed", tainted: true });
    const b = store.add({ text: "Skip the flaky suite", source: "model", status: "proposed" });
    await run("memory", "list", "--json"); expect(json()).toMatchObject({ notes: [], proposed: 2 });
    await run("memory", "list"); expect(out.join("\n")).toContain("2 proposed notes waiting for review");
    await run("memory", "proposed", "list", "--json"); expect(json().notes.map((n: { id: string }) => n.id).sort()).toEqual([a.id, b.id].sort());
    await run("memory", "proposed", "accept", a.id, "--text", "Deploys use the --staging flag", "--json");
    expect(json().note).toMatchObject({ status: "live", reviewed: true, text: "Deploys use the --staging flag" });
    await run("memory", "proposed", "reject", b.id); expect(out.join("")).toContain(`Rejected ${b.id}`);
    await run("memory", "proposed", "reject", b.id); expect(code).toBe(1);
    await run("memory", "proposed", "accept", "m_nothere"); expect(code).toBe(1);
    await run("memory", "list", "--json"); expect(json()).toMatchObject({ proposed: 0 }); expect(json().notes).toHaveLength(1);
  });
  it("says how many notes were left out of what the model sees, and why", async () => {
    const store = createFileNoteStore();
    store.add({ text: "a".repeat(490), source: "user", created: "2026-01-01T00:00:00.000Z" });
    for (let i = 0; i < 20; i++) store.add({ text: `${String(i).padStart(2, "0")} ${"b".repeat(480)}`, source: "user", created: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` });
    await run("memory", "list", "--json");
    const body = json(); expect(body.overflow.count).toBeGreaterThan(0); expect(body.overflow.reason).toContain("budget");
    await run("memory", "list"); expect(out.join("\n")).toMatch(/\* \d+ notes? not shown \(memory budget full\)\. Not shown to the model/);
  });
  it("adds a user note (source user, live), refuses a secret", async () => {
    await run("memory", "add", "Use pnpm", "--global", "--json"); expect(json().note).toMatchObject({ source: "user", status: "live" });
    await run("memory", "add", `key ${["sk", "abcdefghijklmnop", "qrstuvwxyz123456"].join("-")}`, "--global"); expect(code).toBe(1); expect(err.join("")).toContain("looks like a secret");
  });
  it("exports accepted notes to an AGENTS.md section, keeps hand-written text, and never imports back", async () => {
    const repo = join(work, "app"); mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: repo });
    const store = createFileNoteStore();
    store.add({ text: "Run pnpm test", folder: repo, kind: "command", source: "user" });
    store.add({ text: "Unreviewed model note", folder: repo, source: "model" });
    store.add({ text: "Proposed note", folder: repo, source: "model", status: "proposed" });
    const target = join(repo, "AGENTS.md"); writeFileSync(target, "# Agents\n\nBe kind.\n");
    await run("memory", "export", "--folder", repo, "--to", target);
    const text = readFileSync(target, "utf8");
    expect(text).toContain("Be kind."); expect(text).toContain("- Run pnpm test"); expect(text).not.toContain("Unreviewed"); expect(text).not.toContain("Proposed note");
    expect(out.join("\n")).toContain("+ - Run pnpm test");
    await run("memory", "export", "--folder", repo, "--to", target); expect(readFileSync(target, "utf8")).toBe(text); // idempotent
    await run("memory", "export", "--folder", repo, "--markdown"); expect(out.join("\n")).toContain("## Notes from 0 memory");
    await run("memory", "export", "--folder", join(work, "empty"), "--to", join(work, "x.md")); expect(code).toBe(1);
    expect(store.list({ folder: repo })).toHaveLength(2); // nothing was read back from the file
  });
});
