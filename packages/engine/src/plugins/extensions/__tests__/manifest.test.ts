import { describe, expect, it } from "vitest";
import { parseManifest } from "../core/manifest.js";
import { capabilitiesOf, capabilityDelta } from "../core/capabilities.js";
import type { FolderFile } from "../core/files.js";
import { MCP_JSON, SKILL } from "./fixtures.js";

const f = (files: Record<string, string | { content: string; exec?: boolean }>): FolderFile[] =>
  Object.entries(files).map(([path, v]) => { const s = typeof v === "string" ? { content: v } : v; const bytes = Buffer.from(s.content); return { path, size: bytes.length, executable: Boolean(s.exec), bytes }; });
const parse = (files: Record<string, string | { content: string; exec?: boolean }>, fallbackName = "fallback") => parseManifest(f(files), { fallbackName });

describe("manifest read order", () => {
  const all = {
    "extension.json": JSON.stringify({ name: "from-extension", version: "1.0.0" }),
    ".claude-plugin/plugin.json": JSON.stringify({ name: "from-claude" }),
    "plugin.json": JSON.stringify({ name: "from-plugin-json" }),
    "SKILL.md": SKILL("from-skill"),
  };
  it("extension.json beats .claude-plugin/plugin.json beats plugin.json beats SKILL.md", () => {
    const names: Array<[string, string]> = [];
    const files: Record<string, string> = { ...all };
    for (const drop of ["extension.json", ".claude-plugin/plugin.json", "plugin.json", "SKILL.md"]) {
      const r = parse(files); expect(r.ok).toBe(true); if (r.ok) names.push([r.value.format, r.value.name]);
      delete files[drop];
    }
    expect(names).toEqual([["extension", "from-extension"], ["claude", "from-claude"], ["plugin-json", "from-plugin-json"], ["skill-folder", "from-skill"]]);
  });

  it("reads a Claude layout: skills/, .mcp.json, and reports hooks/commands/agents as ignored", () => {
    const r = parse({ ".claude-plugin/plugin.json": JSON.stringify({ name: "claude-ext", version: "2.0.0", description: "d" }), "skills/one/SKILL.md": SKILL("one"), "skills/two/SKILL.md": SKILL("two"), ".mcp.json": MCP_JSON, "hooks/hooks.json": "{}", "commands/x.md": "x" });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.skills.map(s => s.name)).toEqual(["one", "two"]);
    expect(r.value.mcpServers).toEqual([{ name: "docs", transport: "stdio", command: "npx", args: ["-y", "docs-mcp"], env: ["DOCS_TOKEN"], headers: [] }]);
    expect(r.value.ignored).toEqual(["hooks", "commands"]);
  });

  it("plugin.json supports the \"0\" object: connector, verifier, requires", () => {
    const r = parse({ "plugin.json": JSON.stringify({ name: "svc", "0": { connector: { service: "jira", auth: "token", env: ["JIRA_TOKEN"], hosts: ["example.atlassian.net"], access: { read: ["issues"], write: [] } }, verify: "scripts/verify.sh", requires: { bins: ["gh"], env: ["GITHUB_TOKEN"], "0": ">=0.36" } } }), "scripts/verify.sh": { content: "#!/bin/sh\n", exec: true } });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.connector).toMatchObject({ service: "jira", hosts: ["example.atlassian.net"], read: ["issues"] });
    expect(r.value.verify).toBe("scripts/verify.sh");
    const caps = capabilitiesOf(r.value);
    expect(caps.env).toEqual(["GITHUB_TOKEN", "JIRA_TOKEN"]); expect(caps.runs).toContain("scripts/verify.sh");
  });

  it("a bare SKILL.md folder and .agents/skills/x are one-skill extensions", () => {
    const a = parse({ "SKILL.md": SKILL("bare-skill") }); expect(a.ok && a.value.format).toBe("skill-folder");
    const b = parse({ ".agents/skills/x/SKILL.md": SKILL("x") }, "my-repo"); expect(b.ok && [b.value.name, b.value.skills[0]?.name]).toEqual(["my-repo", "x"]);
  });

  it("refuses the old executable format, traversal, loader variables and bad names", () => {
    const legacy = parse({ "plugin.json": JSON.stringify({ id: "old", tools: [] }), "plugin.js": "x" });
    expect(!legacy.ok && legacy.error.code).toBe("legacy_executable");
    expect(parse({ "plugin.json": JSON.stringify({ name: "a", "0": { verify: "../etc/passwd" } }) }).ok).toBe(false);
    expect(parse({ "plugin.json": JSON.stringify({ name: "a", "0": { requires: { env: ["LD_PRELOAD"] } } }) }).ok).toBe(false);
    expect(parse({ "extension.json": JSON.stringify({ name: "Bad Name" }) }).ok).toBe(false);
    expect(parse({ "README.md": "nothing" }).ok).toBe(false);
  });

  it("scripts become 'runs commands' and capability deltas list added lines", () => {
    const a = parse({ "SKILL.md": SKILL("s") }); const b = parse({ "SKILL.md": SKILL("s"), "scripts/go.sh": { content: "echo", exec: true } });
    if (!a.ok || !b.ok) throw new Error("parse");
    expect(capabilityDelta(capabilitiesOf(a.value), capabilitiesOf(b.value)).added).toEqual(["runs commands: scripts/go.sh"]);
  });
});
