// Pure mapping logic for scripts/test-changed.mjs: changed files -> what must run.
// No I/O here (callers inject the file list and a reader) so it is unit-testable.
import { posix } from "node:path";

export const PACKAGES = ["engine", "bench", "cli", "web"];
// Packages that import each package (a change there can break these).
export const DEPENDANTS = { engine: ["bench", "cli", "web"], bench: ["cli"], cli: [], web: [] };
const SRC_EXT = /\.(?:[cm]?[jt]sx?)$/;
const RESOLVE_EXT = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx", ".json", ".css"];
const PKG_BASES = ["", "packages/web/", "packages/cli/", "packages/engine/", "packages/bench/", "docs/"];

const FULL_RULES = [
  [/^package\.json$/, "root package.json"],
  [/^pnpm-lock\.yaml$/, "pnpm-lock.yaml"],
  [/^pnpm-workspace\.yaml$/, "pnpm-workspace.yaml"],
  [/^tsconfig[^/]*$/, "root tsconfig"],
  [/^scripts\/config\/(?:tsconfig|vitest)[^/]*$/, "shared tsconfig/vitest config"],
  [/^\.github\/workflows\//, "GitHub workflow"],
  [/^\.github\/actions\//, "GitHub CI action"],
  [/^scripts\/ci-[^/]*\.sh$/, "CI script"],
  [/(?:^|\/)(?:vitest|playwright)[^/]*\.config\.[cm]?[jt]s$/, "vitest/playwright config"],
];

/** First rule that forces the full suite, or null. */
export function fullReason(changed) {
  for (const f of changed) for (const [re, why] of FULL_RULES) if (re.test(f)) return `${why} changed (${f})`;
  return null;
}

const pkgOf = (f) => /^packages\/([^/]+)\//.exec(f)?.[1] ?? null;
const PKG_WIDE = /^packages\/[^/]+\/(?:package\.json|tsconfig[^/]*|vitest[^/]*|test\/(?:setup|helpers|fixtures)[^/]*|(?:src\/)?(?:test-setup|setup)[^/]*)$/;

/**
 * Decide the plan. `changed` = repo-relative paths; `existing` = predicate for files still on disk
 * (deleted files cannot be mapped through the graph so they widen the scope).
 */
export function classify(changed, { existing = () => true, testFiles = [] } = {}) {
  const plan = {
    full: null,
    packages: {}, // name -> {mode: "related"|"all", reason}
    scriptTests: { mode: "mapped", reason: "" },
    docs: false,
    releaseNotes: false,
    architecture: true,
    typecheck: [],
  };
  plan.full = fullReason(changed);
  const touched = new Set();
  for (const f of changed) {
    const p = pkgOf(f);
    if (p && PACKAGES.includes(p)) touched.add(p);
    if (p && PKG_WIDE.test(f)) plan.packages[p] = { mode: "all", reason: `${f} changed` };
    if (p && PACKAGES.includes(p) && !existing(f) && SRC_EXT.test(f) && !/\.test\./.test(f) && !plan.packages[p])
      plan.packages[p] = { mode: "all", reason: `${f} deleted` };
    if (!p && !existing(f) && SRC_EXT.test(f) && f.startsWith("scripts/") && !testFiles.includes(f))
      plan.scriptTests = { mode: "all", reason: `${f} deleted` };
  }
  for (const p of touched) if (!plan.packages[p]) plan.packages[p] = { mode: "related", reason: "source/test files changed" };
  // Dependants only need the files that import the change: `related` finds them when they resolve to
  // source (bench aliases engine); typecheck covers the rest.
  for (const p of [...touched]) for (const d of DEPENDANTS[p]) if (!plan.packages[d]) plan.packages[d] = { mode: "related", reason: `depends on ${p}` };
  const tc = new Set(touched);
  for (const p of touched) for (const d of DEPENDANTS[p]) tc.add(d);
  plan.typecheck = PACKAGES.filter((p) => tc.has(p));
  plan.docs = changed.some((f) => /^(?:docs\/|README\.md$|scripts\/(?:sync-cli-docs|check-docs|docs-code)|packages\/cli\/src\/commands\/)/.test(f));
  plan.releaseNotes = changed.some((f) => /(?:^|\/)CHANGELOG[^/]*$|^package\.json$|(?:^|\/)releases\.ts$|^scripts\/(?:check-)?release-notes/.test(f));
  return plan;
}

// ---- static import graph for scripts/*.test.mjs ----

function* strings(text) {
  const re = /(['"`])((?:\\.|(?!\1)[^\\\n]){1,240})\1/g;
  let m;
  while ((m = re.exec(text))) yield m[2];
}
const IMPORT_RES = [
  /\bfrom\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*(['"])([^'"\n]+)\1/g,
  /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];
export function importSpecs(text) {
  const out = new Set();
  for (const re of IMPORT_RES) for (const m of text.matchAll(re)) out.add(m[2]);
  return [...out];
}

/** Resolve one candidate path (repo-relative, normalised) to a tracked file or null. */
function tryFile(p, files) {
  const base = p.replace(/\.(?:js|mjs|jsx)$/, "");
  for (const ext of RESOLVE_EXT) if (files.has(p + ext)) return p + ext;
  if (base !== p) for (const ext of [".ts", ".tsx", ".mts"]) if (files.has(base + ext)) return base + ext;
  for (const idx of ["index.ts", "index.tsx", "index.js", "index.mjs"]) if (files.has(`${p}/${idx}`)) return `${p}/${idx}`;
  return null;
}

const ENGINE_SUBPATHS = ["storage", "shared", "templates", "redteam"];
/** Candidate repo-relative paths for an import specifier seen in `fromFile` (or `null` fromFile = repo-root/test bundler context). */
export function specCandidates(spec, fromFile) {
  const dir = fromFile ? posix.dirname(fromFile) : "";
  const pkg = fromFile ? pkgOf(fromFile) : null;
  if (spec.startsWith("@/")) return [`packages/${pkg ?? "web"}/src/${spec.slice(2)}`, `packages/web/src/${spec.slice(2)}`];
  const ws = /^@0\/(engine|bench)(?:\/(.+))?$/.exec(spec);
  if (ws) {
    const [, name, sub] = ws;
    if (!sub) return [`packages/${name}/src/index.ts`];
    return [`packages/${name}/src/${sub}`, ...(ENGINE_SUBPATHS.includes(sub) ? [`packages/${name}/src/${sub}/index.ts`] : []), `packages/${name}/src/${sub}.ts`];
  }
  if (spec.startsWith(".")) {
    const abs = posix.normalize(posix.join(dir, spec));
    // A test's embedded esbuild bundle resolves './src/x' against a package dir, not the test file.
    if (!fromFile || /^scripts\//.test(fromFile)) return [abs, ...PKG_BASES.slice(1).map((b) => posix.normalize(b + spec))];
    return [abs];
  }
  return []; // bare package (node_modules): not a repo dependency
}

/**
 * Direct dependencies of one file. Source files: import specifiers only. Test files additionally
 * contribute path-like string literals (fixtures, spawned scripts, esbuild entry paths) and directories.
 * Returns {files:Set, dirs:Set}.
 */
export function directDeps(file, text, files, dirs, { isTest = false } = {}) {
  const out = { files: new Set(), dirs: new Set() };
  const add = (cands) => { for (const c of cands) { const r = tryFile(posix.normalize(c), files); if (r && r !== file) { out.files.add(r); return true; } } return false; };
  for (const spec of importSpecs(text)) add(specCandidates(spec, isTest ? null : file) .concat(isTest ? specCandidates(spec, file) : []));
  if (isTest) {
    const tdir = posix.dirname(file);
    // Paths inside template literals with ${...} (e.g. `export * from '${resolve(root,"packages/web/src/x.ts")}'`).
    for (const m of text.matchAll(/\b(?:packages|scripts|docs)\/[\w./@-]+\.(?:[cm]?[jt]sx?|json|css)\b/g)) add([m[0]]);
    for (const s of strings(text)) {
      if (/\s|\$\{|^https?:|^node:/.test(s) || !/[./]/.test(s)) continue;
      const clean = s.replace(/[#?:].*$/, "").replace(/\/+$/, "");
      if (!clean || clean === "." || /^(?:\.\.\/?)+$/.test(clean)) continue;
      const bare = clean.replace(/^\.\//, "");
      const cands = [];
      if (clean.startsWith(".")) cands.push(posix.normalize(posix.join(tdir, clean)));
      if (/^(?:src|test)\//.test(bare)) cands.push(...PKG_BASES.map((b) => b + bare));
      else if (!clean.startsWith("..")) cands.push(bare, posix.join(tdir, bare));
      const norm = cands.map((c) => posix.normalize(c));
      if (!add(norm)) for (const d of norm) if (dirs.has(d)) out.dirs.add(d);
    }
  }
  return out;
}

export function dirSet(files) {
  const dirs = new Set();
  for (const f of files) for (let d = posix.dirname(f); d !== "." && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
  return dirs;
}

/**
 * Transitive closure for each test. `direct(file, isTest)` -> {files, dirs} (cached by the caller).
 * Returns Map(test -> {files:Set, dirs:Set}). Bare package-root / `scripts` directories are dropped when
 * the test already resolves a concrete file (they would otherwise make every change match).
 */
export function closures(tests, direct) {
  const result = new Map();
  for (const t of tests) {
    const seen = new Set([t]);
    const dirsOut = new Set();
    const stack = [t];
    while (stack.length) {
      const f = stack.pop();
      const d = direct(f, f === t);
      for (const x of d.dirs) dirsOut.add(x);
      for (const x of d.files) if (!seen.has(x)) { seen.add(x); if (SRC_EXT.test(x)) stack.push(x); }
    }
    const broad = (d) => d === "scripts" || d === "packages" || /^packages\/[^/]+$/.test(d) || d === "docs";
    const concrete = seen.size > 1;
    result.set(t, { files: seen, dirs: new Set([...dirsOut].filter((d) => !(concrete && broad(d)))), concrete: concrete || dirsOut.size > 0 });
  }
  return result;
}

/** Tests to run: own file changed, a transitive dep changed, a referenced dir changed, or unmapped (no deps found). */
export function affectedTests(graph, changed) {
  const hit = [];
  for (const [test, g] of graph) {
    let why = null;
    if (!g.concrete) why = "no static deps found (always runs)";
    else for (const c of changed) {
      if (g.files.has(c)) { why = c === test ? "test file changed" : `depends on ${c}`; break; }
      for (const d of g.dirs) if (c.startsWith(d + "/")) { why = `reads ${d}/`; break; }
      if (why) break;
    }
    if (why) hit.push({ test, why });
  }
  return hit;
}
