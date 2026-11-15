#!/usr/bin/env node
// Opt-in: `pnpm hooks:install` writes a pre-push hook that runs `pnpm test:changed`. Never automatic.
// `-- --remove` uninstalls; `-- --force` replaces a hook that is not ours.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MARK = "# 0security test:changed pre-push (installed by pnpm hooks:install)";
const hooksDir = resolve(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { encoding: "utf8" }).trim());
const hook = resolve(hooksDir, "pre-push");
const ours = existsSync(hook) && readFileSync(hook, "utf8").includes(MARK);
if (process.argv.includes("--remove")) {
  if (ours) { rmSync(hook); console.log(`removed ${hook}`); } else console.log("no 0security pre-push hook installed");
  process.exit(0);
}
if (existsSync(hook) && !ours && !process.argv.includes("--force")) { console.error(`${hook} exists and is not ours; re-run with --force to replace it`); process.exit(1); }
mkdirSync(hooksDir, { recursive: true });
writeFileSync(hook, `#!/bin/sh
${MARK}
# Runs only the checks your diff can reach; soft budget 120s. Bypass once: git push --no-verify
top="$(git rev-parse --show-toplevel)" || exit 0
[ -f "$top/scripts/test-changed.mjs" ] || exit 0
echo "pre-push: test:changed (soft budget 120s; git push --no-verify skips)"
cd "$top" && exec node scripts/test-changed.mjs --budget 120
`);
chmodSync(hook, 0o755);
console.log(`installed ${hook}`);
