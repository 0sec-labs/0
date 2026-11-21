#!/usr/bin/env node
// Release pins in the docs (image tags, the GitHub Action `version:`, the compose example) must equal the CLI
// version in packages/cli/package.json, or use `latest`. The release commit runs `node scripts/bump-docs-pins.mjs <version>`
// to rewrite them; `--check` (wired into `pnpm docs:check`) fails when one lags behind.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_FILES = new Set(["changelog.md"]);
// Each rule captures a prefix, then a version of `parts` numeric components (3 = X.Y.Z, 2 = the X.Y image tag).
const RULES = [
  { re: /(0sec-labs\/0security:v?)(\d+\.\d+\.\d+)(?![\d.])/g, parts: 3 },
  { re: /(0sec-labs\/0security:v?)(\d+\.\d+)(?![\d.])/g, parts: 2 },
  { re: /(ZERO_IMAGE_TAG=v?)(\d+\.\d+\.\d+)(?![\d.])/g, parts: 3 },
  { re: /(version:\s*v?)(\d+\.\d+\.\d+)(?=\s*#\s*Pin the CLI)/g, parts: 3 },
  { re: /(0sec-labs\/0security@v)(\d+\.\d+\.\d+)(?![\d.])/g, parts: 3 },
];

export function cliVersion(root) {
  return JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
}

export function pinFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.mdx?$/.test(name) && !SKIP_FILES.has(name.toLowerCase())) out.push(path);
    }
  };
  walk(join(root, "docs/src/content/docs"));
  for (const extra of ["README.md", "packages/cli/README.md", "deploy/compose/.env.example", "deploy/compose/README.md"]) {
    if (existsSync(join(root, extra))) out.push(join(root, extra));
  }
  return out;
}

const wanted = (version, parts) => version.split(".").slice(0, parts).join(".");

export function rewrite(text, version) {
  let next = text;
  for (const { re, parts } of RULES) next = next.replace(re, (_, prefix) => `${prefix}${wanted(version, parts)}`);
  return next;
}

export function findStale(root, version = cliVersion(root)) {
  const stale = [];
  for (const file of pinFiles(root)) {
    const text = readFileSync(file, "utf8");
    if (rewrite(text, version) === text) continue;
    text.split("\n").forEach((line, i) => { if (rewrite(line, version) !== line) stale.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`); });
  }
  return stale;
}

export function bump(root, version) {
  const changed = [];
  for (const file of pinFiles(root)) {
    const text = readFileSync(file, "utf8"), next = rewrite(text, version);
    if (next !== text) { writeFileSync(file, next); changed.push(relative(root, file)); }
  }
  return changed;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = join(import.meta.dirname, "..");
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    const version = cliVersion(root), stale = findStale(root, version);
    if (stale.length) {
      console.error(`docs pins must equal the CLI version ${version} (or use latest); run: node scripts/bump-docs-pins.mjs ${version}`);
      for (const line of stale) console.error(`  ${line}`);
      process.exit(1);
    }
    console.log(`bump-docs-pins: ok (${version})`);
  } else {
    const version = args[0]?.replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) { console.error("usage: node scripts/bump-docs-pins.mjs <x.y.z> | --check"); process.exit(2); }
    const changed = bump(root, version);
    console.log(changed.length ? `updated ${version} pins in:\n${changed.map((f) => `  ${f}`).join("\n")}` : `pins already at ${version}`);
  }
}
