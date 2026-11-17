// The pull request Agent, end to end: preset -> trigger -> poll -> thread -> optional PR comment.
//
// Starts a disposable `0` engine (loopback, isolated HOME and database, no real credentials,
// ZERO_0VERSE_MCP=0) with a fake `gh` on PATH that serves canned pull requests and records every
// call, plus a deterministic OpenAI-compatible model server. Two Agents are created from the
// `pr-security-reviewer` preset through the CLI: one with "Comment on the pull request" on, one
// with it off. Asserts: the baseline poll launches nothing, a new same-repo pull request starts one
// thread recorded on the Agent, the comment is posted once and edited (never duplicated) after a
// re-push and never posted when off, forks and drafts are skipped with a recorded reason, a gh
// failure is shown on the Agent without crashing the engine, and the Agent page shows the
// activations and thread links.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const started = performance.now();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages/cli/dist/index.js');
const assets = join(root, 'packages/web/dist');
const requireEngine = createRequire(join(root, 'packages/engine/package.json'));
const { chromium } = (() => {
  try { return requireEngine('playwright'); }
  catch { return requireEngine(join(root, 'node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core')); }
})();

const SCRUB = /(_API_KEY|_TOKEN|_SECRET|_ACCESS_KEY|^OPENAI|^ANTHROPIC|^AZURE_|^GOOGLE_|^GEMINI|^DEEPSEEK|^OPENROUTER|^QWEN|^GH_|^GITHUB_)/;
const REPO = 'acme/app';
const wait = ms => new Promise(done => setTimeout(done, ms));
const timings = {};
const lap = name => { timings[name] = Math.round(performance.now() - started); };

const base = await mkdtemp(join(tmpdir(), 'zero-pr-agent-'));
const home = join(base, 'home');
const workspace = join(base, 'workspace');
const bin = join(base, 'bin');
const ghState = join(base, 'gh');
await Promise.all([home, workspace, bin, ghState].map(dir => mkdir(dir, { recursive: true })));
const engineToken = randomBytes(32).toString('hex');

// ---- fake gh: canned `pr list`, `pr diff`, comment listing, create and edit; logs every argv ----
await writeFile(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const dir = ${JSON.stringify(ghState)};
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/calls.log', JSON.stringify(args) + '\\n');
const read = (name, fallback) => { try { return JSON.parse(fs.readFileSync(dir + '/' + name, 'utf8')); } catch { return fallback; } };
const write = (name, value) => fs.writeFileSync(dir + '/' + name, JSON.stringify(value));
if (fs.existsSync(dir + '/fail')) { process.stderr.write('HTTP 401: Bad credentials (fake gh)\\n'); process.exit(1); }
const flag = name => args[args.indexOf(name) + 1];
const [a, b] = args;
if (a === 'pr' && b === 'list') { process.stdout.write(JSON.stringify(read('prs.json', []).filter(pr => pr.state === 'OPEN'))); }
else if (a === 'pr' && b === 'diff') { process.stdout.write('diff --git a/src/db.ts b/src/db.ts\\n+const q = "select * from t where id=" + id;\\n'); }
else if (a === 'pr' && b === 'comment') {
  const comments = read('comments.json', []);
  comments.push({ id: comments.length + 100, pr: Number(args[2]), body: flag('--body') });
  write('comments.json', comments);
} else if (a === 'api' && args.includes('--paginate')) {
  const marker = /contains\\("([^"]+)"\\)/.exec(flag('--jq'))?.[1] ?? '';
  const pr = Number(/issues\\/(\\d+)\\/comments/.exec(args[2])?.[1]);
  for (const comment of read('comments.json', [])) if (comment.pr === pr && comment.body.includes(marker)) process.stdout.write(comment.id + '\\n');
} else if (a === 'api' && args.includes('--method')) {
  const id = Number(/comments\\/(\\d+)$/.exec(args.find(arg => /comments\\/\\d+$/.test(arg)))?.[1]);
  const comments = read('comments.json', []);
  const found = comments.find(comment => comment.id === id);
  if (!found) { process.stderr.write('HTTP 404\\n'); process.exit(1); }
  found.body = args.find(arg => arg.startsWith('body=')).slice(5);
  write('comments.json', comments);
}
`);
await chmod(join(bin, 'gh'), 0o755);
const setPrs = prs => writeFile(join(ghState, 'prs.json'), JSON.stringify(prs));
const readComments = async () => JSON.parse(await readFile(join(ghState, 'comments.json'), 'utf8').catch(() => '[]'));
const ghCalls = async () => (await readFile(join(ghState, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const pr = (number, sha, extra = {}) => ({ number, headRefOid: sha, title: `Change ${number}`, url: `https://github.com/${REPO}/pull/${number}`, baseRefName: 'main', headRefName: `topic-${number}`, isCrossRepository: false, isDraft: false, state: 'OPEN', ...extra });

