import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkArchitecture, extractSpecifiers, findCycles } from "./check-architecture.mjs";

const ENGINE_EXPORTS = { ".": {}, "./shared": {}, "./storage": {}, "./dist/*": "./dist/*" };

function fixture(files, { engineExports = ENGINE_EXPORTS, deps = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "arch-"));
  const pkg = (dir, name, extra = {}) => put(`packages/${dir}/package.json`, JSON.stringify({ name, ...extra }));
  const put = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  pkg("engine", "@0/engine", { exports: engineExports, dependencies: deps.engine });
  pkg("cli", "@0/cli", { dependencies: deps.cli });
  pkg("web", "@0/web", { dependencies: deps.web });
  pkg("bench", "@0/bench", { exports: { "./thing": {} }, dependencies: deps.bench });
  for (const [rel, content] of Object.entries(files)) put(rel, content);
  return { root, errors: () => checkArchitecture({ root }).errors, result: () => checkArchitecture({ root }) };
}

function run(files, opts) {
  const f = fixture(files, opts);
  try { return f.result(); } finally { rmSync(f.root, { recursive: true, force: true }); }
}

test("clean layering passes", () => {
  const { errors } = run({
    "packages/cli/src/a.ts": 'import { x } from "@0/engine";\nimport "@0/engine/shared";\nimport("@0/bench/thing");',
    "packages/web/src/a.ts": 'import { x } from "@0/engine/shared";',
    "packages/bench/src/a.ts": 'export * from "@0/engine";',
  }, { deps: { cli: { "@0/engine": "*", "@0/bench": "*" }, web: { "@0/engine": "*" }, bench: { "@0/engine": "*" } } });
  assert.deepEqual(errors, []);
});

test("engine importing cli, web or bench fails (import, export-from, dynamic, vi.mock)", () => {
  const { errors } = run({
    "packages/engine/src/a.ts": 'import x from "@0/cli";',
    "packages/engine/src/b.ts": 'export * from "@0/web";',
    "packages/engine/src/c.ts": 'await import("@0/bench/thing");',
    "packages/engine/src/c.test.ts": 'vi.mock("@0/cli", () => ({}));',
  });
  assert.equal(errors.length, 5); // the bench import trips both the engine rule and the bench-importer rule
  assert.match(errors.join("\n"), /engine must not depend on the CLI/);
  assert.match(errors.join("\n"), /packages\/engine\/src\/c\.test\.ts/);
});

test("web importing cli or bench fails", () => {
  const { errors } = run({
    "packages/web/src/a.ts": 'import "@0/cli";',
    "packages/web/test/b.test.ts": 'import "@0/bench/thing";',
  });
  assert.equal(errors.length, 3);
});

test("cli importing @0/web or packages/web/src fails", () => {
  const { errors } = run({
    "packages/cli/src/a.ts": 'import "@0/web";',
    "packages/cli/test/b.test.ts": 'import "../../web/src/x";',
  });
  assert.equal(errors.length, 2);
  assert.match(errors.join("\n"), /reaches into packages\/web/);
});

test("bench may be imported by cli only", () => {
  const { errors } = run({
    "packages/cli/src/a.ts": 'import "@0/bench/thing";',
    "packages/web/src/a.ts": 'import "@0/bench/thing";',
    "packages/engine/src/a.ts": 'import "@0/bench/thing";',
  });
  assert.equal(errors.filter((e) => e.startsWith("packages/cli")).length, 0);
  assert.equal(errors.filter((e) => /only @0\/cli/.test(e)).length, 2);
});

test("package.json dependencies obey the same rules", () => {
  const { errors } = run({}, { deps: { engine: { "@0/cli": "workspace:*" } } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /packages\/engine\/package\.json/);
});

test("deep imports bypassing exports fail unless allow-listed", () => {
  const { errors } = run({
    "packages/cli/src/a.ts": 'import "@0/engine/dist/storage/x.js";',
    "packages/cli/src/b.ts": 'import "@0/engine/dist/report-formatters/html.js";',
    "packages/cli/src/c.ts": 'import "@0/engine/dist/agent/skills/index.js";',
    "packages/cli/src/d.ts": 'import "@0/engine/storage";',
    "packages/web/src/e.ts": 'import "@0/engine/dist/report-formatters/html.js";',
    "packages/web/src/f.ts": 'import "@0/engine/dist/shared/finding-priority.js";',
  });
  assert.deepEqual(errors.map((e) => e.split(":")[0]).sort(), ["packages/cli/src/a.ts", "packages/web/src/e.ts"]);
  assert.match(errors[0], /bypasses the exports map/);
});

test("relative imports across packages fail", () => {
  const { errors } = run({ "packages/bench/test/a.test.ts": 'import "../../engine/src/scanner.js";' });
  assert.equal(errors.length, 1);
});

test("engine directory cycles: new ones fail, baselined ones only warn", () => {
  const files = {
    "packages/engine/src/a/x.ts": 'import "../b/y.js";',
    "packages/engine/src/b/y.ts": 'import "../a/x.js";',
    "packages/engine/src/c/z.ts": 'import "../a/x.js";',
  };
  const f = fixture(files);
  try {
    const first = f.result();
    assert.deepEqual(first.cycles, [["a", "b"]]);
    assert.equal(first.errors.length, 1);
    assert.match(first.errors[0], /new directory cycle among \{a, b\}/);
    mkdirSync(join(f.root, "scripts"), { recursive: true });
    writeFileSync(join(f.root, "scripts/architecture-baseline.json"), JSON.stringify({ engineDirectoryCycles: ["a,b"] }));
    const second = f.result();
    assert.deepEqual(second.errors, []);
    assert.match(second.warnings.join("\n"), /cycles: 1 \(baseline 1\)/);
    writeFileSync(join(f.root, "packages/engine/src/b/w.ts"), 'import "../c/z.js";');
    assert.equal(f.result().errors.length, 1, "a grown cycle is new");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("helpers", () => {
  assert.deepEqual(extractSpecifiers('import a from "@0/x"; export {b} from \'@0/y\'; vi.mock("@0/z"); import("./w")'), ["@0/x", "@0/y", "@0/z", "./w"]);
  assert.deepEqual(findCycles(new Map([["a", new Set(["b"])], ["b", new Set(["a"])], ["c", new Set()]])), [["a", "b"]]);
});
