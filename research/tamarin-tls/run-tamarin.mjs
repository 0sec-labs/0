#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = dirname(fileURLToPath(import.meta.url));
const executable = 'tamarin-prover';
const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
const save = result => {
  writeFileSync(join(home, 'tamarin-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
};
if (version.error || version.status !== 0) {
  save({ schemaVersion: 1, status: 'inconclusive', reason: version.error?.code === 'ENOENT'
    ? 'tamarin-prover is not installed or not on PATH; no models parsed or proved'
    : `tamarin-prover version probe failed: ${version.error?.message ?? version.stderr}`,
    modelsRun: [] });
  process.exit(2);
}

const cases = [
  { file: 'local-caches.spthy', expected: { distributed_replay_exists: 'verified', at_most_once: 'falsified' } },
  { file: 'shared-consume.spthy', expected: { acceptance_exists: 'verified', at_most_once: 'verified' } },
];
const modelsRun = [];
for (const item of cases) {
  const run = spawnSync(executable, [join(home, item.file), '--prove'], {
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
  });
  const stdout = run.stdout ?? '';
  const stderr = run.stderr ?? '';
  const logName = item.file.replace('.spthy', '.log');
  writeFileSync(join(home, logName), stdout + '\nSTDERR\n' + stderr);
  // Read Tamarin's printed lemma summary only. A successful process alone
  // never means a lemma was verified; missing/unfinished summaries fail closed.
  const results = {};
  for (const [lemma, expected] of Object.entries(item.expected)) {
    const summary = stdout.match(new RegExp(`^\\s*${lemma}\\s*\\([^\\n]*\\):\\s*(verified|falsified)\\b`, 'm'));
    results[lemma] = { expected, observed: summary?.[1] ?? 'inconclusive' };
  }
  const confirmed = !run.error && run.status === 0 &&
    Object.values(results).every(result => result.observed === result.expected);
  modelsRun.push({ model: item.file, status: confirmed ? 'expected-results-confirmed' : 'inconclusive',
    exitCode: run.status, error: run.error?.message ?? null, results, log: logName });
}
const confirmed = modelsRun.every(run => run.status === 'expected-results-confirmed');
save({ schemaVersion: 1, status: confirmed ? 'expected-results-confirmed' : 'inconclusive',
  version: (version.stdout + version.stderr).trim(), timeoutPerModelMs: 60000, modelsRun });
process.exitCode = confirmed ? 0 : 2;
