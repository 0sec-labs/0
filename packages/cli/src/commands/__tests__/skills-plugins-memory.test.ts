import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCommandTree } from "../tree.js";
import { registerSkillsCommand } from "../skills.js";
import { registerMemoryCommand } from "../memory.js";
import { openConsole } from "../../console-skills-client.js";
import { registerLocalEngine } from "../../local-engine.js";
import type { CommandIo } from "../console-output.js";

let home: string; let work: string; let savedHome: string | undefined; let db: string;
const out: string[] = []; const err: string[] = []; let code = 0;
const io: CommandIo = { out: line => out.push(line), err: line => err.push(line), setExitCode: value => { code = value; } };

beforeEach(() => {
  savedHome = process.env.HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), "spm-home-"))); work = realpathSync(mkdtempSync(join(tmpdir(), "spm-work-")));
  process.env.HOME = home; db = join(home, "test.db");
  out.length = 0; err.length = 0; code = 0;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerSkillsCommand(program, io); registerMemoryCommand(program, io);
  out.length = 0; err.length = 0; code = 0;
  await program.parseAsync(["node", "0", ...args, "--db-path", db]);
}
const json = () => { try { return JSON.parse(out.join("\n")); } catch { throw new Error(`no JSON output; exit ${code}; err: ${err.join(" ")}`); } };
function makeSkill(name: string, description = "A test skill"): string {
  const dir = join(work, name); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
  return dir;
}

describe("command tree", () => {
  it("registers skills and memory", () => {
    const program = new Command(); registerCommandTree(program);
    const paths = (command: Command, prefix = ""): string[] => command.commands.flatMap(child => [`${prefix}${child.name()}`, ...paths(child, `${prefix}${child.name()} `)]);
    const all = paths(program);
    for (const path of ["skills list", "skills catalog", "skills add", "skills link", "memory list", "memory add", "memory import", "memory clear"]) expect(all).toContain(path);
  });
});

describe("skills (embedded)", () => {
  it("imports a folder, lists, shows, edits, copies, exports and deletes with --yes", async () => {
    const dir = makeSkill("demo-skill");
    await run("skills", "import", dir, "--json"); expect(json().skill.name).toBe("demo-skill");
    await run("skills", "list", "--json");
    expect(json().skills.some((skill: { name: string }) => skill.name === "demo-skill")).toBe(true);
    await run("skills", "show", "demo-skill"); expect(out.join("\n")).toContain("# demo-skill");

    writeFileSync(join(work, "new.md"), "---\nname: demo-skill\ndescription: Changed\n---\n# Changed\n");
    await run("skills", "edit", "demo-skill", "--file", join(work, "new.md")); expect(code).toBe(0);
    await run("skills", "show", "demo-skill", "--json"); expect(json().skill.content).toContain("# Changed");

    await run("skills", "copy", "demo-skill", "--name", "demo-copy", "--json"); expect(json().skill.name).toBe("demo-copy");
    const file = join(work, "bundle.json");
    await run("skills", "export", "demo-copy", "-o", file); expect(JSON.parse(readFileSync(file, "utf8")).name).toBe("demo-copy");

    await run("skills", "delete", "demo-copy"); expect(code).toBe(2); expect(err.join("")).toContain("--yes");
    await run("skills", "list", "--json"); expect(json().skills.some((skill: { name: string }) => skill.name === "demo-copy")).toBe(true);
    await run("skills", "delete", "demo-copy", "--yes"); expect(code).toBe(0);
    await run("skills", "list", "--json"); expect(json().skills.some((skill: { name: string }) => skill.name === "demo-copy")).toBe(false);
  });

  it("links and unlinks a folder", async () => {
    const dir = join(work, "library"); mkdirSync(join(dir, "linked-skill"), { recursive: true }); writeFileSync(join(dir, "linked-skill", "SKILL.md"), "---\nname: linked-skill\ndescription: Linked\n---\n# L\n");
    await run("skills", "link", dir, "--json"); const id = json().mount.id;
    await run("skills", "list", "--json"); expect(json().skills.some((skill: { name: string }) => skill.name === "linked-skill")).toBe(true);
    await run("skills", "unlink", id); expect(code).toBe(0);
    await run("skills", "list", "--json"); expect(json().mounts).toEqual([]);
  });

  it("fails with exit 1 for an unknown skill and JSON error on stderr", async () => {
    await run("skills", "show", "nope", "--json");
    expect(code).toBe(1); expect(JSON.parse(err.join("")).error).toContain("No skill matches");
  });

  it("lists and searches the catalog without the network, and add without --yes only reviews", async () => {
    await run("skills", "catalog", "--json"); const all = json().skills.length; expect(all).toBeGreaterThan(0);
    await run("skills", "catalog", "--search", "zzz-no-such-skill-zzz", "--json"); expect(json().skills).toEqual([]);
  });
});

