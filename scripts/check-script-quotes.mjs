#!/usr/bin/env node
// Guard: package.json scripts quote arguments with double quotes. pnpm runs
// scripts with cmd.exe on Windows, which does not treat single quotes as
// quotes, so `--filter '!@0/docs'` matched no package and `pnpm build` built
// nothing. Double quotes mean the same in POSIX sh and in cmd.exe.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** True when the command has a single quote outside double quotes. */
export function hasSingleQuotedArgument(command) {
  let inDouble = false;
  for (const ch of command) {
    if (ch === '"') inDouble = !inDouble;
    else if (ch === "'" && !inDouble) return true;
  }
  return false;
}

export function checkScriptQuotes(root) {
  const errors = [];
  const pkgs = ["package.json"];
  const pdir = join(root, "packages");
  if (existsSync(pdir)) for (const d of readdirSync(pdir)) pkgs.push(join("packages", d, "package.json"));
  for (const rel of pkgs) {
    if (!existsSync(join(root, rel))) continue;
    const pkg = JSON.parse(readFileSync(join(root, rel), "utf8"));
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      if (hasSingleQuotedArgument(command)) {
        errors.push(`${rel}: script "${name}" uses single quotes, which cmd.exe on Windows passes through as text; use \\"...\\" instead.`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = process.argv[2] ?? join(import.meta.dirname, "..");
  const errors = checkScriptQuotes(root);
  if (errors.length) {
    for (const e of errors) console.error(`check-script-quotes: ${e}`);
    process.exit(1);
  }
  console.log("check-script-quotes: ok");
}
