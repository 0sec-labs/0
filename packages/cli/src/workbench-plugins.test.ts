import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyEnablement, enable, pluginsRootDir, writeEnablement } from "@0/core";
import { installWorkbenchPlugins, prepareWorkbenchPlugins } from "./workbench-plugins.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(approved = true) {
  const home = realpathSync(await mkdtemp(join(tmpdir(), "0-plugins-test-"))); roots.push(home);
  const project = join(home, "repo"); await mkdir(project);
  const plugin = join(pluginsRootDir(home), "fixture.scanner"); await mkdir(plugin, { recursive: true, mode: 0o700 });
  const manifest = { id: "fixture.scanner", name: "Fixture", version: "1.0.0", tools: [{ name: "fixture_scan", description: "test", parameters: {}, capabilities: ["filesystem-read"] }] };
  await writeFile(join(plugin, "plugin.json"), JSON.stringify(manifest));
  await writeFile(join(plugin, "plugin.js"), 'throw new Error("must not execute on host");');
  if (approved) {
    const result = enable(emptyEnablement(project), manifest.id, { version: manifest.version, capabilities: ["filesystem-read"], now: 1 });
    if (!result.ok) throw new Error(result.error);
    expect(writeEnablement(project, result.record, home)).toBe(true);
  }
  return { home, project, plugin, manifest };
}
describe("automatic VM plugin preparation", () => {
  it("copies approved plugins without execution and maps approvals to the guest project", async () => {
    const f = await fixture(); const prepared = await prepareWorkbenchPlugins(f.project, f.home);
    try {
      expect(prepared.approvals.project).toBe("/workspace");
      expect(Object.keys(prepared.approvals.enabled)).toEqual(["fixture.scanner"]);
      expect(await readFile(join(prepared.directory!, "fixture.scanner", "plugin.js"), "utf8")).toContain("must not execute");
      await writeFile(join(f.plugin, "plugin.js"), "changed");
      expect(await readFile(join(prepared.directory!, "fixture.scanner", "plugin.js"), "utf8")).not.toBe("changed");
    } finally { await prepared.cleanup(); }
    await expect(readFile(join(prepared.directory!, "fixture.scanner", "plugin.js"))).rejects.toThrow();
  });
  it("refuses guest installation outside an admitted VM", async () => {
    await expect(installWorkbenchPlugins(emptyEnablement("/workspace"))).rejects.toThrow("admitted VM");
  });
  it("omits installed but unapproved plugins", async () => {
    const f = await fixture(false); const prepared = await prepareWorkbenchPlugins(f.project, f.home);
    expect(prepared.directory).toBeUndefined(); expect(prepared.approvals.enabled).toEqual({});
  });
  it("does not reuse approval after capabilities widen", async () => {
    const f = await fixture(); f.manifest.tools[0]!.capabilities.push("process-exec");
    await writeFile(join(f.plugin, "plugin.json"), JSON.stringify(f.manifest));
    const prepared = await prepareWorkbenchPlugins(f.project, f.home);
    expect(prepared.directory).toBeUndefined(); expect(prepared.approvals.enabled).toEqual({});
  });
  it("refuses links into private host files", async () => {
    const f = await fixture(); const secret = join(f.home, "secret"); await writeFile(secret, "private");
    await symlink(secret, join(f.plugin, "secret-link"));
    await expect(prepareWorkbenchPlugins(f.project, f.home)).rejects.toThrow(/links/);
  });
});
