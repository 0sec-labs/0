#!/usr/bin/env node
/** Paired real console investigations. No fixture labels enter the model workspace. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConsoleSession, LlmApiRuntime, HuntMemoryStore, TOOL_DEFINITIONS } from '../../core/dist/index.js';
import { LearningStore } from '../../db/dist/index.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const contract = `/** Identity is verified upstream. Roles such as manager are scoped to the actor's tenant, never global.\n * Report IDs and request query parameters are untrusted. Sensitive records require ownership checks. */\nexport function tenantFor(actor) { return actor.tenant; }\nexport function isManager(actor) { return actor.role === 'manager'; }\n`;
function A(actor, report) {
  if (report.tenant !== actor.tenant && actor.role !== 'manager') return { status: 403 };
  return { status: 200, body: report };
}
function B(actor, report) {
  if (report.tenant !== actor.tenant || actor.role !== 'manager') return { status: 403 };
  return { status: 200, body: report };
}
function C(actor, report, requestedTenant) {
  if (report.tenant !== requestedTenant) return { status: 403 };
  return { status: 200, body: report };
}
function D(actor, report, requestedTenant) {
  if (report.tenant !== actor.tenant) return { status: 403 };
  return { status: 200, body: report };
}
const handlers = { A, B, C, D };
const routes = Object.entries(handlers).map(([id, fn]) => `// Route /${id}: authenticated actor and selected report, optional tenant query parameter.\nexport ${fn.toString()}\n`).join('\n');
const source = { 'platform.mjs': contract, 'routes.mjs': routes };

export function parseConsoleFindings(text) {
  const body = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (!Array.isArray(body.findings)) throw new Error('findings must be an array');
  const seen = new Set();
  return body.findings.map(f => {
    if (!Object.hasOwn(handlers, f.id) || f.category !== 'access-control' || seen.has(f.id)) throw new Error('invalid, mismatched, or duplicate candidate');
    seen.add(f.id); return { id: f.id, category: 'access-control' };
  });
}

export async function consoleOracle() {
  const owner = { tenant: 'tenant-a', role: 'manager' };
  const crossTenant = { tenant: 'tenant-b', role: 'manager' };
  const report = { tenant: 'tenant-a', id: 'report-11', confidential: 'fixture-report-marker-11' };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'); const id = url.pathname.slice(1); const handler = Object.hasOwn(handlers,id) ? handlers[id] : null;
    const actor = req.headers['x-fixture-principal'] === 'owner' ? owner : req.headers['x-fixture-principal'] === 'other-tenant' ? crossTenant : null;
    if (!handler || !actor) { res.writeHead(401).end(); return; }
    const result = handler(actor, report, url.searchParams.get('tenant'));
    res.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body ?? null));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const results = [];
    for (const id of Object.keys(handlers)) {
      const path = `${root}/${id}?tenant=tenant-a`;
      const send = async principal => {
        const r = await fetch(path, { headers: principal ? { 'x-fixture-principal': principal } : {}, signal: AbortSignal.timeout(2000) });
        return { status: r.status, containsMarker: (await r.text()).includes(report.confidential) };
      };
      const legitimate = await send('owner'), unauthorized = await send('other-tenant'), anonymous = await send();
      results.push({ id, expected: id === 'A' || id === 'C', confirmed: legitimate.status === 200 && legitimate.containsMarker && unauthorized.status === 200 && unauthorized.containsMarker && anonymous.status === 401,
        legitimate, unauthorized, anonymous });
    }
    return results;
  } finally { await new Promise(done => server.close(done)); }
}

export function consoleGrade(predictions, oracle) {
  const tp = predictions.filter(p => oracle.some(o => o.id === p.id && o.expected && o.confirmed)).length;
  const fp = predictions.filter(p => oracle.some(o => o.id === p.id && !o.expected)).length;
  const total = oracle.filter(o => o.expected).length;
  return { confirmed: tp, falsePositiveCandidates: fp, missed: total - tp, recall: tp / total };
}

