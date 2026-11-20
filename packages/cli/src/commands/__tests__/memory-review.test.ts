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
  it("has no review step: no proposed command, and the list says nothing about proposals", async () => {
    const store = createFileNoteStore();
    store.add({ text: "Deploys use the staging flag", source: "model" });
    await run("memory", "list", "--json"); expect(json().notes).toHaveLength(1); expect(json()).not.toHaveProperty("proposed");
    await run("memory", "list"); expect(out.join("\n")).not.toMatch(/propos|review/i);
    await expect(run("memory", "proposed", "list")).rejects.toThrow();
  });
  it("refuses a note that would not fit what the model is shown, so a saved note is always one it sees", async () => {
    const store = createFileNoteStore();
    let saved = 0;
    for (let i = 0; i < 40; i++) {
      try { store.add({ text: `${String(i).padStart(2, "0")} ${"b".repeat(480)}`, source: "user" }); saved++; } catch { break; }
    }
    expect(saved).toBeGreaterThan(5); expect(saved).toBeLessThan(40);
    await run("memory", "add", `one more ${"c".repeat(480)}`, "--global"); expect(code).toBe(1); expect(err.join("")).toContain("Memory is full");
    await run("memory", "list", "--json"); expect(json().notes).toHaveLength(saved); expect(json()).not.toHaveProperty("overflow");
    await run("memory", "list"); expect(out.join("\n")).not.toMatch(/not shown|budget/i);
  });
  it("adds a user note (source user, live), refuses a secret", async () => {
    await run("memory", "add", "Use pnpm", "--global", "--json"); expect(json().note).toMatchObject({ source: "user" });
    await run("memory", "add", `key ${["sk", "abcdefghijklmnop", "qrstuvwxyz123456"].join("-")}`, "--global"); expect(code).toBe(1); expect(err.join("")).toContain("looks like a secret");
  });
  it("exports your notes to an AGENTS.md section, keeps hand-written text, and never imports back", async () => {
    const repo = join(work, "app"); mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: repo });
    const store = createFileNoteStore();
    store.add({ text: "Run pnpm test", folder: repo, kind: "command", source: "user" });
    store.add({ text: "Unreviewed model note", folder: repo, source: "model" });
    const target = join(repo, "AGENTS.md"); writeFileSync(target, "# Agents\n\nBe kind.\n");
    await run("memory", "export", "--folder", repo, "--to", target);
    const text = readFileSync(target, "utf8");
    expect(text).toContain("Be kind."); expect(text).toContain("- Run pnpm test"); expect(text).not.toContain("Unreviewed");
    expect(out.join("\n")).toContain("+ - Run pnpm test");
    await run("memory", "export", "--folder", repo, "--to", target); expect(readFileSync(target, "utf8")).toBe(text); // idempotent
    await run("memory", "export", "--folder", repo, "--markdown"); expect(out.join("\n")).toContain("## Notes from 0 memory");
    await run("memory", "export", "--folder", join(work, "empty"), "--to", join(work, "x.md")); expect(code).toBe(1);
    expect(store.list({ folder: repo })).toHaveLength(2); // nothing was read back from the file
  });
});

describe("folderPlace", () => {
  it("shows a repository as owner/name and a path whole, with the home directory as ~", async () => {
    const { folderPlace } = await import("../memory.js");
    expect(folderPlace("git:github.com/acme/app", "/Users/me")).toBe("acme/app");
    expect(folderPlace("/Users/me/code/app", "/Users/me")).toBe("~/code/app");
    expect(folderPlace("/private/tmp/work", "/Users/me")).toBe("/private/tmp/work");
  });
});
