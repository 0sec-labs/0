#!/usr/bin/env node
// Run the whole local gate in parallel and end with one summary. Each job's output goes to its own log, so a failure
// is read from that file instead of from interleaved text. CI is still the gate; use this when you want the full
// answer before pushing, in the time of the slowest job instead of the sum of all of them.
//   node scripts/verify-local.mjs [job ...]      jobs: types static engine cli web (default: all)
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const JOBS = {
  types: "pnpm --filter @0/engine exec tsc --noEmit && pnpm --filter @0/cli exec tsc --noEmit && pnpm --filter @0/web exec tsc --noEmit",
  static: "node scripts/run-checks.mjs static",
  engine: "pnpm --filter @0/engine exec vitest run",
  cli: "pnpm --filter @0/cli exec vitest run",
  web: "pnpm --filter @0/web exec vitest run",
};

export function pickJobs(names) {
  const chosen = names.length ? names : Object.keys(JOBS);
  const unknown = chosen.filter(name => !(name in JOBS));
  if (unknown.length) throw new Error(`Unknown job ${unknown.join(", ")}; choose from ${Object.keys(JOBS).join(", ")}.`);
  return chosen;
}

function run(name, command, logDir) {
  return new Promise(resolve => {
    const started = Date.now();
    const log = createWriteStream(join(logDir, `${name}.log`));
    const child = spawn("bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" } });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("close", code => { log.end(); resolve({ name, code: code ?? 1, seconds: (Date.now() - started) / 1000, log: join(logDir, `${name}.log`) }); });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const names = pickJobs(process.argv.slice(2));
  const logDir = join(tmpdir(), `0-verify-${Date.now()}`);
  mkdirSync(logDir, { recursive: true });
  console.log(`running ${names.join(", ")} in parallel; logs in ${logDir}`);
  const results = await Promise.all(names.map(name => run(name, JOBS[name], logDir)));
  for (const result of results) console.log(`${result.code === 0 ? "ok  " : "FAIL"} ${result.name.padEnd(7)} ${result.seconds.toFixed(0).padStart(4)}s${result.code === 0 ? "" : `  ${result.log}`}`);
  const wall = Math.max(...results.map(result => result.seconds));
  console.log(`${results.filter(result => result.code !== 0).length ? "FAILED" : "all passed"} in ${wall.toFixed(0)}s (the jobs summed to ${results.reduce((sum, result) => sum + result.seconds, 0).toFixed(0)}s)`);
  process.exit(results.some(result => result.code !== 0) ? 1 : 0);
}
