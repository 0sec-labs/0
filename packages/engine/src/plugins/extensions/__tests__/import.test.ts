import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionService, unwrap } from "../index.js";
import { cleanup, tmp, writeTree, SKILL } from "./fixtures.js";

const dirs: string[] = [];
afterEach(() => { cleanup(...dirs.splice(0)); });
const SHA = "c".repeat(40); const SKILL_SHA = "d".repeat(40);

/** Fixtures in the formats the OLD writers produce (github-plugin-install.ts, custom-mcp.ts, service-plugins.ts, skills.ts provenance, executable.ts registry, enablement.ts). */
function oldHome(): string {
  const home = tmp("oldhome"); dirs.push(home);
  writeTree(join(home, ".0"), {
    "plugins/gh-plug/plugin.json": JSON.stringify({ id: "gh-plug", version: "1.4.0", tools: [{ name: "scan", description: "d", capabilities: ["network", "filesystem-read"] }] }),
    "plugins/gh-plug/plugin.js": "// guest\n",
    "plugins/gh-plug/source.json": JSON.stringify({ source: "github", repo: "acme/gh-plug", ref: "main", sha: SHA, permissionHash: "p".repeat(64), entrySha256: "e".repeat(64), toolHashes: { scan: "h" }, installedAt: "2026-01-02T03:04:05.000Z" }),
    "plugins/hand-made/plugin.json": JSON.stringify({ id: "hand-made", version: "0.1.0", tools: [] }), "plugins/hand-made/plugin.js": "// guest\n",
    "plugin-enablement/abc.json": JSON.stringify({ schema: 1, project: "/work/app", enabled: { "gh-plug": { version: "1.4.0", capabilities: ["network"], enabledAt: 1 } } }),
    "executable-plugins/registry.json": JSON.stringify({ schema: 1, plugins: { "model-tool": { id: "model-tool", name: "Model tool", activeVersionId: "v1", versions: [{ versionId: "v1", kind: "tool" }] } } }),
    "mcp-servers.json": JSON.stringify([
      { id: "custom-docs", name: "docs", transport: "stdio", command: "npx", args: ["-y", "docs-mcp"], cwd: null, env: { DOCS_TOKEN: "SECRET-ENV-VALUE-123" }, url: null, headers: {}, enabled: true, approvedFingerprint: "f" },
      { id: "custom-remote", name: "remote", transport: "http", command: null, args: [], env: {}, url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer SECRET-HEADER-VALUE-456" }, enabled: false, approvedFingerprint: null },
    ]),
    "service-plugins.json": JSON.stringify([{ id: "github", enabled: true, fields: { token: "ghp_SECRET_TOKEN_789" }, tools: [], testedAt: "" }, { id: "slack", enabled: true, fields: { token: "xoxb-SECRET" }, tools: [], testedAt: "" }]),
    "skills-library/skills/gh-skill/SKILL.md": SKILL("gh-skill"), "skills-library/skills/gh-skill/scripts/run.sh": "echo\n",
    "skills-library/provenance/gh-skill.json": JSON.stringify({ repo: "acme/skills", path: "", ref: "main", sha: SKILL_SHA, licence: "MIT", licenceSource: "spdx", catalogId: null, publisher: "acme", installedAt: "2026-02-03T00:00:00.000Z", revision: "r".repeat(64) }),
    "skills-library/skills/sub-skill/SKILL.md": SKILL("sub-skill"),
    "skills-library/provenance/sub-skill.json": JSON.stringify({ repo: "acme/mono", path: "skills/sub", ref: "main", sha: SKILL_SHA, licence: "MIT", licenceSource: "spdx", catalogId: null, publisher: "acme", installedAt: "2026-02-03T00:00:00.000Z", revision: "r".repeat(64) }),
    "skills-library/skills/my-notes/SKILL.md": SKILL("my-notes"),
  });
  return home;
}

function snapshot(root: string, skip = "extensions"): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string) => { for (const e of readdirSync(dir)) { const p = join(dir, e); if (relative(root, p) === skip) continue; if (statSync(p).isDirectory()) visit(p); else out[relative(root, p)] = readFileSync(p, "utf8"); } };
  visit(root); return out;
}

