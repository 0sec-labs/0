import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkNoNpmPublish } from "./check-no-npm-publish.mjs";

function repo(workflow, pkg = { name: "x", private: true }) {
  const root = mkdtempSync(join(tmpdir(), "no-npm-"));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/r.yml"), workflow);
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  return root;
}

test("clean repo passes", () => {
  assert.deepEqual(checkNoNpmPublish(repo("jobs:\n  a:\n    steps:\n      - run: pnpm install\n")), []);
});
test("npm publish, tokens and registry are rejected", () => {
  const e = checkNoNpmPublish(repo("      - run: npm publish --provenance\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n"));
  assert.ok(e.length >= 4);
});
test("comments are ignored", () => {
  assert.deepEqual(checkNoNpmPublish(repo("# we no longer run npm publish\n")), []);
});
test("non-private package and publishing fields are rejected", () => {
  const e = checkNoNpmPublish(repo("a: b\n", { name: "x", publishConfig: {}, files: ["dist"] }));
  assert.equal(e.length, 3);
});
test("this repository passes", () => {
  assert.deepEqual(checkNoNpmPublish(join(import.meta.dirname, "..")), []);
});
