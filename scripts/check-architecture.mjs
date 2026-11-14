#!/usr/bin/env node
/**
 * Architecture guardrails for the packages/* layering. Plain node, no dependencies.
 *
 *   engine  <-  cli, web, bench        (engine depends on none of them)
 *   web     ->  engine only
 *   cli     ->  engine, bench (the one allowed bench edge), built web assets (never web/src)
 *   bench   ->  engine only; never shipped
 *
 * Usage: node scripts/check-architecture.mjs [--update-baseline]
 * See docs/design/architecture.md.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Import edges `from` -> `to` that are forbidden. `*` matches any package. */
export const FORBIDDEN_EDGES = [
  { from: "engine", to: "cli", why: "the engine must not depend on the CLI" },
  { from: "engine", to: "web", why: "the engine must not depend on the web app" },
  { from: "engine", to: "bench", why: "the engine must not depend on bench" },
  { from: "web", to: "cli", why: "web may only depend on the engine" },
  { from: "web", to: "bench", why: "web may only depend on the engine" },
  { from: "cli", to: "web", why: "cli may consume only the built web assets, never @0/web or packages/web/src" },
  { from: "bench", to: "cli", why: "bench may only depend on the engine" },
  { from: "bench", to: "web", why: "bench may only depend on the engine" },
];

/** The only package allowed to import bench (besides repo-level scripts/, which are not scanned). */
export const BENCH_IMPORTERS = ["cli"]; // cli's `bench` command drives the benchmark runners.

/**
 * Documented deep entries that bypass a package's `exports` map (the engine exposes
 * `./dist/*`). `only` restricts which packages may use the entry.
 */
export const ALLOWED_DEEP = [
  { prefix: "@0/engine/dist/report-formatters/", only: ["cli"] }, // cli/src/formatters re-export these
  { prefix: "@0/engine/dist/agent/skills/", only: ["cli"] }, // skills registry tests
  // Browser-safe leaf modules. The `@0/engine/shared` barrel also re-exports node:fs/os/path
  // users (paths.ts, constants.ts) that cannot be bundled for the browser, so web imports the leaves.
  { prefix: "@0/engine/dist/shared/", only: ["web"] },
];

/**
 * Individually justified exceptions: `file` (repo-relative) may use `spec` despite the rules.
 * Keep this list at or near empty.
 */
export const ALLOWED_EXCEPTIONS = [
  // Parity test: asserts every setting the web app surfaces is defined by the CLI's settings registry.
  { file: "packages/web/test/web-settings.test.ts", spec: "../../cli/src/state/settings" },
];

