import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { isInFolder, resolveFolderPath } from "./folder-path.js";

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

describe("folder-path containment logic", () => {
  // 1. The root path itself
  describe("root path itself", () => {
    it("accepts an ordinary nested directory root when referencing itself", () => {
      const root = createTempDir("0-test-folder-root-");
      expect(isInFolder(root, root)).toBe(true);
      expect(isInFolder(root, ".")).toBe(true);

      {
        expect(resolveFolderPath(root, root)).toBe(root);
        expect(resolveFolderPath(root, ".")).toBe(root);
      }
    });

    it.runIf(process.platform !== "win32")("accepts the POSIX filesystem root '/' itself", () => {
      expect(isInFolder("/", "/")).toBe(true);
      expect(isInFolder("/", ".")).toBe(true);

      {
        expect(resolveFolderPath("/", "/")).toBe("/");
      }
    });
  });

  // 2. A legitimate child of the POSIX root '/'
  describe("legitimate child of POSIX root '/'", () => {
    it.runIf(process.platform !== "win32")("accepts existing descendants of '/' without failing with double-slash prefix", () => {
      const etcPath = realpathSync("/etc");
      expect(isInFolder("/", "/etc")).toBe(true);
      expect(isInFolder("/", "etc")).toBe(true);

      {
        expect(resolveFolderPath("/", "/etc")).toBe(etcPath);
        expect(resolveFolderPath("/", "etc")).toBe(etcPath);
      }
    });

    it.runIf(process.platform !== "win32")("accepts synthetic non-existent children under an existing parent of '/'", () => {
      const syntheticChild = join(createTempDir("0-test-folder-missing-"), "missing.txt");
      expect(isInFolder("/", syntheticChild)).toBe(true);

      {
        expect(resolveFolderPath("/", syntheticChild)).toBe(resolve(syntheticChild));
      }
    });
  });

  // 3. A legitimate child of an ordinary nested root
  describe("legitimate child of ordinary nested root", () => {
    it("accepts existing and relative descendants within an ordinary folder", () => {
      const root = createTempDir("0-test-folder-nested-");
      const childDir = join(root, "subdir");
      mkdirSync(childDir);
      const childFile = join(childDir, "file.txt");
      writeFileSync(childFile, "content");

      expect(isInFolder(root, childFile)).toBe(true);
      expect(isInFolder(root, "subdir/file.txt")).toBe(true);

      {
        expect(resolveFolderPath(root, childFile)).toBe(childFile);
        expect(resolveFolderPath(root, "subdir/file.txt")).toBe(childFile);
      }
    });
  });

  // 4. A sibling path with a shared textual prefix that must be rejected
  describe("sibling path with shared textual prefix", () => {
    it("rejects sibling paths sharing a common string prefix", () => {
      const parent = createTempDir("0-test-folder-parent-");
      const authorized = join(parent, "workspace");
      const sibling = join(parent, "workspace-other");
      mkdirSync(authorized);
      mkdirSync(sibling);
      const siblingFile = join(sibling, "secret.txt");
      writeFileSync(siblingFile, "secret");

      expect(isInFolder(authorized, sibling)).toBe(false);
      expect(isInFolder(authorized, siblingFile)).toBe(false);
      expect(isInFolder(authorized, "../workspace-other/secret.txt")).toBe(false);

      {
        expect(() => resolveFolderPath(authorized, siblingFile)).toThrow(/escapes the folder/);
        expect(() => resolveFolderPath(authorized, "../workspace-other/secret.txt")).toThrow(/escapes the folder/);
      }
    });
  });

  // 5. A path attempting to escape the root using '..'
  describe("directory traversal using '..'", () => {
    it("rejects relative traversals that escape above the root", () => {
      const parent = createTempDir("0-test-folder-traversal-");
      const authorized = join(parent, "inside");
      mkdirSync(authorized);
      const outsideFile = join(parent, "outside.txt");
      writeFileSync(outsideFile, "outside");

      expect(isInFolder(authorized, "../outside.txt")).toBe(false);
      expect(isInFolder(authorized, "../../outside.txt")).toBe(false);

      {
        expect(() => resolveFolderPath(authorized, "../outside.txt")).toThrow(/escapes the folder/);
      }
    });

    it("accepts relative paths that traverse within the root without escaping", () => {
      const root = createTempDir("0-test-folder-internal-");
      const sub = join(root, "sub");
      mkdirSync(sub);
      const insideFile = join(root, "inside.txt");
      writeFileSync(insideFile, "inside");

      expect(isInFolder(root, "sub/../inside.txt")).toBe(true);
      {
        expect(resolveFolderPath(root, "sub/../inside.txt")).toBe(insideFile);
      }
    });
  });

  // 6. Windows drive-root and trailing separator behavior
  describe("Windows drive root and trailing separator behavior", () => {
    it.runIf(process.platform === "win32")("accepts legitimate descendants of Windows drive root", () => {
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const driveRoot = resolve(systemRoot).slice(0, 3);
      expect(driveRoot.endsWith(sep)).toBe(true);
      expect(isInFolder(driveRoot, driveRoot)).toBe(true);
      expect(isInFolder(driveRoot, systemRoot)).toBe(true);

      {
        expect(resolveFolderPath(driveRoot, systemRoot)).toBe(realpathSync(systemRoot));
      }
    });

    it("accepts descendants and rejects siblings when the folder is specified with a trailing separator", () => {
      const parent = createTempDir("0-test-folder-trailing-");
      const authorized = join(parent, "authorized");
      const sibling = join(parent, "authorized-sibling");
      mkdirSync(authorized);
      mkdirSync(sibling);
      const childFile = join(authorized, "inside.txt");
      const siblingFile = join(sibling, "secret.txt");
      writeFileSync(childFile, "inside");
      writeFileSync(siblingFile, "secret");

      const authorizedWithSep = authorized + sep;
      expect(isInFolder(authorizedWithSep, childFile)).toBe(true);
      expect(isInFolder(authorizedWithSep, "inside.txt")).toBe(true);
      expect(isInFolder(authorizedWithSep, siblingFile)).toBe(false);
      expect(isInFolder(authorizedWithSep, "../authorized-sibling/secret.txt")).toBe(false);

      {
        expect(resolveFolderPath(authorizedWithSep, childFile)).toBe(childFile);
        expect(resolveFolderPath(authorizedWithSep, "inside.txt")).toBe(childFile);
        expect(() => resolveFolderPath(authorizedWithSep, siblingFile)).toThrow(/escapes the folder/);
        expect(() => resolveFolderPath(authorizedWithSep, "../authorized-sibling/secret.txt")).toThrow(/escapes the folder/);
      }
    });
  });

  // 7. Symlink escape behavior
  describe("symlink escape behavior", () => {
    it("rejects symlinks that point outside the folder", () => {
      const parent = createTempDir("0-test-folder-symlink-");
      const root = join(parent, "authorized");
      mkdirSync(root);
      const secret = join(parent, "secret.txt");
      writeFileSync(secret, "secret data");

      const linkToOutside = join(root, "escape-link");
      symlinkSync(secret, linkToOutside);

      expect(isInFolder(root, "escape-link")).toBe(false);
      expect(isInFolder(root, linkToOutside)).toBe(false);

      {
        expect(() => resolveFolderPath(root, "escape-link")).toThrow(/escapes the folder/);
        expect(() => resolveFolderPath(root, linkToOutside)).toThrow(/escapes the folder/);
      }
    });

    it("accepts symlinks that point to locations within the folder", () => {
      const root = createTempDir("0-test-folder-internal-symlink-");
      const target = join(root, "real.txt");
      writeFileSync(target, "real content");

      const linkToInside = join(root, "internal-link");
      symlinkSync(target, linkToInside);

      expect(isInFolder(root, "internal-link")).toBe(true);
      expect(isInFolder(root, linkToInside)).toBe(true);

      {
        expect(resolveFolderPath(root, "internal-link")).toBe(target);
        expect(resolveFolderPath(root, linkToInside)).toBe(target);
      }
    });

    it("rejects dangling symlinks targeting nonexistent paths outside the folder", () => {
      const root = createTempDir("0-test-folder-dangling-outside-");
      const linkToOutside = join(root, "dangling-outside");
      symlinkSync("/nonexistent/outside/secret.txt", linkToOutside);

      expect(isInFolder(root, "dangling-outside")).toBe(false);
      expect(isInFolder(root, linkToOutside)).toBe(false);

      {
        expect(() => resolveFolderPath(root, "dangling-outside")).toThrow(/escapes the folder/);
        expect(() => resolveFolderPath(root, linkToOutside)).toThrow(/escapes the folder/);
      }
    });

    it("rejects dangling symlinks targeting nonexistent paths inside the folder", () => {
      const root = createTempDir("0-test-folder-dangling-inside-");
      const linkToInside = join(root, "dangling-inside");
      symlinkSync(join(root, "nonexistent-target.txt"), linkToInside);

      expect(isInFolder(root, "dangling-inside")).toBe(false);
      expect(isInFolder(root, linkToInside)).toBe(false);

      {
        expect(() => resolveFolderPath(root, "dangling-inside")).toThrow(/escapes the folder/);
        expect(() => resolveFolderPath(root, linkToInside)).toThrow(/escapes the folder/);
      }
    });

    it("rejects dangling symlinks with relative link targets", () => {
      const root = createTempDir("0-test-folder-dangling-rel-");
      const linkRel = join(root, "dangling-rel");
      symlinkSync("nonexistent-relative.txt", linkRel);

      expect(isInFolder(root, "dangling-rel")).toBe(false);
      expect(isInFolder(root, linkRel)).toBe(false);

      {
        expect(() => resolveFolderPath(root, "dangling-rel")).toThrow(/escapes the folder/);
        expect(() => resolveFolderPath(root, linkRel)).toThrow(/escapes the folder/);
      }
    });

    it("preserves resolution of non-existent regular files to be created within the folder", () => {
      const root = createTempDir("0-test-folder-new-file-");
      const newFile = join(root, "new-file.txt");

      expect(isInFolder(root, "new-file.txt")).toBe(true);
      expect(isInFolder(root, newFile)).toBe(true);

      {
        expect(resolveFolderPath(root, "new-file.txt")).toBe(newFile);
        expect(resolveFolderPath(root, newFile)).toBe(newFile);
      }
    });
  });
});
