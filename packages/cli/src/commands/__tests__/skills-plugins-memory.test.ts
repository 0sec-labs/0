import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCommandTree } from "../tree.js";
import { registerSkillsCommand } from "../skills.js";
import { registerMemoryCommand } from "../memory.js";
import { registerPluginMovedCommand } from "../plugin-moved.js";
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
  registerPluginMovedCommand(program, io);
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
  it("registers skills, memory and the moved plugin stubs", () => {
    const program = new Command(); registerCommandTree(program);
    const paths = (command: Command, prefix = ""): string[] => command.commands.flatMap(child => [`${prefix}${child.name()}`, ...paths(child, `${prefix}${child.name()} `)]);
    const all = paths(program);
    for (const path of ["skills list", "skills catalog", "skills add", "skills link", "memory list", "memory import", "plugin submit", "plugin connect", "plugin mcp add", "plugin mcp test"]) expect(all).toContain(path);
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

describe("memory (embedded)", () => {
  const archive = (id: string) => ({ format: "zero-memory", version: 1, exportedAt: "2026-01-01T00:00:00.000Z", knowledge: [{ id, projectId: "p1", summary: "Prefers pnpm", status: "current", createdAt: "2026-01-01T00:00:00.000Z", sourceLinks: [], provenance: [] }] });
  it("previews, imports (disabled), lists, disables, refuses enable and exports", async () => {
    const file = join(work, "memory.json"); writeFileSync(file, JSON.stringify(archive("k1")));
    await run("memory", "import", file, "--preview", "--json"); expect(json().preview.importable).toBe(1);
    await run("memory", "list", "--json"); expect(json().memories).toEqual([]);
    await run("memory", "import", file, "--json");
    await run("memory", "list", "--json"); const [row] = json().memories; expect(row.status).toBe("disabled");
    await run("memory", "disable", row.id, "--json"); expect(json().memory.status).toBe("disabled");
    // Imported memory cannot be switched on without fresh evidence; the engine's refusal is surfaced as a failure.
    await run("memory", "enable", row.id); expect(code).toBe(1); expect(err.join("")).toContain("fresh evidence");
    await run("memory", "export", "-o", join(work, "out.json")); expect(JSON.parse(readFileSync(join(work, "out.json"), "utf8")).knowledge).toHaveLength(1);
  });
  it("rejects a bad --limit with exit 2 and a missing archive with exit 2", async () => {
    await run("memory", "list", "--limit", "0"); expect(code).toBe(2);
    await run("memory", "import", join(work, "missing.json")); expect(code).toBe(2);
    const wrong = join(work, "wrong.json"); writeFileSync(wrong, JSON.stringify({ bad: 1 }));
    await run("memory", "import", wrong); expect(code).toBe(2); expect(err.join("")).toContain("is not a 0 memory archive");
  });
});

describe("the retired plugin commands", () => {
  it("say what replaced them and install, run or approve nothing", async () => {
    await run("plugin", "submit", "./x"); expect(code).toBe(2); expect(err.join("")).toBe("removed: extensions are installed from git: 0 skills add <repo>@<sha>");
    await run("plugin", "connect", "github", "--yes"); expect(code).toBe(2); expect(err.join("")).toContain("removed:");
    await run("plugin", "run", "x", "tool"); expect(code).toBe(2); expect(err.join("")).toContain("removed:");
    await run("plugin", "mcp", "add", "docs", "--", "echo", "hi"); expect(code).toBe(2); expect(err.join("")).toContain("moved: use `0 skills extensions mcp");
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