describe("one-time importer", () => {
  it("preserves what can migrate, reports what cannot, and never touches the old stores or copies secrets", () => {
    const home = oldHome(); const svc = createExtensionService({ home }); const before = snapshot(join(home, ".0"));
    const report = unwrap(svc.importer.run());
    expect(report.alreadyDone).toBe(false);
    expect(snapshot(join(home, ".0"))).toEqual(before);

    // GitHub-installed executable plugin: kept disabled with SHA, approval record and the projects it was enabled in; cannot run.
    const s = svc.store.read(); if (!s.ok) throw new Error("state");
    const gh = s.value.plugins["gh-plug"]!;
    expect(gh.legacy).toMatchObject({ kind: "executable-github", repo: "acme/gh-plug", sha: SHA, permissionHash: "p".repeat(64), approvedCapabilities: ["filesystem-read", "network"], enabledIn: ["/work/app"] });
    expect(gh.enabled).toEqual({ global: false, projects: [] });
    expect(s.value.plugins["hand-made"]!.legacy?.kind).toBe("executable-other");
    expect(s.value.plugins["model-tool"]!.legacy?.kind).toBe("model-authored");
    expect(report.notMigrated.map(i => `${i.kind}:${i.name}`)).toEqual(expect.arrayContaining(["github-plugin:gh-plug", "plugin:hand-made", "model-authored:model-tool", "connection:slack"]));
    expect(report.notMigrated.find(i => i.name === "gh-plug")?.detail).toContain(`acme/gh-plug@${SHA.slice(0, 12)}`);

    // MCP servers become local extensions, need re-approval, keep their enabled flag, never carry secret values.
    const docs = s.value.plugins["docs"]!;
    expect(docs).toMatchObject({ enabled: { global: true, projects: [] }, source: null }); expect(docs.revisions[docs.active!]).toMatchObject({ approvedAt: null, location: { kind: "store" } });
    expect(s.value.plugins["remote"]!.enabled.global).toBe(false);
    const stored = readFileSync(join(home, ".0", "extensions", "docs", docs.active!, ".mcp.json"), "utf8");
    expect(stored).toContain("${DOCS_TOKEN}");
    for (const file of Object.values(snapshot(join(home, ".0", "extensions"), "never"))) for (const secret of ["SECRET-ENV-VALUE-123", "SECRET-HEADER-VALUE-456", "ghp_SECRET_TOKEN_789"]) expect(file).not.toContain(secret);

    // Skills: GitHub provenance (pinned SHA + approval time) carried over; subpath installs keep provenance in the note; custom skills adopted.
    const skill = s.value.plugins["gh-skill"]!;
    expect(skill).toMatchObject({ active: SKILL_SHA, approvedRevision: SKILL_SHA, source: { type: "git", url: "https://github.com/acme/skills.git" }, enabled: { global: true } });
    expect(skill.revisions[SKILL_SHA]).toMatchObject({ approvedAt: "2026-02-03T00:00:00.000Z", location: { kind: "external", path: join(home, ".0", "skills-library", "skills", "gh-skill") } });
    expect(skill.revisions[SKILL_SHA]!.approvedCapabilities?.runs).toEqual(["scripts/run.sh"]);
    expect(s.value.plugins["sub-skill"]!.note).toContain("acme/mono/skills/sub"); expect(s.value.plugins["sub-skill"]!.source).toBeNull();
    expect(s.value.plugins["my-notes"]!.active).toMatch(/^local-/);
    expect(report.migrated.map(i => `${i.kind}:${i.name}`)).toEqual(expect.arrayContaining(["mcp-server:docs", "connection:github", "github-skill:gh-skill", "skill:my-notes"]));
  });

  it("is idempotent, and imported entries obey the normal rules", () => {
    const home = oldHome(); const svc = createExtensionService({ home });
    unwrap(svc.importer.run()); const first = JSON.stringify(unwrap(svc.store.read()));
    expect(unwrap(svc.importer.run()).alreadyDone).toBe(true); expect(JSON.stringify(unwrap(svc.store.read()))).toBe(first);
    // unmigrated executable plugins can never be enabled or updated
    const e = svc.installer.enable("gh-plug", { approve: true }); expect(!e.ok && e.error.code).toBe("legacy");
    // imported MCP server is enabled but refused until re-approved
    expect(svc.loadable().refused).toEqual(expect.arrayContaining([expect.objectContaining({ name: "docs", code: "not_approved" })]));
    expect(svc.loadable().extensions.map(x => x.name)).toEqual(expect.arrayContaining(["gh-skill", "my-notes"]));
    const noApprove = svc.installer.enable("remote"); expect(!noApprove.ok && noApprove.error.code).toBe("needs_approval");
    unwrap(svc.installer.enable("docs", { approve: true }));
    expect(svc.loadable().extensions.find(x => x.name === "docs")?.capabilities.mcp).toMatchObject([{ name: "docs", command: "npx" }]);
  });

  it("an empty home imports nothing and does not fail", () => {
    const home = tmp("empty"); dirs.push(home); const r = unwrap(createExtensionService({ home }).importer.run());
    expect(r.migrated).toEqual([]); expect(r.notMigrated).toEqual([]);
  });
});
