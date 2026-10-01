import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { currentWorkbenchAssets } from "./workbench-assets.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it("locates the companion guest distribution for a standalone executable", () => {
  const root = mkdtempSync(join(tmpdir(), "zero-workbench-assets-")); roots.push(root);
  const distribution = join(root, "lib", "workbench-cli"); mkdirSync(distribution, { recursive: true });
  writeFileSync(join(distribution, "0.js"), "// guest entry");
  expect(currentWorkbenchAssets("file:///$bunfs/root/index.js", join(root, "bin", "0"))).toEqual({ cliDist: distribution });
});
it("does not silently fall back to the older VM image when companion files are missing", () => {
  const root = mkdtempSync(join(tmpdir(), "zero-workbench-assets-")); roots.push(root);
  expect(() => currentWorkbenchAssets("file:///$bunfs/root/index.js", join(root, "bin", "0"))).toThrow("distribution is unavailable");
});
