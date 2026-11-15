#!/usr/bin/env node
// Guard: the container image is published only as ghcr.io/0sec-labs/0security.
// The retired name ghcr.io/<owner>/0 must not return to workflows, scripts,
// compose files, the Action or docs. Allowed: the changelog (history) and the
// "Moving from the old image name" section of the Docker page.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const OLD_IMAGE = /ghcr\.io\/(?:0sec-labs|\$\{?\{?[^/\s]*\}?\}?)\/0(?![\w-])/i;
const ROOTS = [".github", "scripts", "deploy", "docs/src", "README.md", "action.yml", "packages/engine/docker", "packages/cli/src"];
const SELF = new Set(["scripts/check-image-name.mjs", "scripts/check-image-name.test.mjs"]);
const ALLOWED_FILES = new Set(["docs/CHANGELOG.md"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

function* walk(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  if (statSync(abs).isFile()) return yield rel;
  for (const e of readdirSync(abs)) if (!SKIP_DIRS.has(e)) yield* walk(root, join(rel, e));
}

export function checkImageName(root) {
  const errors = [];
  for (const base of ROOTS) {
    for (const rel of walk(root, base)) {
      if (SELF.has(rel) || ALLOWED_FILES.has(rel) || !/\.(ya?ml|md|mdx|sh|mjs|ts|json|kali|toml)$|Dockerfile/.test(rel)) continue;
      let allowedSection = false;
      readFileSync(join(root, rel), "utf8").split("\n").forEach((line, i) => {
        if (rel.endsWith("docker.md")) {
          if (/^## /.test(line)) allowedSection = /^## Moving from the old image name/.test(line);
          if (allowedSection) return;
        }
        if (OLD_IMAGE.test(line)) errors.push(`${rel}:${i + 1}: the image is published only as ghcr.io/0sec-labs/0security; the old name ghcr.io/0sec-labs/0 is retired.`);
      });
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = process.argv[2] ?? join(import.meta.dirname, "..");
  const errors = checkImageName(root);
  if (errors.length) {
    for (const e of errors) console.error(`check-image-name: ${e}`);
    process.exit(1);
  }
  console.log("check-image-name: ok");
}
