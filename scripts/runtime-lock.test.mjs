import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the published runtime supports a locked production install", () => {
  const directory = mkdtempSync(join(tmpdir(), "zero-runtime-lock-"));
  try {
    copyFileSync(join(repoRoot, "dist/package.json"), join(directory, "package.json"));
    copyFileSync(join(repoRoot, "scripts/dist-package-lock.json"), join(directory, "package-lock.json"));
    const result = spawnSync("npm", [
      "ci", "--omit=dev", "--ignore-scripts", "--dry-run", "--no-audit", "--no-fund",
    ], { cwd: directory, encoding: "utf8", timeout: 30_000, shell: process.platform === "win32" });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