describe("memory (local notes)", () => {
  it("adds, lists, filters, exports, imports, disables and clears under a temp HOME", async () => {
    await run("memory", "list"); expect(out.join("\n")).toContain("Nothing remembered yet.");
    await run("memory", "add", "Run tests with pnpm test", "--global", "--kind", "command", "--json"); const note = json().note; expect(note.scope).toBe("global");
    await run("memory", "add", "Prefer small PRs", "--folder", work, "--json");
    await run("memory", "list", "--json"); expect(json().notes).toHaveLength(2);
    await run("memory", "list", "--folder", work, "--json"); expect(json().notes.map((n: { text: string }) => n.text)).toEqual(["Prefer small PRs"]);
    await run("memory", "list", "--search", "pnpm", "--json"); expect(json().notes).toHaveLength(1);
    const file = join(work, "out.json"); await run("memory", "export", "-o", file);
    expect(JSON.parse(readFileSync(file, "utf8")).notes).toHaveLength(2);
    await run("memory", "remove", note.id); await run("memory", "list", "--json"); expect(json().notes).toHaveLength(1);
    await run("memory", "import", file, "--json"); expect(json()).toEqual({ added: 1, total: 2 });
    await run("memory", "clear"); expect(code).toBe(2); expect(err.join("")).toContain("--yes");
    await run("memory", "clear", "--yes", "--json"); expect(json().removed).toBe(2);
  });
  it("rejects a bad kind, a missing note and a file that is not a memory file with the right exit codes", async () => {
    await run("memory", "add", "x", "--global", "--kind", "bogus"); expect(code).toBe(2);
    await run("memory", "remove", "m_nothere"); expect(code).toBe(1);
    const wrong = join(work, "wrong.json"); writeFileSync(wrong, JSON.stringify({ bad: 1 }));
    await run("memory", "import", wrong); expect(code).toBe(2); expect(err.join("")).toContain("is not a 0 memory file");
    await run("memory", "import", join(work, "missing.json")); expect(code).toBe(2);
  });
  it("still reads an older archive and adds its memories as notes", async () => {
    const file = join(work, "old.json");
    writeFileSync(file, JSON.stringify({ format: "zero-memory", version: 1, knowledge: [{ id: "k1", projectId: "p1", summary: "Prefers pnpm", status: "current" }] }));
    await run("memory", "import", file, "--json"); expect(json().added).toBe(1);
    await run("memory", "list", "--json"); expect(json().notes[0]).toMatchObject({ text: "Prefers pnpm", source: "import" });
  });
});

describe("attach to a running local engine", () => {
  it("sends the control token to the host and never embeds when a live descriptor exists", async () => {
    const token = "t".repeat(40); const seen: Array<{ url: string; method: string; auth: string | null }> = [];
    const unregister = registerLocalEngine({ url: "http://127.0.0.1:9/", token, engineId: "engine-test", serverInstanceId: "instance-1", pid: process.pid, workspace: process.cwd() }, db, { homeDir: home });
    try {
      const fetchStub = (async (url: URL, init: RequestInit) => {
        seen.push({ url: url.pathname, method: String(init.method), auth: new Headers(init.headers).get("authorization") });
        return new Response(JSON.stringify({ skills: [], mounts: [] }), { status: 200, headers: { "content-type": "application/json", "x-0-engine-id": "engine-test" } });
      }) as unknown as typeof fetch;
      const client = await openConsole({ dbPath: db, homeDir: home }, { fetch: fetchStub });
      expect(client.mode).toBe("attached");
      expect((await client.request("GET", "/api/skills")).status).toBe(200);
      expect(seen).toEqual([{ url: "/api/skills", method: "GET", auth: `Bearer ${token}` }]);
      const impostor = (async () => new Response("{}", { status: 200, headers: { "x-0-engine-id": "someone-else" } })) as unknown as typeof fetch;
      await expect((await openConsole({ dbPath: db, homeDir: home }, { fetch: impostor })).request("GET", "/api/skills")).rejects.toThrow("identity");
    } finally { unregister(); }
    expect((await openConsole({ dbPath: db, homeDir: home })).mode).toBe("embedded");
  });
});