const SCAN_DIRS = ["src", "test"]; // scripts/ may read built files by path (digests), so it is not scanned
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);
const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const SPEC_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\bvi\.(?:mock|doMock|unmock|importActual|importMock)\s*\(\s*|\brequire\s*\(\s*)(['"`])([^'"`\n]+)\1/g;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (CODE_EXT.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

export function extractSpecifiers(source) {
  const specs = [];
  for (const m of source.matchAll(SPEC_RE)) specs.push(m[2]);
  return specs;
}

function loadPackages(root) {
  const pkgsDir = join(root, "packages");
  const packages = new Map(); // short dir name -> info
  if (!existsSync(pkgsDir)) return packages;
  for (const dir of readdirSync(pkgsDir)) {
    const pj = join(pkgsDir, dir, "package.json");
    if (!existsSync(pj)) continue;
    const json = JSON.parse(readFileSync(pj, "utf8"));
    packages.set(dir, { dir, root: join(pkgsDir, dir), name: json.name, json });
  }
  return packages;
}

function packageFiles(pkg) {
  const files = [];
  for (const d of SCAN_DIRS) walk(join(pkg.root, d), files);
  for (const name of readdirSync(pkg.root)) {
    const p = join(pkg.root, name);
    if (CODE_EXT.test(name) && statSync(p).isFile()) files.push(p);
  }
  return files;
}

function exportKeys(pkg) {
  const e = pkg.json.exports;
  if (!e || typeof e !== "object") return new Set();
  return new Set(Object.keys(e).filter((k) => !k.includes("*")));
}

/** Tarjan SCC over a Map<string, Set<string>>; returns SCCs with more than one node. */
export function findCycles(graph) {
  let index = 0;
  const idx = new Map(), low = new Map(), onStack = new Set(), stack = [], out = [];
  const visit = (v) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const v of [...graph.keys()].sort()) if (!idx.has(v)) visit(v);
  return out.sort((a, b) => a.join().localeCompare(b.join()));
}

function engineDirectoryGraph(pkg) {
  const src = join(pkg.root, "src");
  const graph = new Map();
  if (!existsSync(src)) return graph;
  for (const name of readdirSync(src)) if (statSync(join(src, name)).isDirectory() && name !== "__tests__") graph.set(name, new Set());
  for (const file of walk(src)) {
    const rel = relative(src, file).split(sep);
    if (rel.length < 2 || !graph.has(rel[0])) continue;
    if (/\.test\.[cm]?[jt]sx?$/.test(file) || rel.includes("__tests__")) continue;
    for (const spec of extractSpecifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = relative(src, resolve(dirname(file), spec)).split(sep);
      if (target[0] === ".." || target.length < 2 || !graph.has(target[0]) || target[0] === rel[0]) continue;
      graph.get(rel[0]).add(target[0]);
    }
  }
  return graph;
}

export function checkArchitecture({ root, baselinePath = join(root, "scripts", "architecture-baseline.json") } = {}) {
  const packages = loadPackages(root);
  const byName = new Map([...packages.values()].map((p) => [p.name, p]));
  const errors = [];
  const warnings = [];
  const short = (name) => byName.get(name)?.dir;

  const checkEdge = (fromPkg, targetDir, where, spec) => {
    for (const rule of FORBIDDEN_EDGES) {
      if (rule.from === fromPkg.dir && rule.to === targetDir)
        errors.push(`${where}: ${fromPkg.name} -> ${spec}: ${rule.why}`);
    }
    if (targetDir === "bench" && fromPkg.dir !== "bench" && !BENCH_IMPORTERS.includes(fromPkg.dir))
      errors.push(`${where}: ${fromPkg.name} -> ${spec}: only ${BENCH_IMPORTERS.map((d) => `@0/${d}`).join(", ")} (and repo scripts) may import bench`);
  };

  for (const pkg of packages.values()) {
    const pjRel = relative(root, join(pkg.root, "package.json"));
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dep of Object.keys(pkg.json[field] ?? {})) {
        const d = short(dep);
        if (d && d !== pkg.dir) checkEdge(pkg, d, `${pjRel} (${field})`, dep);
      }
    }
    for (const file of packageFiles(pkg)) {
      const rel = relative(root, file);
      for (const spec of extractSpecifiers(readFileSync(file, "utf8"))) {
        if (ALLOWED_EXCEPTIONS.some((e) => e.file === rel.split(sep).join("/") && e.spec === spec)) continue;
        if (spec.startsWith(".")) {
          const abs = resolve(dirname(file), spec);
          const m = relative(join(root, "packages"), abs).split(sep);
          if (m[0] !== ".." && m[0] !== pkg.dir && packages.has(m[0]))
            errors.push(`${rel}: relative import "${spec}" reaches into packages/${m[0]}; use the package name and its exports map`);
          continue;
        }
        const mm = /^(@0\/[^/]+)(\/.*)?$/.exec(spec);
        if (!mm) continue;
        const target = byName.get(mm[1]);
        const targetDir = target?.dir ?? mm[1].slice(3);
        if (targetDir === pkg.dir) continue;
        checkEdge(pkg, targetDir, rel, spec);
        if (mm[2] && target) {
          const sub = "." + mm[2];
          const allowed = ALLOWED_DEEP.some((a) => spec.startsWith(a.prefix) && (!a.only || a.only.includes(pkg.dir)));
          if (!exportKeys(target).has(sub) && !allowed)
            errors.push(`${rel}: ${spec} bypasses the exports map of ${target.name}; import a declared entry point (or add a documented ALLOWED_DEEP entry)`);
        }
      }
    }
  }

  const engine = packages.get("engine");
  let cycles = [];
  if (engine) {
    cycles = findCycles(engineDirectoryGraph(engine));
    let baseline = [];
    try { baseline = JSON.parse(readFileSync(baselinePath, "utf8")).engineDirectoryCycles ?? []; } catch { /* no baseline */ }
    const known = baseline.map((k) => new Set(k.split(",")));
    const fresh = cycles.filter((c) => !known.some((k) => c.every((d) => k.has(d))));
    warnings.push(`packages/engine/src directory cycles: ${cycles.length} (baseline ${baseline.length})`);
    for (const c of fresh)
      errors.push(`packages/engine/src: new directory cycle among {${c.join(", ")}}; break it, or (only if unavoidable) refresh with --update-baseline`);
  }
  return { errors, warnings, cycles };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const baselinePath = join(root, "scripts", "architecture-baseline.json");
  const result = checkArchitecture({ root, baselinePath });
  if (process.argv.includes("--update-baseline")) {
    writeFileSync(baselinePath, JSON.stringify({ engineDirectoryCycles: result.cycles.map((c) => c.join(",")) }, null, 2) + "\n");
    console.log(`wrote ${relative(root, baselinePath)} (${result.cycles.length} cycles)`);
    process.exit(0);
  }
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  if (result.errors.length) {
    console.error(`architecture check failed (${result.errors.length}):`);
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("architecture check passed");
}