export async function runConsolePaired({ live = false, model = 'gpt-5.6-sol', provider = 'chatgpt-codex' } = {}) {
  const oracle = await consoleOracle();
  const result = { schema: '0.learning-console-paired/v1', startedAt: new Date().toISOString(), model, provider,
    sourceDigest: digest(JSON.stringify(source)), harnessDigest: digest(readFileSync(new URL(import.meta.url))),
    engineDigest: digest(readFileSync(new URL('../../core/dist/console/turn-engine.js', import.meta.url))),
    limits: { investigations: 5, modelCallsPerInvestigation: 6, timeoutPerInvestigationMs: 90000, maxTurnTokens: 16000, tools: ['read_file', 'remember_codebase (development only)'] },
    oracle, development: null, cells: [], status: 'validators-only',
    limitations: ['Four synthetic routes; two independent vulnerable implementations; repeated runs are not additional independent cases.',
      'Both versions may read the same development contract. The remembered note is a summary, not new source information.',
      'Same-project source review and host-owned authenticated probes; no full browser scan, exploit generation, production authentication, workflow, or SmolVM execution.',
      'Same token/time/call ceilings per investigation; actual usage and training overhead reported separately.',
      'OAuth requests cannot enforce an exact output-token ceiling; engine stops between calls and timeouts abort in flight.'] };
  if (!oracle.every(o => o.expected === o.confirmed)) { result.status = 'oracle-failed'; return result; }
  if (!live) return result;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-console-paired-')));
  const state = mkdtempSync(join(tmpdir(), 'zero-console-paired-state-'));
  for (const [name, text] of Object.entries(source)) writeFileSync(join(root, name), text);
  const retainedMemory = new HuntMemoryStore({ path: join(state, 'development-memory.jsonl') });
  const retainedLearning = new LearningStore(join(state, 'development.sqlite'));
  const raw = new LlmApiRuntime({ type: 'api', provider, model, timeout: 45000, env: { ...process.env, ZERO_REASONING_EFFORT: 'low', ZERO_LLM_FALLBACK: '' } });
  if (!(await raw.isAvailable())) { result.status = 'provider-unavailable'; retainedLearning.close(); rmSync(root,{recursive:true,force:true}); rmSync(state,{recursive:true,force:true}); return result; }
  async function investigate(prompt, { development = false, memory, learning }) {
    const calls = [], modelTools = new Set(development ? ['read_file', 'remember_codebase'] : ['read_file']);
    const runtime = { type: 'api', isAvailable: () => raw.isAvailable(), resolvedModel: () => raw.resolvedModel(),
      async executeNative(system, messages, tools, callbacks, signal) {
        if (calls.length >= 6) throw new Error('benchmark model call ceiling');
        const response = await raw.executeNative(system, messages, tools.filter(t => modelTools.has(t.name)), callbacks, signal);
        calls.push({ usage: response.usage ?? null, durationMs: response.durationMs, stopReason: response.stopReason,
          recalledLesson: JSON.stringify(messages).includes('Prior source lessons for this authorized codebase'),
          tools: response.content.filter(c => c.type === 'tool_use').map(c => ({ name:c.name, input:c.input })) });
        for (const c of response.content.filter(c => c.type === 'tool_use')) {
          if (!modelTools.has(c.name)) throw new Error('unadvertised benchmark tool requested');
          if (c.name === 'read_file') {
            const file = typeof c.input.path === 'string' ? relative(root,resolve(root,c.input.path)) : '';
            if (!(development ? ['platform.mjs'] : ['platform.mjs','routes.mjs']).includes(file)) throw new Error('out-of-phase benchmark source read');
          }
          if (c.name === 'remember_codebase' && (!Array.isArray(c.input.paths) || c.input.paths.some(p=>p!=='platform.mjs'))) throw new Error('out-of-phase lesson source');
        }
        return response;
      } };
    const session = createConsoleSession({ runtime, workspaceRoot: root, db: null,
      systemPrompt: 'You are reviewing an authorized local fixture repository. Inspect only the files named by the operator. Use read_file for source inspection. Do not run commands, access networks, delegate, or invent runtime proof. Follow the requested output format.',
      tools: development ? [TOOL_DEFINITIONS.read_file, TOOL_DEFINITIONS.remember_codebase] : [TOOL_DEFINITIONS.read_file], codebaseLearning: true, huntMemoryStore: memory, learningStore: learning,
      autonomyMode: 'yolo', allowSelfExtension: false, maxToolIterations: 6, maxTurnTokens: 16000 });
    try {
      await session.ready; session.configureWorkspace(root);
      const outcome = await session.send(prompt, undefined, { signal: AbortSignal.timeout(90000) });
      return { text: outcome.assistantText, stopReason: outcome.stopReason, usage: outcome.usage,
        toolCalls: outcome.toolCalls.map(c => ({ name:c.call?.name, input:c.call?.arguments, success:c.result?.success })), calls,
        historyIncludesRecalledLesson: JSON.stringify(session.exportCheckpoint().messages).includes('Prior source lessons for this authorized codebase') };
    } catch (error) { return { failed: true, failure: /ceiling/.test(error.message) ? 'model-call-ceiling' : 'investigation-error', calls }; }
    finally { await session.cleanup(); }
  }
  try {
    result.development = await investigate('Read platform.mjs only. Save exactly one concise project-specific trust-boundary lesson using remember_codebase, citing platform.mjs only. Do not inspect routes.mjs or identify route vulnerabilities. Then respond briefly that the lesson was saved.', { development: true, memory: retainedMemory, learning: retainedLearning });
    const notes = retainedMemory.recallCodebase(root, 6);
    result.savedLessons = notes.map(n => ({ title:n.title, summary:n.summary, sourceLinks:n.codebase.files }));
    result.retainedKnowledge = retainedLearning.listKnowledge().map(k => ({ status:k.status, summary:k.summary }));
    if (result.development.failed || !notes.length || notes.some(n => n.codebase.files.some(f => f.path !== 'platform.mjs'))) { result.status = 'development-failed'; return result; }
    const prompt = 'Inspect platform.mjs and routes.mjs using read_file. Identify cross-tenant disclosure bugs in the four routes. Query parameter tenant is caller-controlled; actor comes from verified authentication. Include only vulnerable routes. Return JSON only: {"findings":[{"id":"A","category":"access-control"}]}. Empty findings is valid. Do not save or change lessons during this heldout review; do not claim runtime verification.';
    for (const [repeat, order] of [[0,['baseline','learned']], [1,['learned','baseline']]]) {
      for (const arm of order) {
        const blankLearning = arm === 'baseline' ? new LearningStore(join(state, `baseline-${repeat}.sqlite`)) : null;
        const blankMemory = arm === 'baseline' ? new HuntMemoryStore({ path: join(state, `baseline-${repeat}.jsonl`) }) : null;
        let cell;
        try { cell = { repeat, arm, ...await investigate(prompt, { memory:blankMemory ?? retainedMemory, learning:blankLearning ?? retainedLearning }) }; }
        finally { blankLearning?.close(); }
        if (!cell.failed && cell.stopReason === 'end_turn') {
          try { cell.predictions = parseConsoleFindings(cell.text); cell.score = consoleGrade(cell.predictions, oracle); }
          catch { cell.failed = true; cell.failure = 'invalid-json-predictions'; }
        } else cell.failed = true;
        result.cells.push(cell);
        if (cell.failed) { result.status = 'investigation-failed'; return result; }
      }
    }
    const summarize = arm => {
      const cells = result.cells.filter(c => c.arm === arm);
      return { investigations:cells.length, meanRecall:cells.reduce((s,c)=>s+c.score.recall,0)/cells.length,
        falsePositiveCandidates:cells.reduce((s,c)=>s+c.score.falsePositiveCandidates,0),
        inputTokens:cells.reduce((s,c)=>s+c.usage.inputTokens,0), outputTokens:cells.reduce((s,c)=>s+c.usage.outputTokens,0),
        modelCalls:cells.reduce((s,c)=>s+c.calls.length,0), recalledInCalls:cells.reduce((s,c)=>s+c.calls.filter(x=>x.recalledLesson).length,0) };
    };
    result.summary = { baseline:summarize('baseline'), learned:summarize('learned') };
    result.summary.recallDelta = result.summary.learned.meanRecall - result.summary.baseline.meanRecall;
    result.status = 'completed'; return result;
  } finally { retainedLearning.close(); rmSync(root,{recursive:true,force:true}); rmSync(state,{recursive:true,force:true}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const option = flag => { const i=process.argv.indexOf(flag); return i<0?undefined:process.argv[i+1]; };
  const result = await runConsolePaired({ live:process.argv.includes('--live'), model:option('--model'), provider:option('--provider') });
  const output = JSON.stringify(result,null,2)+'\n'; if (option('--output')) writeFileSync(option('--output'),output);
  console.log(JSON.stringify({ status:result.status, summary:result.summary??null, oracle:result.oracle.map(x=>({id:x.id,confirmed:x.confirmed})) }));
  if (result.status.includes('failed')) process.exitCode=1;
}
