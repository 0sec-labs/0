import assert from "node:assert/strict";
import test from "node:test";
import { affectedTests, classify, closures, directDeps, dirSet, fullReason, importSpecs, specCandidates } from "./lib/test-changed-map.mjs";

const files = new Set([
  "scripts/a.test.mjs", "scripts/b.test.mjs", "scripts/c.test.mjs", "scripts/d.test.mjs", "scripts/e.test.mjs",
  "packages/web/src/lib/x.ts", "packages/web/src/lib/y.ts", "packages/web/src/components/button.tsx",
  "packages/engine/src/index.ts", "packages/engine/src/storage/index.ts", "docs/guide.md", "install.sh",
]);
const dirs = dirSet(files);
const texts = {
  "scripts/a.test.mjs": `await build({stdin:{contents:\`import{x}from'./src/lib/x';\`,resolveDir:resolve(root,'packages/web')}})`,
  "scripts/b.test.mjs": `import { b } from "../packages/web/src/components/button.tsx";`,
  "scripts/c.test.mjs": `readFileSync(new URL("../install.sh", import.meta.url))`,
  "scripts/d.test.mjs": `import test from "node:test"; test("nothing static", () => {});`,
  "scripts/e.test.mjs": "const g = resolve(root, 'docs/');",
  "packages/web/src/lib/x.ts": `import { y } from "@/lib/y"; import "react";`,
  "packages/web/src/lib/y.ts": `export const y = 1;`,
  "packages/web/src/components/button.tsx": `import { y } from "../lib/y.js";`,
};
const graph = () => closures([...files].filter((f) => f.endsWith(".test.mjs")).sort(), (f, isTest) => {
  const d = directDeps(f, texts[f] ?? "", files, dirs, { isTest });
  return d;
});

test("import specs: static, dynamic, side-effect, require", () => {
  assert.deepEqual(importSpecs(`import a from "./a"; import "./b"; await import('./c'); require("d"); export * from './e'`).sort(), ["./a", "./b", "./c", "./e", "d"]);
});

test("spec candidates: web alias, workspace alias, relative", () => {
  assert.ok(specCandidates("@/lib/y", "packages/web/src/lib/x.ts").includes("packages/web/src/lib/y"));
  assert.deepEqual(specCandidates("@0/engine", "packages/cli/src/a.ts"), ["packages/engine/src/index.ts"]);
  assert.ok(specCandidates("@0/engine/storage", "x.ts").includes("packages/engine/src/storage/index.ts"));
  assert.deepEqual(specCandidates("react", "x.ts"), []);
});

test("transitive source deps reach the test (alias, .js->.tsx/.ts, embedded bundler entry)", () => {
  const g = graph();
  assert.ok(g.get("scripts/a.test.mjs").files.has("packages/web/src/lib/y.ts"));
  assert.ok(g.get("scripts/b.test.mjs").files.has("packages/web/src/lib/y.ts"));
});

test("affected: only tests whose closure intersects the change", () => {
  const hit = (c) => affectedTests(graph(), c).map((h) => h.test);
  assert.deepEqual(hit(["packages/web/src/lib/y.ts"]), ["scripts/a.test.mjs", "scripts/b.test.mjs", "scripts/d.test.mjs"]);
  assert.deepEqual(hit(["install.sh"]), ["scripts/c.test.mjs", "scripts/d.test.mjs"]);
  assert.deepEqual(hit(["scripts/e.test.mjs"]), ["scripts/d.test.mjs", "scripts/e.test.mjs"]);
  assert.deepEqual(hit(["docs/guide.md"]), ["scripts/d.test.mjs", "scripts/e.test.mjs"]);
  assert.deepEqual(hit(["packages/engine/src/index.ts"]), ["scripts/d.test.mjs"]);
});

test("tests with no static deps always run (unmapped is never skipped)", () => {
  assert.equal(graph().get("scripts/d.test.mjs").concrete, false);
});

test("full-suite rules", () => {
  for (const f of ["package.json", "pnpm-lock.yaml", "tsconfig.json", "tsconfig.base.json", ".github/workflows/main.yml", "scripts/ci-local.sh", "packages/web/vitest.config.ts", "scripts/config/vitest.workspace-aliases.ts", "playwright.config.ts"])
    assert.ok(fullReason([f]), f);
  for (const f of ["packages/web/package.json", "packages/web/src/a.ts", "docs/a.md", "scripts/test-changed.mjs"]) assert.equal(fullReason([f]), null, f);
});

test("classify: web component -> web only, typecheck web, no docs", () => {
  const p = classify(["packages/web/src/components/button.tsx"]);
  assert.deepEqual(Object.keys(p.packages), ["web"]);
  assert.deepEqual(p.typecheck, ["web"]);
  assert.equal(p.docs, false); assert.equal(p.releaseNotes, false); assert.equal(p.full, null);
});

test("classify: engine change fans out to dependants", () => {
  const p = classify(["packages/engine/src/x.ts"]);
  assert.deepEqual(p.typecheck, ["engine", "cli", "web"]);
  assert.equal(p.packages.cli.mode, "related");
});

test("classify: package.json / vitest config widens that package to whole", () => {
  assert.equal(classify(["packages/web/package.json"]).packages.web.mode, "all");
  assert.equal(classify(["packages/cli/tsconfig.json"]).packages.cli.mode, "all");
  assert.equal(classify(["packages/engine/src/gone.ts"], { existing: () => false }).packages.engine.mode, "all");
});

test("classify: docs and release-notes triggers", () => {
  assert.equal(classify(["docs/src/a.md"]).docs, true);
  assert.equal(classify(["README.md"]).docs, true);
  assert.equal(classify(["packages/cli/src/commands/run.ts"]).docs, true);
  assert.equal(classify(["packages/web/src/a.ts"]).docs, false);
  assert.equal(classify(["docs/CHANGELOG.md"]).releaseNotes, true);
  assert.equal(classify(["packages/engine/src/releases.ts"]).releaseNotes, true);
  assert.equal(classify(["packages/web/src/a.ts"]).releaseNotes, false);
});

test("classify: docs-only diff touches no package suites", () => {
  const p = classify(["docs/guide.md"]);
  assert.deepEqual(p.packages, {}); assert.deepEqual(p.typecheck, []); assert.equal(p.architecture, true);
});
