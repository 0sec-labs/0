import { afterEach, describe, expect, it } from "vitest";
import { discoverAgentSkills } from "../../../agent/skills/agent-skills.js";
import { ToolExecutor } from "../../../agent/tools.js";
import { createExtensionService, extensionSkillRoots, runStartupImport, unwrap } from "../index.js";
import { SKILL, cleanup, makeRepo, tmp } from "./fixtures.js";

const dirs: string[] = [];
afterEach(() => { cleanup(...dirs.splice(0)); });
async function installed(enable: boolean) {
  const home = tmp("home"); const repo = makeRepo([{ "extension.json": JSON.stringify({ name: "demo", version: "1.0.0" }), "skills/alpha/SKILL.md": SKILL("alpha") }]); dirs.push(home, repo.dir);
  const svc = createExtensionService({ home });
  unwrap(svc.installer.commit(unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`)), { approvedRevision: repo.shas[0]!, ...(enable ? { enable: { scope: "global" as const } } : {}) }));
  return { home, svc };
}

describe("skills of extensions in skill discovery", () => {
  it("lists skills of an enabled extension with the extension name as source", async () => {
    const { home } = await installed(true);
    const found = discoverAgentSkills({ homeDir: home });
    expect(found.skills.filter(s => s.source === "extension")).toMatchObject([{ id: "extension/demo/alpha", name: "alpha", extension: "demo" }]);
    expect(found.diagnostics).toEqual([]);
  });

  it("does not list disabled extensions, refused (tampered) ones, or any in a shared workspace", async () => {
    const off = await installed(false);
    expect(discoverAgentSkills({ homeDir: off.home }).skills).toEqual([]);
    const on = await installed(true);
    expect(discoverAgentSkills({ homeDir: null }).skills.filter(s => s.source === "extension")).toEqual([]);
    const root = extensionSkillRoots({ home: on.home })[0]!;
    const { writeFileSync } = await import("node:fs"); const { join } = await import("node:path");
    writeFileSync(join(root.folder, "SKILL.md"), SKILL("alpha") + "\nextra\n");
    expect(extensionSkillRoots({ home: on.home })).toEqual([]);
    expect(discoverAgentSkills({ homeDir: on.home }).skills).toEqual([]);
  });

  it("list_skills and load_skill expose it", async () => {
    const { home } = await installed(true);
    const tools = new ToolExecutor({ target: "http://localhost:1", scanId: "s", findings: [], attackResults: [], targetInfo: {}, role: "audit", skillDiscoveryOptions: { homeDir: home } });
    const listed = (await tools.execute({ name: "list_skills", arguments: {} })).output as { skills: Array<{ id: string; source: string }> };
    expect(listed.skills.find(s => s.id === "extension/demo/alpha")).toMatchObject({ source: "demo" });
    expect((await tools.execute({ name: "load_skill", arguments: { skill_id: "extension/demo/alpha" } })).success).toBe(true);
  });

  it("the startup import is idempotent and never throws", () => {
    const home = tmp("home"); dirs.push(home);
    const first = runStartupImport({ home }); const second = runStartupImport({ home });
    expect(first?.alreadyDone).toBe(false); expect(second?.alreadyDone).toBe(true);
  });
});
