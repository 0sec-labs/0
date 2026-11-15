#!/usr/bin/env node
// Guard: the CLI version in packages/cli/package.json must have a filled
// CHANGELOG section and (when the file exists) a releases.ts entry.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cliVersion, generate, parseReleasesTs } from "./release-notes.mjs";

export function checkRelease(root) {
  const version = cliVersion(root);
  const errors = [];
  try { generate(version, root); } catch (e) { errors.push(e.message); }
  const rp = join(root, "packages/web/src/lib/releases.ts");
  if (existsSync(rp) && !parseReleasesTs(readFileSync(rp, "utf8"), version)) {
    errors.push(`packages/web/src/lib/releases.ts has no entry for version ${version}.`);
  }
  return { version, errors };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = process.argv[2] ?? join(import.meta.dirname, "..");
  const { version, errors } = checkRelease(root);
  if (errors.length) {
    for (const e of errors) console.error(`check-release-notes: ${e}`);
    process.exit(1);
  }
  console.log(`check-release-notes: ok (${version})`);
}
