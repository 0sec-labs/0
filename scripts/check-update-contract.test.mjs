import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkUpdateContract } from "./check-update-contract.mjs";

const repo = join(import.meta.dirname, "..");
const files = [".github/workflows/release.yml", "install.sh", "packages/cli/src/utils/update-check.ts", "docs/public/_redirects"];

function copy() {
  const root = mkdtempSync(join(tmpdir(), "update-contract-"));
  for (const f of files) { mkdirSync(dirname(join(root, f)), { recursive: true }); cpSync(join(repo, f), join(root, f)); }
  return root;
}

test("the repository satisfies the update contract", () => {
  assert.deepEqual(checkUpdateContract(repo), []);
});

test("renaming a release asset is caught", () => {
  const root = copy();
  const p = join(root, ".github/workflows/release.yml");
  writeFileSync(p, readFileSync(p, "utf8").replaceAll("0-linux-x64", "0-linux-amd64"));
  assert.ok(checkUpdateContract(root).some((e) => e.includes("0-linux")));
});

test("dropping the legacy slug fallback is caught", () => {
  const root = copy();
  const p = join(root, "packages/cli/src/utils/update-check.ts");
  writeFileSync(p, readFileSync(p, "utf8").replace(/const LEGACY_REPO = "[^"]+";/, ""));
  assert.ok(checkUpdateContract(root).some((e) => e.includes("fallback slug")));
});
