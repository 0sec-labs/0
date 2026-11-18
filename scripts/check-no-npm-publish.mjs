#!/usr/bin/env node
// Guard: 0 is distributed only as GitHub Release binaries, install.sh and the
// Docker image. Fails if npm publishing creeps back into workflows, the Action
// or any workspace package.json.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_PATTERNS = [
  [/\bnpm\s+publish\b/, "`npm publish`"],
  [/\bpnpm\s+publish\b/, "`pnpm publish`"],
  [/\bNPM_TOKEN\b/, "NPM_TOKEN"],
  [/\bNODE_AUTH_TOKEN\b/, "NODE_AUTH_TOKEN"],
  [/registry-url:/, "setup-node `registry-url` (publish auth)"],
  [/--provenance\b/, "npm `--provenance`"],
  [/registry\.npmjs\.org/, "registry.npmjs.org"],
];
const PACKAGE_FORBIDDEN = ["publishConfig", "prepublishOnly", "prepack", "postpack", "files"];

export function checkNoNpmPublish(root) {
  const errors = [];
  const targets = [];
  const wfDir = join(root, ".github/workflows");
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir)) if (/\.ya?ml$/.test(f)) targets.push(join(".github/workflows", f));
  }
  for (const rel of targets) {
    const text = readFileSync(join(root, rel), "utf8");
    text.split("\n").forEach((line, i) => {
      if (line.trim().startsWith("#")) return;
      for (const [re, label] of WORKFLOW_PATTERNS) {
        if (re.test(line)) errors.push(`${rel}:${i + 1}: ${label} is not allowed; npm distribution is discontinued.`);
      }
    });
  }
  const pkgs = ["package.json"];
  const pdir = join(root, "packages");
  if (existsSync(pdir)) for (const d of readdirSync(pdir)) pkgs.push(join("packages", d, "package.json"));
  for (const rel of pkgs) {
    if (!existsSync(join(root, rel))) continue;
    const pkg = JSON.parse(readFileSync(join(root, rel), "utf8"));
    if (pkg.private !== true) errors.push(`${rel}: must set "private": true so it cannot be published.`);
    for (const key of [...PACKAGE_FORBIDDEN]) {
      if (key in pkg || (pkg.scripts && key in pkg.scripts)) errors.push(`${rel}: "${key}" only exists for npm publishing.`);
    }
    for (const name of Object.keys(pkg.scripts ?? {})) {
      if (/^release:npm|^publish/.test(name)) errors.push(`${rel}: script "${name}" publishes to npm.`);
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = process.argv[2] ?? join(import.meta.dirname, "..");
  const errors = checkNoNpmPublish(root);
  if (errors.length) {
    for (const e of errors) console.error(`check-no-npm-publish: ${e}`);
    process.exit(1);
  }
  console.log("check-no-npm-publish: ok");
}
