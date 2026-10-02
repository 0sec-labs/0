#!/usr/bin/env node
/** Small source-review experiment. Labels and live validators stay host-side. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { HuntMemoryStore, LlmApiRuntime } from '../../core/dist/index.js';
import { verifySqli, verifyPathTraversal } from '../../core/dist/triage/oracles.js';

const hash = value => createHash('sha256').update(value).digest('hex');
// These exact functions are both supplied to the reviewer and executed by the fixture.
function lookupA(db, name) { return db.prepare(`SELECT name FROM people WHERE name = '${name}'`).all(); }
function lookupB(db, name) { return db.prepare('SELECT name FROM people WHERE name = ?').all(name); }
function downloadC(base, path) { return readFileSync(resolve(base, path), 'utf8'); }
function downloadD(base, path) {
  const file = resolve(base, path);
  if (!file.startsWith(resolve(base) + sep)) throw new Error('outside download directory');
  return readFileSync(file, 'utf8');
}
const sourceCases = [
  { id: 'A', category: 'sql-injection', source: lookupA.toString() },
  { id: 'B', category: 'sql-injection', source: lookupB.toString() },
  { id: 'C', category: 'path-traversal', source: downloadC.toString() },
  { id: 'D', category: 'path-traversal', source: downloadD.toString() },
];

export function parsePredictions(text) {
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (!Array.isArray(parsed.findings)) throw new Error('findings must be an array');
  const seen = new Set();
  return parsed.findings.map(f => {
    const c = sourceCases.find(c => c.id === f.id && c.category === f.category);
    if (!c || seen.has(f.id)) throw new Error('unknown, duplicate, or mismatched finding');
    seen.add(f.id);
    return { id: f.id, category: f.category };
  });
}

export function grade(predictions, verdicts) {
  const positives = verdicts.filter(v => v.expected).length;
  const tp = predictions.filter(p => verdicts.some(v => v.id === p.id && v.expected && v.verified)).length;
  const fp = predictions.filter(p => verdicts.some(v => v.id === p.id && !v.expected)).length;
  const unconfirmed = predictions.length - tp;
  return { truePositiveCandidates: tp, falsePositiveCandidates: fp, confirmedFindings: tp,
    unconfirmedCandidates: unconfirmed, missedVulnerabilities: positives - tp,
    recall: positives ? tp / positives : null,
    candidatePrecision: predictions.length ? tp / predictions.length : null };
}

export async function validateFixtures() {
  const root = mkdtempSync(join(tmpdir(), 'zero-learning-fixture-'));
  const base = join(root, 'a/b/c/d');
  mkdirSync(base, { recursive: true }); mkdirSync(join(root, 'etc'));
  // Owned sentinel only. The harness refuses all reads outside this temporary root.
  writeFileSync(join(root, 'etc/passwd'), 'root:x:0:0:fixture:/fixture:/bin/bash\n');
  writeFileSync(join(base, 'public.txt'), 'public download\n');
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE people(name TEXT); INSERT INTO people VALUES ('alice'),('bob'),('carol');");
  const requests = { A: 0, B: 0, C: 0, D: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const id = url.pathname.slice(1); if (!(id in requests)) { res.writeHead(404).end(); return; }
    requests[id]++;
    try {
      if (id === 'A' || id === 'B') res.end(JSON.stringify((id === 'A' ? lookupA : lookupB)(db, url.searchParams.get('name') ?? '')));
      else {
        const path = url.searchParams.get('path') ?? '';
        const file = resolve(base, path);
        if (!file.startsWith(root + sep)) { res.writeHead(403).end('outside fixture'); return; }
        res.end((id === 'C' ? downloadC : downloadD)(base, path));
      }
    } catch (error) {
      res.writeHead(400).end(id === 'A' ? `sqlite3.OperationalError: ${error.message}` : 'request rejected');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const verdicts = [];
    for (const c of sourceCases) {
      const target = `${origin}/${c.id}?${c.category === 'sql-injection' ? 'name=nobody' : 'path=public.txt'}`;
      const finding = { category: c.category, evidence: { request: `GET ${target} HTTP/1.1` } };
      const result = await (c.category === 'sql-injection' ? verifySqli : verifyPathTraversal)(finding, target);
      verdicts.push({ id: c.id, expected: c.id === 'A' || c.id === 'C', verified: result.verified,
        evidence: result.evidence, reason: result.reason, requests: requests[c.id] });
    }
    return verdicts;
  } finally {
    await new Promise(resolve => server.close(resolve)); db.close(); rmSync(root, { recursive: true, force: true });
  }
}

export async function runPaired({ model = 'gpt-5.6-sol', provider = 'chatgpt-codex', live = false } = {}) {
  const verdicts = await validateFixtures();
  const report = { schema: '0.learning-source-review-paired/v1', startedAt: new Date().toISOString(),
    model, provider, fixtureDigest: hash(JSON.stringify(sourceCases)),
    evaluatorDigest: hash(readFileSync(new URL('../../core/dist/triage/oracles.js', import.meta.url))),
    harnessDigest: hash(readFileSync(new URL(import.meta.url))),
    evaluationKind: 'source-review-with-live-local-oracles',
    limits: { modelCalls: 5, callTimeoutMs: 45000, repeats: 2, tools: 0, externalTargets: 0 },
    verdicts, cells: [], training: null, status: 'validators-only',
    limitations: ['Four hand-authored cases, two vulnerability classes, same-repository context only.',
      'Not a full agent scan, workflow execution, automatic proposal test, unseen-project test, or proof of general security improvement.',
      'Probe requests are frozen and identical for both arms. Labels are held out of model input.',
      'Learning arm includes one additional context note; observed token usage is reported, not assumed equal.',
      'The OAuth provider does not support a hard output-token ceiling; calls have identical timeout and instruction budgets.'] };
  if (!verdicts.every(v => v.expected === v.verified)) { report.status = 'fixture-validation-failed'; return report; }
  if (!live) return report;
  const runtime = new LlmApiRuntime({ type: 'api', provider, model, timeout: 45000,
    env: { ...process.env, ZERO_REASONING_EFFORT: 'low', ZERO_LLM_FALLBACK: '' } });
  if (!(await runtime.isAvailable())) { report.status = 'provider-unavailable'; return report; }
  const root = mkdtempSync(join(tmpdir(), 'zero-learning-review-'));
  const development = "function lookup(db, email) { return db.prepare('SELECT email FROM accounts WHERE email = ?').all(email); }";
  writeFileSync(join(root, 'development.js'), development);
  const memory = new HuntMemoryStore({ path: join(root, 'private-memory.jsonl') });
  async function call(system, prompt) {
    const result = await runtime.executeNative(system, [{ role: 'user', content: [{ type: 'text', text: prompt }] }], [], undefined, AbortSignal.timeout(45000));
    const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('');
    return { stopReason: result.stopReason, text, usage: result.usage ?? null,
      durationMs: result.durationMs, model: runtime.resolvedModel(),
      errorCategory: !result.error ? null : /not supported|unsupported/i.test(result.error) ? 'unsupported-model' : /401|403|authentication|unauthorized/i.test(result.error) ? 'authentication' : /quota|usage_limit/i.test(result.error) ? 'quota' : 'provider-error', failed: result.stopReason !== 'end_turn' };
  }
  try {
    const training = await call('You are documenting one source example. Return one short plain-English paragraph, at most 80 words. Do not claim runtime verification.',
      `Explain the trust boundary and the security lesson from this development code only:\n${development}`);
    report.training = training;
    if (training.failed || !training.text.trim()) { report.status = 'training-failed'; return report; }
    memory.rememberCodebase({ root, paths: ['development.js'], title: 'Database lookup lesson', summary: training.text.slice(0, 1500), source: 'paired-benchmark-development' });
    const note = memory.recallCodebase(root, 1)[0];
    if (!note) throw new Error('fresh source-linked note was not recalled');
    report.recalledSourceDigest = note.codebase.files[0].digest;
    const system = 'Review the supplied functions for SQL injection or path traversal. Globals db, readFileSync, resolve and sep have their standard Node/SQLite meanings. Return JSON only: {"findings":[{"id":"A","category":"sql-injection"}]}. Include only vulnerable functions; use the supplied IDs and categories. An empty array is valid. No tools or runtime verification claims. Keep the answer under 200 words.';
    const prompt = JSON.stringify(sourceCases);
    // Counterbalanced pairs avoid always giving the warmed connection to one arm.
    for (const [repeat, order] of [[0, ['baseline', 'learned']], [1, ['learned', 'baseline']]]) {
      for (const arm of order) {
        const result = await call(system, arm === 'learned' ? `${prompt}\nSource-linked note from development (not evidence of a vulnerability):\n${note.summary}` : prompt);
        const cell = { repeat, arm, ...result, predictions: null, score: null };
        if (!result.failed) {
          try { cell.predictions = parsePredictions(result.text); cell.score = grade(cell.predictions, verdicts); }
          catch { cell.failed = true; cell.parseError = 'invalid structured predictions'; }
        }
        report.cells.push(cell);
        if (result.failed) { report.status = 'provider-call-failed'; return report; }
      }
    }
    const valid = report.cells.filter(c => !c.failed);
    const average = arm => {
      const cells = valid.filter(c => c.arm === arm);
      return { validRuns: cells.length, meanRecall: cells.reduce((s,c) => s+c.score.recall,0)/Math.max(cells.length,1),
        falsePositiveCandidates: cells.reduce((s,c) => s+c.score.falsePositiveCandidates,0),
        inputTokens: cells.reduce((s,c) => s+(c.usage?.inputTokens ?? 0),0), outputTokens: cells.reduce((s,c) => s+(c.usage?.outputTokens ?? 0),0) };
    };
    report.summary = { baseline: average('baseline'), learned: average('learned') };
    report.summary.recallDelta = report.summary.learned.meanRecall - report.summary.baseline.meanRecall;
    report.status = valid.length === 4 ? 'completed' : 'inconclusive';
    return report;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const get = flag => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i+1]; };
  const result = await runPaired({ live: process.argv.includes('--live'), model: get('--model'), provider: get('--provider') });
  const output = JSON.stringify(result, null, 2) + '\n';
  if (get('--output')) writeFileSync(get('--output'), output);
  console.log(JSON.stringify({ status: result.status, summary: result.summary ?? null, validators: result.verdicts.map(v => ({ id: v.id, verified: v.verified })) }));
  if (result.status.includes('failed') || result.status === 'inconclusive') process.exitCode = 1;
}
