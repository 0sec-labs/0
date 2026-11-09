import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { digest } from './corpus.mjs';

const specifications = [
  { lane: 'development', mechanism: 'recursive-object-merge', attack: '{"__proto__":{"finiteStudyPolluted":true}}', benign: '{"answer":42}' },
  { lane: 'selection', mechanism: 'dotted-property-traversal', attack: '{"__proto__.finiteStudyPolluted":true}', benign: '{"answer":42}' },
  { lane: 'final', mechanism: 'inherited-registry-entry', attack: '{"name":"__proto__","values":{"finiteStudyPolluted":true}}', benign: '{"name":"normal","values":{"answer":42}}' },
];

/** Executes only these committed synthetic fixtures, never supplied package code. */
export function preflightFiniteFixtures() {
  const cases = specifications.flatMap(spec => ['vulnerable', 'fixed', 'clean'].map(label => {
    const url = new URL(`./finite-fixtures/${spec.lane}/${label}.cjs`, import.meta.url);
    const path = fileURLToPath(url);
    const source = readFileSync(url, 'utf8');
    const program = `const fixture = require(${JSON.stringify(path)});
      const before = Object.prototype.finiteStudyPolluted;
      fixture(JSON.parse(${JSON.stringify(spec.attack)}));
      const polluted = Object.prototype.finiteStudyPolluted === true;
      delete Object.prototype.finiteStudyPolluted;
      const benign = fixture(JSON.parse(${JSON.stringify(spec.benign)}));
      console.log(JSON.stringify({ pristine: before === undefined, polluted, benign: benign.answer === 42 }));`;
    const result = spawnSync(process.execPath, ['--eval', program], {
      timeout: 2000, maxBuffer: 8192, encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    if (result.error || result.status !== 0) throw new Error(`fixture failed: ${spec.lane}/${label}`);
    const observation = JSON.parse(result.stdout);
    if (!observation.pristine || !observation.benign || observation.polluted !== (label === 'vulnerable')) {
      throw new Error(`runtime adjudication mismatch: ${spec.lane}/${label}`);
    }
    return { id: `${spec.lane}/${label}`, mechanism: spec.mechanism, lane: spec.lane, label, sourceDigest: digest(source), observation };
  }));
  return {
    schemaVersion: 1, workflow: 'synthetic-prototype-pollution-source-review',
    corpusDigest: digest(cases.map(({ observation, ...identity }) => identity)),
    nodeVersion: process.version, oracleDigest: digest(readFileSync(new URL(import.meta.url))),
    cases, independentReview: 'pending', modelCalls: 0, modelUsage: null, billedUsd: null,
    conclusion: 'inconclusive', limitation: 'Constructed mechanisms, not independently sampled real-world families; no model efficacy or generalization claim.',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(preflightFiniteFixtures(), null, 2));
