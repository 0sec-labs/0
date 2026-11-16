import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkillsCommand } from "../skills.js";
import type { CommandIo } from "../console-output.js";

let home: string; let savedHome: string | undefined; const made: string[] = [];
const out: string[] = []; const err: string[] = []; let code = 0;
const io: CommandIo = { out: line => out.push(line), err: line => err.push(line), setExitCode: value => { code = value; } };
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function repo(): { dir: string; shas: string[] } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ext-cli-repo-"))); made.push(dir); git(dir, "init", "-q", "-b", "main"); const shas: string[] = [];
  const commit = (files: Record<string, string>) => { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); } git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "c"); shas.push(git(dir, "rev-parse", "HEAD")); };
  commit({ "extension.json": JSON.stringify({ name: "demo", version: "1.0.0", description: "Demo extension" }), "skills/a/SKILL.md": "---\nname: a\ndescription: A\n---\nhi\n" });
  commit({ "scripts/go.sh": "#!/bin/sh\necho hi\n" });
  return { dir, shas };
}

const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
/** Approvals need no agent marker; these tests run without a terminal (as CI does) unless a test says otherwise. */
const operatorAtTerminal = (on: boolean) => { Object.defineProperty(process.stdin, "isTTY", { value: on, configurable: true }); };
beforeEach(() => { operatorAtTerminal(false); delete process.env.ZERO_AGENT_SESSION; savedHome = process.env.HOME; home = realpathSync(mkdtempSync(join(tmpdir(), "ext-cli-home-"))); process.env.HOME = home; out.length = 0; err.length = 0; code = 0; });
afterEach(() => { if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty); else delete (process.stdin as { isTTY?: boolean }).isTTY; delete process.env.ZERO_AGENT_SESSION; if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; rmSync(home, { recursive: true, force: true }); for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function run(...args: string[]): Promise<string> {
  out.length = 0; err.length = 0; code = 0;
  const program = new Command().exitOverride(); registerSkillsCommand(program, io);
  await program.parseAsync(["node", "0", "skills", ...args]);
  return [...out, ...err].join("\n");
}

describe("0 skills add / 0 skills extensions (local fixture repo, temp HOME)", () => {
  it("shows one prompt, installs the exact pinned revision on --yes, lists, updates with a diff, disables and removes", async () => {
    const r = repo();
    const prompt = await run("add", `${r.dir}@${r.shas[0]}`);
    expect(code).toBe(2); expect(prompt).toContain(`${r.dir} @ ${r.shas[0]}`); expect(prompt).toContain("It can:"); expect(prompt).toContain("Re-run with --yes");
    expect(existsSync(join(home, ".0", "extensions", "demo"))).toBe(false);

    const unpinned = await run("add", r.dir, "--yes"); // local folder is fine; a git url without sha is not (covered below)
    expect(code).toBe(0); expect(unpinned).toContain("Installed extension demo"); await run("extensions", "remove", "demo", "--yes");

    expect(await run("add", `${r.dir}@${r.shas[0]}`, "--yes", "--enable")).toContain(`Installed extension demo at ${r.shas[0]!.slice(0, 12)}`);
    expect(existsSync(join(home, ".0", "extensions", "demo", r.shas[0]!, "extension.json"))).toBe(true);
    const list = await run("extensions", "list"); expect(list).toMatch(/demo\s+git\s+enabled/); expect(list).toMatch(/scope\s+built-in/);
    expect(await run("extensions", "info", "demo")).toContain("Demo extension");

    const diff = await run("extensions", "update", "demo", "--to", r.shas[1]!);
    expect(code).toBe(2); expect(diff).toContain("Changes since the approved version"); expect(diff).toContain("runs commands: scripts/go.sh"); expect(diff).toContain("+ echo hi");
    await run("extensions", "update", "demo", "--yes"); expect(code).toBe(2);
    expect(await run("extensions", "update", "demo", "--to", r.shas[1]!, "--yes")).toContain(`Updated demo to ${r.shas[1]!.slice(0, 12)}`);
    expect(JSON.parse(await run("extensions", "list", "--json")).extensions.find((e: { name: string }) => e.name === "demo").revision).toBe(r.shas[1]);

    await run("extensions", "disable", "demo"); expect(await run("extensions", "list")).toMatch(/demo\s+git\s+disabled/);
    await run("extensions", "remove", "demo"); expect(code).toBe(2);
    await run("extensions", "remove", "demo", "--yes"); expect(code).toBe(0); expect(existsSync(join(home, ".0", "extensions", "demo"))).toBe(false);
  });

  it("marks an enabled extension refused in the list once its files change on disk", async () => {
    const r = repo();
    await run("add", `${r.dir}@${r.shas[0]}`, "--yes", "--enable");
    expect(await run("extensions", "list")).toMatch(/demo\s+git\s+enabled/);
    writeFileSync(join(home, ".0", "extensions", "demo", r.shas[0]!, "skills", "a", "SKILL.md"), "tampered\n");
    const list = await run("extensions", "list");
    expect(list).toMatch(/demo\s+git\s+refused/); expect(list).toContain("differs from the pinned revision");
  });

  it("refuses bad pins, built-in removal and unconfirmed built-in disable", async () => {
    const r = repo();
    expect(await run("add", `${r.dir}@${r.shas[0]!.slice(0, 7)}`, "--yes")).toContain("full 40-character"); expect(code).toBe(1);
    await run("extensions", "remove", "scope", "--yes"); expect(code).toBe(1);
    expect(await run("extensions", "disable", "scope")).toContain("without scope enforcement"); expect(code).toBe(2);
  });

  it("imports an old setup once and reports what could not be migrated", async () => {
    mkdirSync(join(home, ".0", "plugins", "old-one"), { recursive: true });
    writeFileSync(join(home, ".0", "plugins", "old-one", "plugin.json"), JSON.stringify({ id: "old-one", version: "1.0.0", tools: [] })); writeFileSync(join(home, ".0", "plugins", "old-one", "plugin.js"), "//");
    const text = await run("extensions", "import");
    expect(text).toContain("could not migrate 1"); expect(text).toContain("skip plugin old-one");
    expect(await run("extensions", "import")).toContain("(earlier run)");
  });
});

describe("approvals are the operator's", () => {
  it("refuse from an agent session even with --yes or a terminal, and change nothing", async () => {
    const r = repo();
    for (const tty of [false, true]) {
      operatorAtTerminal(tty); process.env.ZERO_AGENT_SESSION = "1"; out.length = 0; err.length = 0; code = 0;
      await run("add", `${r.dir}@${r.shas[0]}`, "--yes", "--enable");
      expect(code, String(tty)).not.toBe(0); expect(err.join("\n"), String(tty)).toMatch(/agent session/);
      await run("add", `${r.dir}@${r.shas[0]}`); expect(code, String(tty)).toBe(2); expect(out.join("\n") + err.join("\n")).toContain("Re-run with --yes");
      await run("extensions", "enable", "demo", "--yes"); await run("extensions", "disable", "scope", "--yes"); await run("extensions", "import", "--force"); await run("extensions", "remove", "demo", "--yes");
      expect(existsSync(join(home, ".0", "extensions", "demo")), String(tty)).toBe(false);
      const state = join(home, ".0", "extensions", "state.json");
      if (existsSync(state)) { const parsed = JSON.parse(readFileSync(state, "utf8")); expect(Object.keys(parsed.extensions), String(tty)).toEqual([]); expect(parsed.builtins, String(tty)).toEqual({}); }
      delete process.env.ZERO_AGENT_SESSION;
    }
  });

  it("installs on --yes without a terminal when not in an agent session, with the flags before or after the source", async () => {
    const r = repo(); operatorAtTerminal(false);
    expect(await run("add", `${r.dir}@${r.shas[0]}`, "--yes")).toContain("Installed extension demo"); expect(code).toBe(0);
    await run("extensions", "remove", "demo", "--yes");
    expect(await run("add", "--yes", `${r.dir}@${r.shas[0]}`)).toContain("Installed extension demo"); expect(code).toBe(0);
    await run("extensions", "remove", "demo", "--yes");
    const bare = await run("add", `${r.dir}@${r.shas[0]}`);
    expect(code).toBe(2); expect(bare).toContain("It can:"); expect(bare).toContain("Re-run with --yes to install");
    expect(await run("add", `${r.dir}@${r.shas[0]}`, "--preview")).toContain("It can:"); expect(code).toBe(0);
  });

  it("adds one MCP server as a local extension through the same prompt: no --yes installs nothing", async () => {
    const prompt = await run("extensions", "mcp", "docs", "--", "echo", "hi");
    expect(code).toBe(2); expect(prompt).toContain("Re-run with --yes");
    expect(existsSync(join(home, ".0", "extensions", "docs"))).toBe(false);
    expect(await run("extensions", "mcp", "docs", "--yes", "--", "echo", "hi")).toContain("Installed extension docs");
    expect(await run("extensions", "list")).toMatch(/docs\s+/);
    await run("extensions", "mcp", "x"); expect(code).toBe(2);
    await run("extensions", "mcp", "x", "--url", "http://insecure.example", "--yes"); expect(code).toBe(1);
  });
});