// ---- deterministic model: always answers with one short sentence ----
const modelRequests = [];
const sse = value => `data: ${JSON.stringify(value)}\n\n`;
const model = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  if (request.url?.endsWith('/models')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'mock-reviewer' }] })); return; }
  if (!request.url?.endsWith('/chat/completions')) { response.writeHead(404); response.end(); return; }
  modelRequests.push(body);
  const text = 'No security issues found in this diff.';
  if (body.stream === true) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sse({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
      + sse({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 } }) + 'data: [DONE]\n\n');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 8 } }));
});
await new Promise(done => model.listen(0, '127.0.0.1', done));
const modelBase = `http://127.0.0.1:${model.address().port}/v1`;

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SCRUB.test(key)));
Object.assign(env, {
  HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, ZERO_0VERSE_MCP: '0', ZERO_PR_COMMENT_MIN_GAP_MS: '0', ZERO_NO_TELEMETRY: '1', ZERO_AGENTS_PERSISTENT_THREAD: '0', NO_COLOR: '1',
  ZERO_SKIP_UPDATE_CHECK: '1', ZERO_E2E_ENGINE_TOKEN: engineToken, ZERO_NO_DEPRECATION_WARNINGS: '1',
});

let child;
let browser;
try {
  child = spawn(process.execPath, [cli, '--host', '127.0.0.1', '--port', '0', '--no-open', '--ready-json',
    '--db-path', join(base, 'engine.db'), '--asset-dir', assets, '--engine-token-env', 'ZERO_E2E_ENGINE_TOKEN',
    '--engine-workspace', workspace], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', data => { output = (output + data).slice(-32000); });
  child.stderr.on('data', data => { errors = (errors + data).slice(-32000); });
  let origin;
  for (const end = Date.now() + 30000; Date.now() < end;) {
    assert.equal(child.exitCode, null, `engine exited early: ${errors}`);
    const ready = /ZERO_DASHBOARD_READY (\{[^\n]+\})/.exec(output);
    if (ready) { origin = JSON.parse(ready[1]).url; break; }
    await wait(50);
  }
  assert.ok(origin, `engine did not become ready: ${errors}`);
  lap('engineReady');

  // The CLI finds the running engine through the same HOME and database, like a user's terminal would.
  const attach = ['--json', '--db-path', join(base, 'engine.db')];
  const run = (args, { allowFail = false } = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args, ...attach], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
    if (!allowFail) assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}${result.stdout}`);
    return result;
  };
  const json = (args) => JSON.parse(run(args).stdout);
  const html = await (await fetch(origin)).text();
  const control = /<meta name="0-control-token" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(control, 'control token meta tag missing');
  const api = async (method, path, body) => {
    const response = await fetch(new URL(path, origin), { method, headers: { 'X-0-Control-Token': control, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };

  // The mock model is the only provider this engine knows.
  const connected = await api('POST', '/api/console/connections', { action: 'connect', providerId: 'openai', baseUrl: modelBase, model: 'mock-reviewer', apiKey: 'synthetic-e2e-key' });
  assert.equal(connected.status, 200, JSON.stringify(connected.data));

  // 1. Two Agents from the real preset: comments on, comments off.
  await setPrs([pr(1, 'a1a1a1a1'), pr(2, 'f1f1f1f1', { isCrossRepository: true }), pr(3, 'd1d1d1d1', { isDraft: true })]);
  const makeAgent = (name, flags) => {
    const agent = json(['agents', 'set', '--create', '--preset', 'pr-security-reviewer', '--name', name]);
    const created = agent.sentinel ?? agent;
    const definition = json(['agents', 'set', '--automation', 'create', '--template', 'repository-review', '--name', `Review pull requests (${name})`, '--target', workspace]);
    const file = join(base, `${created.id}.json`);
    return writeFile(file, JSON.stringify({ ...definition, ownerSentinelId: created.id, runIn: 'new-mission' })).then(() => {
      json(['agents', 'set', '--automation', 'edit', definition.id, '--file', file]);
      json(['agents', 'set', created.id, '--state', 'active', '--acknowledge']);
      const trigger = json(['agents', 'set', created.id, '--trigger', 'add', '--automation', definition.id, '--kind', 'github-pr', '--repo', REPO, '--base-branch', 'main', ...flags]);
      assert.equal(trigger.enabled, false, 'a new trigger starts off');
      return { id: created.id, triggerId: trigger.id };
    });
  };
  const withComments = await makeAgent('Reviewer with comments', ['--comment']);
  const quiet = await makeAgent('Reviewer quiet', []);
  const agents = [withComments, quiet];
  const triggerOf = async agent => (await api('GET', `/api/console/sentinels/${agent.id}/triggers`)).data.triggers.find(item => item.id === agent.triggerId);
  assert.deepEqual([(await triggerOf(withComments)).github.commentOnPr, (await triggerOf(quiet)).github.commentOnPr], [true, false]);
  assert.equal((await triggerOf(quiet)).github.includeForks, false, 'forks are off by default');
  lap('agentsCreated');

  const check = agent => json(['agents', 'set', agent.id, '--trigger', 'check', agent.triggerId]);
  const activations = async agent => (await api('GET', `/api/console/sentinels/${agent.id}/activations`)).data.activations;
  const settle = async (predicate, what) => {
    for (const end = Date.now() + 40000; Date.now() < end;) { const value = await predicate(); if (value) return value; await wait(100); }
    assert.fail(`timed out waiting for ${what}\n${errors.slice(-2000)}`);
  };
  const checkUntilIdle = async agent => { await settle(async () => { const result = run(['agents', 'set', agent.id, '--trigger', 'check', agent.triggerId], { allowFail: true }); return result.status === 0; }, 'trigger check'); };
  for (const agent of agents) json(['agents', 'set', agent.id, '--trigger', 'enable', agent.triggerId, '--yes']);

  // 2. The first poll only baselines. Nothing starts, nothing is posted.
  for (const agent of agents) await checkUntilIdle(agent);
  for (const agent of agents) {
    assert.equal((await triggerOf(agent)).lastStatus === 'baseline' || (await triggerOf(agent)).cursor !== undefined, true, 'baseline recorded');
    assert.deepEqual(await activations(agent), [], 'the baseline poll launches nothing');
  }
  assert.equal(modelRequests.length, 0);
  lap('baseline');

  // 3. A new same-repo pull request, a new fork, a new draft and an old fork/draft that did not change.
  await setPrs([pr(1, 'a1a1a1a1'), pr(2, 'f1f1f1f1', { isCrossRepository: true }), pr(3, 'd1d1d1d1', { isDraft: true }),
    pr(4, 'b2b2b2b2'), pr(5, 'f2f2f2f2', { isCrossRepository: true }), pr(6, 'd2d2d2d2', { isDraft: true }),
    pr(7, 'c7c7c7c7', { state: 'MERGED' })]);
  for (const agent of agents) await checkUntilIdle(agent);
  const done = async agent => settle(async () => { const all = await activations(agent); return all.filter(item => item.status === 'running' || item.status === 'queued').length === 0 && all.length >= 3 ? all : null; }, 'runs to finish');
  for (const agent of agents) {
    const all = await done(agent);
    const reviews = all.filter(item => item.status !== 'skipped');
    assert.equal(reviews.length, 1, 'exactly one thread for the new same-repo pull request');
    assert.equal(reviews[0].trigger.event.pr, 4);
    assert.equal(reviews[0].status, 'completed');
    assert.ok(reviews[0].missionId, 'activation records its thread');
    const skipped = Object.fromEntries(all.filter(item => item.status === 'skipped').map(item => [item.trigger.event.pr, item.trigger.event.skipped]));
    assert.deepEqual(skipped, { 5: 'fork pull request', 6: 'draft pull request' });
    assert.ok(all.every(item => item.trigger.event.pr !== 7), 'merged pull requests are ignored');
  }
  assert.equal(modelRequests.length > 0, true);
  lap('firstReview');

  // 4. Comments: once with the option on, never with it off.
  const marked = id => comment => comment.body.includes(`0-agent-pr-review:${id}`);
  const posted = await settle(async () => { const comments = (await readComments()).filter(marked(withComments.id)); return comments.length ? comments : null; }, 'the PR comment');
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, /Reviewed commit \[`b2b2b2b`\]/);
  assert.doesNotMatch(posted[0].body, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no local paths in the comment');
  assert.equal((await readComments()).filter(marked(quiet.id)).length, 0, 'comments off: nothing is posted');
  assert.ok((await ghCalls()).every(args => !['checkout', 'clone'].includes(args[1]) && args[0] !== 'repo'), 'no gh checkout or clone');

  // 5. Re-push: a new head SHA is reviewed again and the comment is edited, not duplicated.
  await setPrs([pr(1, 'a1a1a1a1'), pr(2, 'f1f1f1f1', { isCrossRepository: true }), pr(3, 'd1d1d1d1', { isDraft: true }), pr(4, 'b3b3b3b3'),
    pr(5, 'f2f2f2f2', { isCrossRepository: true }), pr(6, 'd2d2d2d2', { isDraft: true })]);
  for (const agent of agents) await checkUntilIdle(agent);
  for (const agent of agents) {
    await settle(async () => (await activations(agent)).filter(item => item.status === 'completed' && item.trigger.event.pr === 4).length === 2, 'the re-push review');
  }
  const edited = await settle(async () => { const comments = (await readComments()).filter(marked(withComments.id)); return /b3b3b3b/.test(comments[0]?.body ?? '') ? comments : null; }, 'the comment to be edited');
  assert.equal(edited.length, 1, 'edited in place, not duplicated');
  assert.ok((await ghCalls()).some(args => args.includes('PATCH')), 'the edit goes through the API');
  assert.equal((await readComments()).filter(marked(withComments.id)).length, 1, 'still one comment');
  assert.equal((await readComments()).filter(marked(quiet.id)).length, 0);
  lap('repush');

  // 6. A gh failure is shown on the Agent and does not crash the engine.
  await writeFile(join(ghState, 'fail'), '1');
  await checkUntilIdle(withComments);
  const blocked = await settle(async () => { const trigger = await triggerOf(withComments); return trigger.lastStatus === 'blocked' ? trigger : null; }, 'blocked trigger');
  assert.match(blocked.lastError, /Bad credentials|could not be read/);
  assert.equal(child.exitCode, null, 'engine still running');
  assert.equal((await api('GET', `/api/console/sentinels/${withComments.id}?view=activations`)).status, 200);
  await rm(join(ghState, 'fail'));
  await checkUntilIdle(withComments);
  await settle(async () => (await triggerOf(withComments)).lastStatus !== 'blocked', 'recovery after gh works again');
  lap('ghFailure');

  // 7. The Agent page shows the activations and thread links.
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const problems = [];
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  await page.goto(new URL(`/agents/${withComments.id}?view=activations`, origin).href, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.getByText('Pull request #4', { exact: false }).first().waitFor({ timeout: 15000 });
  const text = await page.locator('body').innerText();
  assert.match(text, /Pull request #5 skipped/);
  assert.match(text, /Pull request #6 skipped/);
  assert.match(text, /fork pull request/);
  assert.match(text, /draft pull request/);
  const threadLinks = await page.locator('a[href^="/chats/"]').count();
  assert.ok(threadLinks >= 2, `expected thread links for both reviews, saw ${threadLinks}`);
  assert.deepEqual(problems, []);
  lap('browser');

  console.log(`PR Agent end to end passed in ${(performance.now() - started) / 1000 | 0}s ${JSON.stringify(timings)}; ${modelRequests.length} model calls, ${(await ghCalls()).length} gh calls.`);
} finally {
  await browser?.close();
  model.closeAllConnections?.();
  await new Promise(done => model.close(done));
  if (child && child.exitCode === null) {
    await new Promise(done => { const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('exit', () => { clearTimeout(timer); done(); }); child.kill('SIGTERM'); });
  }
  await rm(base, { recursive: true, force: true });
}
