import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasProtectedSegment, hasUnsafeRelativeSegment, isProtectedSegment,
  isUnsafeRelativeSegment,
} from "./paths.js";
import { assertSourceScopePath, normalizeSourcePath } from "../secure/source-scope.js";

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("protected segments", () => {
  it("flags exactly .git and .0", () => {
    expect(isProtectedSegment(".git")).toBe(true);
    expect(isProtectedSegment(".0")).toBe(true);
    for (const ok of ["src", ".github", ".gitignore", ".00", "0", ".git ", ""]) expect(isProtectedSegment(ok)).toBe(false);
  });
  it("is case-sensitive, as before (case-folding is a filesystem concern)", () => {
    expect(isProtectedSegment(".GIT")).toBe(false);
    expect(isProtectedSegment(".Git")).toBe(false);
  });
  it("treats empty, dot and traversal segments as unsafe", () => {
    for (const bad of ["", ".", "..", ".git", ".0"]) expect(isUnsafeRelativeSegment(bad)).toBe(true);
    expect(isUnsafeRelativeSegment("src")).toBe(false);
  });
  it("detects traversal, doubled and trailing slashes, nested protected segments", () => {
    for (const bad of ["../x", "a/../b", "a//b", "a/", "/a", "./a", ".git/config", "a/.git/x", ".0/findings", "a/.0"]) {
      expect(hasUnsafeRelativeSegment(bad), bad).toBe(true);
    }
    for (const ok of ["a", "a/b/c.ts", ".github/workflows/x.yml", "a/.gitignore"]) expect(hasUnsafeRelativeSegment(ok), ok).toBe(false);
  });
  it("backslashes are not separators here (callers reject them separately)", () => {
    expect(hasUnsafeRelativeSegment("a\\.git\\x")).toBe(false);
  });
  it("hasProtectedSegment checks resolved paths on the given separator only", () => {
    expect(hasProtectedSegment(`a${sep}.git${sep}x`, sep)).toBe(true);
    expect(hasProtectedSegment(`.0${sep}x`, sep)).toBe(true);
    expect(hasProtectedSegment(`a${sep}..${sep}b`, sep)).toBe(false);
    expect(hasProtectedSegment("a/b", sep)).toBe(false);
  });
  it("source-scope keeps rejecting the same inputs", () => {
    for (const bad of ["../x", "a/.git", ".0", "a//b", "a/"]) expect(() => normalizeSourcePath(bad), bad).toThrow();
    expect(normalizeSourcePath("src/lib")).toBe("src/lib");
    expect(() => assertSourceScopePath("src/.git/config", "src")).toThrow();
    expect(() => assertSourceScopePath("src/a.ts", "src")).not.toThrow();
  });
  it("is purely lexical: a symlink named like a normal dir is not flagged (callers lstat)", () => {
    const root = mkdtempSync(join(tmpdir(), "paths-test-")); cleanup.push(root);
    mkdirSync(join(root, ".git"));
    symlinkSync(join(root, ".git"), join(root, "link"));
    expect(hasUnsafeRelativeSegment("link/config")).toBe(false);
  });
});
