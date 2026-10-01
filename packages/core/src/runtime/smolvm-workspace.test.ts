import { afterEach, describe, expect, it } from "vitest";
import { renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { link, lstat, mkdtemp, mkdir, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  it("refuses out-of-root source symlinks and never publishes guest-created links", async () => {
    const { root, source } = await fixture();
    await symlink("/etc/passwd", join(source, "linked"));
    await expect(snapshotSmolvmWorkspace(source, join(root, "copy"))).rejects.toThrow(/links/);
    const workspace = join(root, "guest"); await mkdir(workspace); await symlink("/etc/passwd", join(workspace, "result"));
    const state = join(root, "state"); await mkdir(state);
    await expect(exportSmolvmWorkbenchArtifacts(workspace, state, join(root, "output"))).rejects.toThrow(/links/);
    await expect(readFile(join(root, "output", "artifacts", "workspace", "result"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("copies in-root source file links as independent regular files", async () => {
    const { root, source } = await fixture();
    await writeFile(join(source, "AGENTS.md"), "instructions");
    await symlink("AGENTS.md", join(source, "CLAUDE.md"));
    const snapshot = join(root, "copy");
    const captured = await snapshotSmolvmWorkspace(source, snapshot);
    expect(captured.files.map(file => file.path)).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(captured.bytes).toBe(24);
    expect((await lstat(join(snapshot, "CLAUDE.md"))).isSymbolicLink()).toBe(false);
    await writeFile(join(snapshot, "CLAUDE.md"), "guest change");
    expect(await readFile(join(source, "AGENTS.md"), "utf8")).toBe("instructions");
    expect(await readFile(join(snapshot, "AGENTS.md"), "utf8")).toBe("instructions");
  });
  it.each(["directory", "private", "hardlink"])("refuses source links to %s targets", async kind => {
    const { root, source } = await fixture();
    const target = join(source, kind === "private" ? ".codex" : "target");
    if (kind === "hardlink") {
      await writeFile(target, "source"); await link(target, join(source, "other"));
      await symlink("target", join(source, "linked"));
    } else {
      await mkdir(target); await writeFile(join(target, "file"), "source");
      await symlink(kind === "private" ? ".codex/file" : "target", join(source, "linked"));
    }
    await expect(snapshotSmolvmWorkspace(source, join(root, "copy"))).rejects.toThrow(/links/);
  });
  it.each(["workspace", "state"])("refuses even in-root file links in exported guest %s", async location => {
    const { root, source } = await fixture();
    const state = join(root, "state"); await mkdir(state);
    const directory = location === "workspace" ? source : state;
    await writeFile(join(directory, "target"), "evidence"); await symlink("target", join(directory, "linked"));
    await expect(exportSmolvmWorkbenchArtifacts(source, state, join(root, "output"))).rejects.toThrow(/links/);
    await expect(lstat(join(root, "output", "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["redirect", "replace"])("rejects a source link target that changes during capture (%s)", async mutation => {
    const { root, source } = await fixture();
    const target = join(source, "z-target"), linked = join(source, "a-link");
    await writeFile(target, "source"); await symlink("z-target", linked);
    let checks = 0;
    // The read-loop cancellation check runs after the target descriptor is opened.
    const signal = { throwIfAborted() {
      if (++checks !== 3) return;
      if (mutation === "redirect") { unlinkSync(linked); symlinkSync("/etc/passwd", linked); }
      else { renameSync(target, join(source, "old-target")); writeFileSync(target, "source"); }
    } } as AbortSignal;
    await expect(snapshotSmolvmWorkspace(source, join(root, "copy"), {}, signal)).rejects.toThrow(/changed|symlinks/);
    await expect(lstat(join(root, "copy"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("captures code repositories larger than the previous byte and file caps", async () => {
    const { root, source } = await fixture();
    const size = 65 * 1024 * 1024;
    const file = await open(join(source, "large-source"), "wx");
    try { await file.truncate(size); } finally { await file.close(); }
    for (let start = 0; start < 4100; start += 100) {
      await Promise.all(Array.from({ length: Math.min(100, 4100 - start) }, (_, index) => writeFile(join(source, `source-${start + index}`), "")));
    }
    const captured = await snapshotSmolvmWorkspace(source, join(root, "copy"));
    expect(captured.files).toHaveLength(4101); expect(captured.bytes).toBe(size);
  }, 30000);
  it("reports the path and attempted counts when a bounded snapshot exceeds its cap", async () => {
    const { root, source } = await fixture(); await writeFile(join(source, "source.ts"), "1234");
    await expect(snapshotSmolvmWorkspace(source, join(root, "copy"), { maxBytes: 3 })).rejects.toThrow("source.ts: 1/16384 files, 4/3 bytes");
    await expect(lstat(join(root, "copy"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("enforces aggregate state plus workspace output and refuses stale destinations", async () => {
    const { root, source } = await fixture(); await writeFile(join(source, "source"), "1234");
    const state = join(root, "state"); await mkdir(state); await writeFile(join(state, "result"), "5678");
    await expect(exportSmolvmWorkbenchArtifacts(source, state, join(root, "output"), { maxBytes: 7 })).rejects.toThrow(/limit/);
    const existing = join(root, "existing"); await mkdir(existing, { mode: 0o700 }); await writeFile(join(existing, "old"), "stale");
    await expect(snapshotSmolvmWorkspace(source, existing)).rejects.toThrow(/empty/);
  });
});
