import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { isScopedPath, resolveScopedPath } from "./scope-path.js";
import { withLocalSourceBoundary } from "../../scope/local-source-boundary.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures
      }
    }
  }
});

function createTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanupDirs.push(dir);
  return dir;
}

describe("scope-path containment logic", () => {
  // 1. The root path itself
  describe("root path itself", () => {
    it("accepts an ordinary nested directory root when referencing itself", () => {
      const root = createTempDir("0-test-scope-root-");
      expect(isScopedPath(root, root)).toBe(true);
      expect(isScopedPath(root, ".")).toBe(true);

      withLocalSourceBoundary(root, () => {
        expect(resolveScopedPath(root, root)).toBe(root);
        expect(resolveScopedPath(root, ".")).toBe(root);
      });
    });

    it.runIf(process.platform !== "win32")("accepts the POSIX filesystem root '/' itself", () => {
      expect(isScopedPath("/", "/")).toBe(true);
      expect(isScopedPath("/", ".")).toBe(true);

      withLocalSourceBoundary("/", () => {
        expect(resolveScopedPath("/", "/")).toBe("/");
      });
    });
  });

  // 2. A legitimate child of the POSIX root '/'
  describe("legitimate child of POSIX root '/'", () => {
    it.runIf(process.platform !== "win32")("accepts existing descendants of '/' without failing with double-slash prefix", () => {
      const etcPath = realpathSync("/etc");
      expect(isScopedPath("/", "/etc")).toBe(true);
      expect(isScopedPath("/", "etc")).toBe(true);

      withLocalSourceBoundary("/", () => {
        expect(resolveScopedPath("/", "/etc")).toBe(etcPath);
        expect(resolveScopedPath("/", "etc")).toBe(etcPath);
      });
    });

    it.runIf(process.platform !== "win32")("accepts synthetic non-existent children under an existing parent of '/'", () => {
      const syntheticChild = join(tmpdir(), `synthetic-child-${Date.now()}.txt`);
      expect(isScopedPath("/", syntheticChild)).toBe(true);

      withLocalSourceBoundary("/", () => {
        expect(resolveScopedPath("/", syntheticChild)).toBe(resolve(syntheticChild));
      });
    });
  });

  // 3. A legitimate child of an ordinary nested root
  describe("legitimate child of ordinary nested root", () => {
    it("accepts existing and relative descendants within an ordinary folder", () => {
      const root = createTempDir("0-test-scope-nested-");
      const childDir = join(root, "subdir");
      mkdirSync(childDir);
      const childFile = join(childDir, "file.txt");
      writeFileSync(childFile, "content");

      expect(isScopedPath(root, childFile)).toBe(true);
      expect(isScopedPath(root, "subdir/file.txt")).toBe(true);

      withLocalSourceBoundary(root, () => {
        expect(resolveScopedPath(root, childFile)).toBe(childFile);
        expect(resolveScopedPath(root, "subdir/file.txt")).toBe(childFile);
      });
    });
  });

  // 4. A sibling path with a shared textual prefix that must be rejected
  describe("sibling path with shared textual prefix", () => {
    it("rejects sibling paths sharing a common string prefix", () => {
      const parent = createTempDir("0-test-scope-parent-");
      const authorized = join(parent, "workspace");
      const sibling = join(parent, "workspace-other");
      mkdirSync(authorized);
      mkdirSync(sibling);
      const siblingFile = join(sibling, "secret.txt");
      writeFileSync(siblingFile, "secret");

      expect(isScopedPath(authorized, sibling)).toBe(false);
      expect(isScopedPath(authorized, siblingFile)).toBe(false);
      expect(isScopedPath(authorized, "../workspace-other/secret.txt")).toBe(false);

      withLocalSourceBoundary(authorized, () => {
        expect(() => resolveScopedPath(authorized, siblingFile)).toThrow(/escapes the approved source folder/);
        expect(() => resolveScopedPath(authorized, "../workspace-other/secret.txt")).toThrow(/escapes the approved source folder/);
      });
    });
  });

  // 5. A path attempting to escape the root using '..'
  describe("directory traversal using '..'", () => {
    it("rejects relative traversals that escape above the root", () => {
      const parent = createTempDir("0-test-scope-traversal-");
      const authorized = join(parent, "inside");
      mkdirSync(authorized);
      const outsideFile = join(parent, "outside.txt");
      writeFileSync(outsideFile, "outside");

      expect(isScopedPath(authorized, "../outside.txt")).toBe(false);
      expect(isScopedPath(authorized, "../../outside.txt")).toBe(false);

      withLocalSourceBoundary(authorized, () => {
        expect(() => resolveScopedPath(authorized, "../outside.txt")).toThrow(/escapes the approved source folder/);
      });
    });

    it("accepts relative paths that traverse within the root without escaping", () => {
      const root = createTempDir("0-test-scope-internal-");
      const sub = join(root, "sub");
      mkdirSync(sub);
      const insideFile = join(root, "inside.txt");
      writeFileSync(insideFile, "inside");

      expect(isScopedPath(root, "sub/../inside.txt")).toBe(true);
      withLocalSourceBoundary(root, () => {
        expect(resolveScopedPath(root, "sub/../inside.txt")).toBe(insideFile);
      });
    });
  });

  // 6. Windows drive-root and trailing separator behavior
  describe("Windows drive root and trailing separator behavior", () => {
    it.runIf(process.platform === "win32")("accepts legitimate descendants of Windows drive root", () => {
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const driveRoot = resolve(systemRoot).slice(0, 3);
      expect(driveRoot.endsWith(sep)).toBe(true);
      expect(isScopedPath(driveRoot, driveRoot)).toBe(true);
      expect(isScopedPath(driveRoot, systemRoot)).toBe(true);

      withLocalSourceBoundary(driveRoot, () => {
        expect(resolveScopedPath(driveRoot, systemRoot)).toBe(realpathSync(systemRoot));
      });
    });

    it("accepts descendants and rejects siblings when scope root is specified with a trailing separator", () => {
      const parent = createTempDir("0-test-scope-trailing-");
      const authorized = join(parent, "authorized");
      const sibling = join(parent, "authorized-sibling");
      mkdirSync(authorized);
      mkdirSync(sibling);
      const childFile = join(authorized, "inside.txt");
      const siblingFile = join(sibling, "secret.txt");
      writeFileSync(childFile, "inside");
      writeFileSync(siblingFile, "secret");

      const authorizedWithSep = authorized + sep;
      expect(isScopedPath(authorizedWithSep, childFile)).toBe(true);
      expect(isScopedPath(authorizedWithSep, "inside.txt")).toBe(true);
      expect(isScopedPath(authorizedWithSep, siblingFile)).toBe(false);
      expect(isScopedPath(authorizedWithSep, "../authorized-sibling/secret.txt")).toBe(false);

      withLocalSourceBoundary(authorizedWithSep, () => {
        expect(resolveScopedPath(authorizedWithSep, childFile)).toBe(childFile);
        expect(resolveScopedPath(authorizedWithSep, "inside.txt")).toBe(childFile);
        expect(() => resolveScopedPath(authorizedWithSep, siblingFile)).toThrow(/escapes the approved source folder/);
        expect(() => resolveScopedPath(authorizedWithSep, "../authorized-sibling/secret.txt")).toThrow(/escapes the approved source folder/);
      });
    });
  });

  // 7. Symlink escape behavior
  describe("symlink escape behavior", () => {
    it("rejects symlinks that point outside the authorized scope", () => {
      const parent = createTempDir("0-test-scope-symlink-");
      const root = join(parent, "authorized");
      mkdirSync(root);
      const secret = join(parent, "secret.txt");
      writeFileSync(secret, "secret data");

      const linkToOutside = join(root, "escape-link");
      symlinkSync(secret, linkToOutside);

      expect(isScopedPath(root, "escape-link")).toBe(false);
      expect(isScopedPath(root, linkToOutside)).toBe(false);

      withLocalSourceBoundary(root, () => {
        expect(() => resolveScopedPath(root, "escape-link")).toThrow(/escapes the approved source folder/);
        expect(() => resolveScopedPath(root, linkToOutside)).toThrow(/escapes the approved source folder/);
      });
    });

    it("accepts symlinks that point to locations within the authorized scope", () => {
      const root = createTempDir("0-test-scope-internal-symlink-");
      const target = join(root, "real.txt");
      writeFileSync(target, "real content");

      const linkToInside = join(root, "internal-link");
      symlinkSync(target, linkToInside);

      expect(isScopedPath(root, "internal-link")).toBe(true);
      expect(isScopedPath(root, linkToInside)).toBe(true);

      withLocalSourceBoundary(root, () => {
        expect(resolveScopedPath(root, "internal-link")).toBe(target);
        expect(resolveScopedPath(root, linkToInside)).toBe(target);
      });
    });
  });
});
