import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertSourceScopePath, normalizeSourcePath, resolveSourceScope } from "./source-scope.js";
import { computeConfigIdentity } from "./project-state.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture() { const root = mkdtempSync(join(tmpdir(), "0-source-scope-")); directories.push(root); return root; }

it("retains whole-repository legacy identity and changes identity for a narrowed folder", () => {
  expect(normalizeSourcePath()).toBe(".");
  expect(normalizeSourcePath(".")).toBe(".");
  const base = { source: "repo", testCommand: "test" };
  expect(computeConfigIdentity({ ...base, sourcePath: undefined })).toBe(computeConfigIdentity(base));
  expect(computeConfigIdentity({ ...base, sourcePath: "service" })).not.toBe(computeConfigIdentity(base));
});

it.each(["", "/service", "../service", "a/../b", "a//b", "a/./b", "a\\b", ".git", "a/.0", "a\0b"])("rejects unsafe folder %j", path => {
  expect(() => normalizeSourcePath(path)).toThrow();
});

it("requires an existing regular directory and rejects linked directories", () => {
  const root = fixture(); const outside = fixture(); mkdirSync(join(root, "service"));
  writeFileSync(join(root, "file.ts"), "text"); symlinkSync(outside, join(root, "link"));
  expect(resolveSourceScope(root, "service")).toBe(realpathSync(join(root, "service")));
  for (const path of ["missing", "file.ts", "link"]) expect(() => resolveSourceScope(root, path)).toThrow();
});

it("blocks sibling-prefix and traversal reads and patch paths", () => {
  expect(() => assertSourceScopePath("service/a.ts", "service")).not.toThrow();
  for (const path of ["service-other/a.ts", "other/a.ts", "service/../other.ts", "service/.git/config", "/service/a.ts"]) {
    expect(() => assertSourceScopePath(path, "service")).toThrow();
  }
});
