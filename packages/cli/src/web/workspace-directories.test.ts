import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkspaceDirectories } from "./workspace-directories.js";

const roots: string[] = [];
function fixture() { const root = realpathSync(mkdtempSync(join(tmpdir(), "zero-folder-browser-"))); roots.push(root); return root; }
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("connected-host directory metadata", () => {
  it("lists only immediate folders with canonical paths, including folders outside home", async () => {
    const root = fixture(); mkdirSync(join(root, "Project")); mkdirSync(join(root, "Project", "nested"));
    writeFileSync(join(root, "private.txt"), "Never expose file contents.");
    const page = await listWorkspaceDirectories(root);
    expect(page).toMatchObject({ path: root, parentPath: join(root, ".."), entries: [{ name: "Project", path: join(root, "Project") }], truncated: false });
    expect(JSON.stringify(page)).not.toContain("Never expose"); expect(JSON.stringify(page)).not.toContain("nested");
  });
  it.skipIf(process.platform === "win32")("canonicalizes directory symlinks and omits file or broken symlinks", async () => {
    const root = fixture(), target = fixture(); writeFileSync(join(target, "file"), "not a folder");
    symlinkSync(target, join(root, "folder-link")); symlinkSync(join(target, "file"), join(root, "file-link")); symlinkSync(join(target, "missing"), join(root, "broken-link"));
    expect((await listWorkspaceDirectories(root)).entries).toEqual([{ name: "folder-link", path: target }]);
  });
  it("limits a large nonrecursive listing", async () => {
    const root = fixture(); for (let index = 0; index < 205; index++) mkdirSync(join(root, `folder-${index}`));
    const page = await listWorkspaceDirectories(root);
    expect(page.entries).toHaveLength(200); expect(page.truncated).toBe(true);
  });
  it("also limits scanning a directory containing only files", async () => {
    const root = fixture(); for (let index = 0; index < 2_001; index++) writeFileSync(join(root, `file-${index}`), "");
    expect(await listWorkspaceDirectories(root)).toMatchObject({ entries: [], truncated: true });
  });
  it("rejects malformed paths and files and reports missing folders", async () => {
    const root = fixture(); writeFileSync(join(root, "file"), "data");
    for (const path of [null, {}, "a\0b", "x".repeat(4097)]) await expect(listWorkspaceDirectories(path)).rejects.toThrow("valid folder path");
    await expect(listWorkspaceDirectories(join(root, "file"))).rejects.toThrow("rather than a file");
    await expect(listWorkspaceDirectories(join(root, "missing"))).rejects.toThrow("could not be found");
  });
  it("defaults to this host's home without granting scope or changing files", async () => {
    const root = fixture(); vi.stubEnv("HOME", root);
    expect(await listWorkspaceDirectories()).toMatchObject({ path: root, homePath: root, entries: [] });
  });
});
