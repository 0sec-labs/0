#!/usr/bin/env node
// test-changed: run only the checks a diff can affect (see "Fast checks" in docs/CONTRIBUTING.md).
// Usage: node scripts/test-changed.mjs [--dry-run] [--all] [--base <ref>] [--budget <s>] [--no-typecheck]
// Not a gate for main: CI and scripts/ci-local.sh (without --fast) still run everything.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { affectedTests, classify, closures, directDeps, dirSet } from "./lib/test-changed-map.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const dry = flag("--dry-run");
const budget = Number(opt("--budget") ?? 0);
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 26 }).trim();
const lines = (s) => s.split("\n").filter(Boolean);

let base = opt("--base");
if (!base) { try { base = git("merge-base", "HEAD", "origin/main"); } catch { base = "HEAD"; } }
let changed;
try {
  changed = [...new Set([...lines(git("diff", "--name-only", base)), ...lines(git("ls-files", "--others", "--exclude-standard"))])].sort();
} catch (e) { console.error(`[test:changed] cannot compute diff against ${base}: ${e.message}`); process.exit(2); }

const tracked = new Set([...lines(git("ls-files")), ...lines(git("ls-files", "--others", "--exclude-standard"))].filter((f) => existsSync(f)));
const scriptTests = [...tracked].filter((f) => /^scripts\/[^/]+\.test\.mjs$/.test(f)).sort();
const plan = classify(changed, { existing: (f) => tracked.has(f), testFiles: scriptTests });
const full = flag("--all") ? "--all flag" : plan.full;

// Per-file direct-import cache keyed by mtime; the transitive closure is recomputed every run so a
// changed import inside a source file is always seen.
const cachePath = resolve(root, "node_modules/.cache/test-changed.json");
const ver = statSync(resolve(root, "scripts/lib/test-changed-map.mjs")).mtimeMs; // mapper edits invalidate the cache
let cache = { v: ver, files: {} };
try { const c = JSON.parse(readFileSync(cachePath, "utf8")); if (c.v === ver) cache = c; } catch {}
const dirs = dirSet(tracked);
let cacheDirty = false;
const direct = (f, isTest) => {
  const m = statSync(f).mtimeMs;
  const key = `${isTest ? "t" : "s"}:${f}`;
  let e = cache.files[key];
  if (!e || e.m !== m) {
    const d = directDeps(f, readFileSync(f, "utf8"), tracked, dirs, { isTest });
    e = cache.files[key] = { m, files: [...d.files], dirs: [...d.dirs] };
    cacheDirty = true;
  }
  return { files: new Set(e.files), dirs: new Set(e.dirs) };
};

const steps = [];
const pnpm = (...a) => ({ cmd: "pnpm", args: a });
steps.push({ name: "architecture check", ...pnpm("check:architecture") }, { name: "architecture tests", cmd: "node", args: ["--test", "scripts/check-architecture.test.mjs"] });

let summary;
let hits = [];
if (full) {
  summary = `FULL suite (${full})`;
  steps.push({ name: "typecheck (all)", ...pnpm("lint") }, { name: "full test suite", ...pnpm("test") });
} else {
  const srcFiles = changed.filter((f) => tracked.has(f) && !/\.(?:md|mdx|png|svg|jpe?g)$/.test(f));
  if (!flag("--no-typecheck"))
    for (const p of plan.typecheck) steps.push({ name: `typecheck @0/${p}`, ...pnpm("--filter", `@0/${p}`, "exec", "tsc", "--noEmit", ...(p === "bench" ? ["-p", "tsconfig.typecheck.json"] : [])) });
  for (const [p, m] of Object.entries(plan.packages)) {
    if (m.mode === "all" || srcFiles.length > 300)
      steps.push({ name: `vitest @0/${p} (whole package: ${m.mode === "all" ? m.reason : ">300 files changed"})`, ...pnpm("--filter", `@0/${p}`, "exec", "vitest", "run") });
    else
      steps.push({ name: `vitest related @0/${p} (${m.reason})`, ...pnpm("--filter", `@0/${p}`, "exec", "vitest", "related", "--run", "--passWithNoTests", ...srcFiles.map((f) => resolve(root, f))) });
  }
  hits = plan.scriptTests.mode === "all"
    ? scriptTests.map((test) => ({ test, why: plan.scriptTests.reason }))
    : affectedTests(closures(scriptTests, direct), changed);
  if (hits.length) steps.push({ name: `node --test ${hits.length} script test file(s)`, cmd: "node", args: ["--test", ...hits.map((h) => h.test)] });
  if (plan.docs) steps.push({ name: "docs checks", cmd: "sh", args: ["-c", "pnpm docs:check && pnpm check:docs-commands && pnpm test:docs-pointers && pnpm test:docs-commands"] });
  if (plan.releaseNotes) steps.push({ name: "release notes", cmd: "sh", args: ["-c", "pnpm check:release-notes && pnpm test:release-notes"] });
  const pk = Object.entries(plan.packages).map(([p, m]) => `${p}:${m.mode}`).join(" ") || "none";
  summary = `${changed.length} changed file(s) since ${base.slice(0, 8)}: vitest [${pk}], running ${hits.length} of ${scriptTests.length} script test files because they depend on the change, typecheck [${plan.typecheck.join(" ") || "none"}], docs ${plan.docs ? "yes" : "no"}, release-notes ${plan.releaseNotes ? "yes" : "no"}, architecture always`;
}
if (cacheDirty) { try { mkdirSync(dirname(cachePath), { recursive: true }); writeFileSync(cachePath, JSON.stringify(cache)); } catch {} }

console.log(`[test:changed] ${summary}`);
for (const h of hits) console.log(`  - ${h.test}: ${h.why}`);
for (const s of steps) console.log(`  > ${s.name}`);
if (dry) { console.log("[test:changed] --dry-run: nothing executed"); process.exit(0); }
if (budget) console.log(`[test:changed] soft budget ${budget}s (informational; bypass a hook with --no-verify)`);

const t0 = Date.now();
const failed = [];
for (const s of steps) {
  console.log(`\n[test:changed] ==> ${s.name}`);
  const t = Date.now();
  const ok = spawnSync(s.cmd, s.args, { stdio: "inherit", cwd: root }).status === 0;
  console.log(`[test:changed] ${ok ? "ok" : "FAILED"}: ${s.name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  if (!ok) failed.push(s.name);
}
const secs = Math.round((Date.now() - t0) / 1000);
console.log(`\n[test:changed] ${failed.length ? "RED" : "GREEN"} in ${secs}s${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
if (budget && secs > budget) console.log(`[test:changed] over the ${budget}s soft budget; narrow the change or push WIP with --no-verify`);
process.exit(failed.length ? 1 : 0);
