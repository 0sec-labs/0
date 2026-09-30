import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { snapshotSmolvmWorkspace, exportSmolvmWorkbenchArtifacts } from "./smolvm-workspace.js";
const roots: string[] = [];
async function fixture() { const root = await realpath(await mkdtemp("/tmp/0-workspace-test-")); roots.push(root); const source = join(root, "source"); await mkdir(source, { mode: 0o700 }); return { root, source }; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("controller source snapshots", () => {
  it("allows guest mutations only on a copied workspace and exports independent evidence", async () => {
    const { root, source } = await fixture();
    await writeFile(join(source, "target.ts"), "original");
    const snapshot = join(root, "snapshot"), state = join(root, "state"), output = join(root, "output");
    const captured = await snapshotSmolvmWorkspace(source, snapshot);
    expect(captured.files[0]).toMatchObject({ path: "target.ts", bytes: 8 });
    await writeFile(join(snapshot, "target.ts"), "candidate");
    await mkdir(state, { mode: 0o700 }); await writeFile(join(state, "findings.json"), "[]");
    const exported = await exportSmolvmWorkbenchArtifacts(snapshot, state, output);
    expect(exported.workspace.files[0]?.digest).not.toBe(captured.files[0]?.digest);
    expect(await readFile(join(source, "target.ts"), "utf8")).toBe("original");
    expect(await readFile(join(output, "artifacts", "workspace", "target.ts"), "utf8")).toBe("candidate");
    expect(await readFile(join(output, "artifacts", "state", "findings.json"), "utf8")).toBe("[]");
  });
  it("does not forward nested private state or dependency caches", async () => {
    const { root, source } = await fixture();
    for (const name of [".codex", ".git", "node_modules"]) { await mkdir(join(source, name)); await writeFile(join(source, name, "private"), "not shared"); }
    await writeFile(join(source, "source.ts"), "source");
    const captured = await snapshotSmolvmWorkspace(source, join(root, "copy"));
    expect(captured.files.map(file => file.path)).toEqual(["source.ts"]);
  });
  it("refuses source symlinks and never publishes guest-created links", async () => {
    const { root, source } = await fixture();
    await symlink("/etc/passwd", join(source, "linked"));
    await expect(snapshotSmolvmWorkspace(source, join(root, "copy"))).rejects.toThrow(/links/);
    const workspace = join(root, "guest"); await mkdir(workspace); await symlink("/etc/passwd", join(workspace, "result"));
    const state = join(root, "state"); await mkdir(state);
    await expect(exportSmolvmWorkbenchArtifacts(workspace, state, join(root, "output"))).rejects.toThrow(/links/);
    await expect(readFile(join(root, "output", "artifacts", "workspace", "result"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("enforces aggregate state plus workspace output and refuses stale destinations", async () => {
    const { root, source } = await fixture(); await writeFile(join(source, "source"), "1234");
    const state = join(root, "state"); await mkdir(state); await writeFile(join(state, "result"), "5678");
    await expect(exportSmolvmWorkbenchArtifacts(source, state, join(root, "output"), { maxBytes: 7 })).rejects.toThrow(/limit/);
    const existing = join(root, "existing"); await mkdir(existing, { mode: 0o700 }); await writeFile(join(existing, "old"), "stale");
    await expect(snapshotSmolvmWorkspace(source, existing)).rejects.toThrow(/empty/);
  });
});
