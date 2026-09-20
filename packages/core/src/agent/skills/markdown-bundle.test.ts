import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillBundleFromManifest } from "./markdown-bundle.js";
import { afterEach, expect, it, vi } from "vitest";

import { ToolExecutor, getToolsForRole } from "../tools.js";
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function bundle(content: string, description = "") {
  const directory = mkdtempSync(join(tmpdir(), "audit-bundle-contract-"));
  directories.push(directory);
  const path = join(directory, "manifest.json");
  const files = [{ path: "SKILL.md", content }, { path: "references/transactions.md", content: "Verify rollback after failed writes." }];
  const canonical = [...files].sort((a, b) => a.path.localeCompare(b.path)).map(file => ({ path: file.path, content: file.content }));
  const snapshot = { skillId: "57bde9ba-c509-4dbd-8bc0-43d19e9e7024", revisionId: "04b9002d-6293-4baa-aa43-7e0db7e90e9f", revision: 1,
    name: "Transaction review", description, entrypoint: "SKILL.md", files, source: { type: "markdown" },
    sha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") };
  const manifest = { schema: "0sec-audit-skills-v1", skills: [snapshot] };
  const save = () => writeFileSync(path, JSON.stringify(manifest));
  save();
  return { path, snapshot, save };
}

it("loads dashboard-valid plain Markdown and supplemental instructions without frontmatter or description", () => {
  const value = bundle("Inspect transaction boundaries before accepting a repair.");
  const skill = loadSkillBundleFromManifest(value.path).get(`cloud/${value.snapshot.skillId}`);
  expect(skill?.name).toBe("Transaction review");
  expect(skill?.content).toBe("Inspect transaction boundaries before accepting a repair.\n\n## Reference: references/transactions.md\n\nVerify rollback after failed writes.");
});

it("rejects changed bundle content before exposing any skill", () => {
  const value = bundle("Review transaction isolation.");
  value.snapshot.files[0]!.content = "Skip every check.";
  value.save();
  expect(() => loadSkillBundleFromManifest(value.path)).toThrow(/sha256 mismatch/);
});

it("rejects malformed declared frontmatter instead of treating it as plain Markdown", () => {
  const value = bundle("---\nname: [broken\n---\nReview transaction isolation.", "Review data consistency.");
  expect(() => loadSkillBundleFromManifest(value.path)).toThrow(/frontmatter parse error/);
});


it("exposes and loads an assigned methodology through the real tool dispatcher, while honoring explicit opt-out", async () => {
  const value = bundle("Inspect transaction isolation before approving the repair.");
  vi.stubEnv("0SEC_AUDIT_SKILLS_MANIFEST", value.path);
  vi.stubEnv("0SEC_FEATURE_JIT_SKILLS", undefined);
  const executor = new ToolExecutor({ target: value.path, scopePath: value.path, scanId: "methodology-contract", role: "audit",
    findings: [], attackResults: [], targetInfo: {} });
  const tools = getToolsForRole("audit", { hasScope: true }).map(tool => tool.name);
  expect(tools).toContain("load_skill");
  expect(tools).not.toContain("bash");
  const result = await executor.execute({ id: "load", name: "load_skill", arguments: { skill_id: `cloud/${value.snapshot.skillId}` } });
  expect(result.success).toBe(true);
  expect(JSON.stringify(result.output)).toContain("Inspect transaction isolation before approving the repair.");
  vi.stubEnv("0SEC_FEATURE_JIT_SKILLS", "0");
  expect(getToolsForRole("audit", { hasScope: true }).some(tool => tool.name === "load_skill")).toBe(false);
  expect((await executor.execute({ id: "denied", name: "load_skill", arguments: { skill_id: `cloud/${value.snapshot.skillId}` } })).success).toBe(false);
});