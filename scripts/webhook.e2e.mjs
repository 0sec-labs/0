// The GitHub webhook receiver, end to end, in server mode.
//
// Starts a disposable `0 --server-mode` (isolated HOME and database, no real credentials, ZERO_0VERSE_MCP=0) with a
// fake `gh` on PATH and a deterministic OpenAI-compatible model server. A pull request Agent is created through the CLI,
// the webhook secret is created through the console API, and signed `pull_request` deliveries are sent to
// POST /api/webhooks/github as GitHub would (no cookie, no control token). Asserts: no secret means 404, a correctly signed
// delivery starts exactly one thread/activation, a replayed delivery is ignored, a bad signature is 401, an oversize body is
// 413, the poller does not launch the same head SHA again, rotation keeps the old secret for the grace window, and the audit
// log and CLI status never contain the secret.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const started = performance.now();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages/cli/dist/index.js');
const SCRUB = /(_API_KEY|_TOKEN|_SECRET|_ACCESS_KEY|^OPENAI|^ANTHROPIC|^AZURE_|^GOOGLE_|^GEMINI|^DEEPSEEK|^OPENROUTER|^QWEN|^GH_|^GITHUB_)/;
const REPO = 'acme/app';
const HOOK = '/api/webhooks/github';
const wait = ms => new Promise(done => setTimeout(done, ms));
const timings = {};
const lap = name => { timings[name] = Math.round(performance.now() - started); if (process.env.E2E_TRACE) console.log('lap', name, timings[name]); };

const base = await mkdtemp(join(tmpdir(), 'zero-webhook-e2e-'));
const home = join(base, 'home');
const workspace = join(base, 'workspace');
const bin = join(base, 'bin');
const ghState = join(base, 'gh');
const assets = join(base, 'assets');
await Promise.all([home, workspace, bin, ghState, assets].map(dir => mkdir(dir, { recursive: true })));
await writeFile(join(assets, 'index.html'), '<!doctype html><html><head><title>e2e</title></head><body>app</body></html>');
const accessToken = randomBytes(32).toString('hex');
const engineToken = randomBytes(32).toString('hex');

// ---- fake gh: canned `pr list` and `pr diff`; logs every argv ----
await writeFile(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const dir = ${JSON.stringify(ghState)};
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/calls.log', JSON.stringify(args) + '\\n');
const [a, b] = args;
if (a === 'pr' && b === 'list') { let prs = []; try { prs = JSON.parse(fs.readFileSync(dir + '/prs.json', 'utf8')); } catch {} process.stdout.write(JSON.stringify(prs.filter(pr => pr.state === 'OPEN'))); }
else if (a === 'pr' && b === 'diff') { process.stdout.write('diff --git a/src/db.ts b/src/db.ts\\n+const q = "select * from t where id=" + id;\\n'); }
`);
await chmod(join(bin, 'gh'), 0o755);
const setPrs = prs => writeFile(join(ghState, 'prs.json'), JSON.stringify(prs));
const ghCalls = async () => (await readFile(join(ghState, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const pr = (number, sha, extra = {}) => ({ number, headRefOid: sha, title: `Change ${number}`, url: `https://github.com/${REPO}/pull/${number}`, baseRefName: 'main', headRefName: `topic-${number}`, isCrossRepository: false, isDraft: false, state: 'OPEN', ...extra });

// ---- deterministic model ----
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

const port = await new Promise(done => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => done(free)); }); });
const origin = `http://localhost:${port}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SCRUB.test(key)));
Object.assign(env, {
  HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, ZERO_0VERSE_MCP: '0', ZERO_NO_TELEMETRY: '1', NO_COLOR: '1', ZERO_SKIP_UPDATE_CHECK: '1',
  ZERO_NO_DEPRECATION_WARNINGS: '1', ZERO_ACCESS_TOKEN: accessToken, ZERO_E2E_ENGINE_TOKEN: engineToken,
});

const sign = (body, secret) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
/** Raw POST like GitHub: no cookie, no control token, no Origin. Tolerates the server closing early on an oversize body. */
const deliver = (body, { bearer, secret, event = 'pull_request', id = `e2e-${randomBytes(6).toString('hex')}`, signature, contentType = 'application/json' } = {}) => new Promise((resolveReply, reject) => {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { Host: `localhost:${port}`, 'content-type': contentType, 'content-length': String(payload.length), 'x-github-event': event, 'x-github-delivery': id, 'user-agent': 'GitHub-Hookshot/e2e' };
  const sig = signature ?? (secret ? sign(payload, secret) : undefined);
  if (sig) headers['x-hub-signature-256'] = sig;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  let status;
  const req = httpRequest({ host: '127.0.0.1', port, path: HOOK, method: 'POST', headers }, res => {
    status = res.statusCode; const chunks = []; res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolveReply({ status, text: Buffer.concat(chunks).toString(), id }));
  });
  req.on('error', error => { if (status === undefined) reject(error); });
  req.end(payload);
});
const prEvent = (number, sha, action = 'opened', extra = {}) => JSON.stringify({ action, number, repository: { full_name: REPO }, pull_request: { number, state: 'open', draft: false, base: { ref: 'main' }, head: { sha, ref: `topic-${number}` }, title: `Change ${number}` }, ...extra });

let child;
let errors = '';
try {
  child = spawn(process.execPath, [cli, '--host', '127.0.0.1', '--port', String(port), '--no-open', '--ready-json', '--server-mode', '--allowed-host', 'localhost,127.0.0.1', '--public-url', origin,
    '--db-path', join(base, 'engine.db'), '--asset-dir', assets, '--engine-token-env', 'ZERO_E2E_ENGINE_TOKEN', '--engine-workspace', workspace], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-32000); });
  child.stderr.on('data', data => { errors = (errors + data).slice(-32000); });
  for (const end = Date.now() + 30000; Date.now() < end;) {
    assert.equal(child.exitCode, null, `engine exited early: ${errors}`);
    if (output.includes('ZERO_DASHBOARD_READY')) break;
    await wait(50);
  }
  assert.ok(output.includes('ZERO_DASHBOARD_READY'), `engine did not become ready: ${errors}`);
  lap('engineReady');

  // Browser-style session for the console API (sign in with the access token, then control token plus Origin).
  const login = await fetch(`${origin}/_access/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token: accessToken }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const page = await (await fetch(origin, { headers: { cookie } })).text();
  const control = /<meta name="0-control-token" content="([^"]+)"/.exec(page)?.[1];
  assert.ok(control, 'control token for the signed-in browser');
  const api = async (method, path, body) => {
    const send = () => fetch(new URL(path, origin), { method, headers: { cookie, origin, 'X-0-Control-Token': control, 'content-type': 'application/json', connection: 'close' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const response = await send();
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };
  const attach = ['--json', '--db-path', join(base, 'engine.db')];
  const run = (args, { allowFail = false } = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args, ...attach], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
    if (!allowFail) assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}${result.stdout}`);
    return result;
  };
  const json = args => JSON.parse(run(args).stdout);

  const connected = await api('POST', '/api/console/connections', { action: 'connect', providerId: 'openai', baseUrl: modelBase, model: 'mock-reviewer', apiKey: 'synthetic-e2e-key' });
  assert.equal(connected.status, 200, JSON.stringify(connected.data));

  // 1. Not set up yet: the route answers 404 to everyone, and the card has nothing to show but "Off".
  const sample = prEvent(4, 'b2b2b2b2');
  assert.equal((await deliver(sample, { secret: 'ff'.repeat(32) })).status, 404, 'no secret means no route');
  assert.deepEqual((await api('GET', '/api/console/github/webhook')).data.webhook.configured, false);

  // 2. One Agent with an enabled pull request trigger, baselined against the current open pull requests.
  await setPrs([pr(1, 'a1a1a1a1')]);
  const agent = json(['agents', 'set', '--create', '--preset', 'pr-security-reviewer', '--name', 'Webhook reviewer']);
  const created = agent.sentinel ?? agent;
  const definition = json(['agents', 'set', '--automation', 'create', '--template', 'repository-review', '--name', 'Review pull requests (webhook)', '--target', workspace]);
  const file = join(base, 'definition.json');
  await writeFile(file, JSON.stringify({ ...definition, ownerSentinelId: created.id, runIn: 'new-mission' }));
  json(['agents', 'set', '--automation', 'edit', definition.id, '--file', file]);
  json(['agents', 'set', created.id, '--state', 'active', '--acknowledge']);
  const trigger = json(['agents', 'set', created.id, '--trigger', 'add', '--automation', definition.id, '--kind', 'github-pr', '--repo', REPO, '--base-branch', 'main']);
  json(['agents', 'set', created.id, '--trigger', 'enable', trigger.id, '--yes']);
  const settle = async (predicate, what) => {
    for (const end = Date.now() + 40000; Date.now() < end;) { const value = await predicate(); if (value) return value; await wait(100); }
    assert.fail(`timed out waiting for ${what}\n${errors.slice(-2000)}`);
  };
  await settle(async () => run(['agents', 'set', created.id, '--trigger', 'check', trigger.id], { allowFail: true }).status === 0, 'baseline check');
  const activations = async () => (await api('GET', `/api/console/sentinels/${created.id}/activations`)).data.activations;
  assert.deepEqual(await activations(), [], 'baseline launches nothing');
  lap('agentReady');

  // 3. The secret is created once through the console API; the CLI never sees it again except on rotate.
  const secretReply = await api('POST', '/api/console/github/webhook/secret', {});
  assert.equal(secretReply.status, 201);
  const secret = secretReply.data.secret;
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(secretReply.data.webhook.payloadUrl, `${origin}${HOOK}`);
  assert.equal((await api('POST', '/api/console/github/webhook/secret', {})).status, 409, 'create only once');
  const mode = (await stat(join(home, '.0', 'github-webhook-secret.json')).catch(async () => { const found = (await readdir(home, { recursive: true })).find(name => name.endsWith('github-webhook-secret.json')); return stat(join(home, found)); })).mode & 0o777;
  assert.equal(mode, 0o600, 'secret file is 0600');
  const statusText = run(['agents', 'webhook', 'status']).stdout;
  assert.ok(!statusText.includes(secret), 'status never prints the secret');
  lap('secret');

  // 4. A correctly signed delivery for a new pull request: 202, then exactly one activation and one thread.
  await setPrs([pr(1, 'a1a1a1a1'), pr(4, 'b2b2b2b2')]);
  const first = await deliver(sample, { secret });
  assert.equal(first.status, 202, first.text);
  const finished = await settle(async () => { const all = await activations(); return all.length === 1 && all[0].status === 'completed' ? all : null; }, 'the webhook-triggered run');
  assert.equal(finished[0].trigger.event.pr, 4);
  assert.equal(finished[0].trigger.event.headSha, 'b2b2b2b2');
  assert.ok(finished[0].missionId, 'the activation links its thread');
  const modelCalls = modelRequests.length;
  assert.ok(modelCalls > 0);
  lap('delivered');

  // 5. Replay of the same delivery id, a second event for the same SHA, and the poller: still one run.
  assert.equal((await deliver(sample, { secret, id: first.id })).status, 202, 'replay is acknowledged');
  assert.equal((await deliver(prEvent(4, 'b2b2b2b2', 'synchronize'), { secret })).status, 202, 'a new delivery id for the same head SHA');
  await wait(1500);
  json(['agents', 'set', created.id, '--trigger', 'check', trigger.id]);
  await wait(1500);
  assert.equal((await activations()).length, 1, 'one head SHA launches once across replay, a second event and the poller');
  assert.equal(modelRequests.length, modelCalls);
  const hook = (await api('GET', '/api/console/github/webhook')).data.webhook;
  assert.ok(hook.deliveries.some(item => item.result === 'ignored' && item.reason === 'duplicate_delivery'), 'the replay is recorded as ignored');
  assert.equal(hook.lastDeliveryAt !== undefined, true);

  // 6. Bad signature, tampered body, no signature, wrong content type, oversize body, other events.
  const bad = await deliver(sample, { signature: sign(sample, 'ee'.repeat(32)) });
  assert.equal(bad.status, 401); assert.equal(bad.text, '{}', 'no detail on a bad signature');
  assert.equal((await deliver(sample.replace('opened', 'synchronize'), { signature: sign(sample, secret) })).status, 401, 'tampered body');
  assert.equal((await deliver(sample, {})).status, 401, 'missing signature');
  assert.equal((await deliver(sample, { secret, contentType: 'application/x-www-form-urlencoded' })).status, 415);
  const oversize = Buffer.alloc(1_000_001, 0x61);
  assert.equal((await deliver(oversize, { secret })).status, 413, 'oversize body');
  assert.equal((await deliver(JSON.stringify({ zen: 'Keep it logically awesome.' }), { secret, event: 'ping' })).status, 202);
  assert.equal((await deliver('{}', { secret, event: 'push' })).status, 202);
  assert.equal((await deliver(prEvent(4, 'c3c3c3c3', 'closed'), { secret })).status, 202);
  assert.equal((await deliver(sample, { bearer: engineToken })).status, 401, 'the engine bearer is not a credential for the webhook');
  assert.equal((await deliver(sample, { bearer: engineToken, signature: sign(sample, 'ee'.repeat(32)) })).status, 401);
  // Everything else under /api stays behind sign-in for an anonymous caller.
  for (const path of ['/api/console/sessions', `${HOOK}/`, '/api/console/github/webhook']) {
    const anonymous = await fetch(new URL(path, origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anonymous.status, 401, `${path} needs sign-in`);
  }
  await wait(300);
  assert.equal((await activations()).length, 1, 'rejected and ignored deliveries start nothing');
  lap('rejections');

  // 7. Rotation: the old secret works for the grace window, the new one works, and the CLI shows the new one once.
  const rotated = run(['agents', 'webhook', 'secret', 'rotate', '--yes', '--json']);
  const next = JSON.parse(rotated.stdout).secret;
  assert.match(next, /^[0-9a-f]{64}$/); assert.notEqual(next, secret);
  assert.equal((await deliver(JSON.stringify({ zen: 'old' }), { secret, event: 'ping' })).status, 202, 'old secret inside the grace window');
  assert.equal((await deliver(JSON.stringify({ zen: 'new' }), { secret: next, event: 'ping' })).status, 202);
  assert.equal((await deliver(JSON.stringify({ zen: 'x' }), { secret: 'dd'.repeat(32), event: 'ping' })).status, 401);
  assert.ok(!run(['agents', 'webhook', 'status']).stdout.includes(next), 'status never prints the new secret');
  lap('rotation');

  // 8. The audit log has the events and neither secret, signature nor payload text.
  const audit = JSON.stringify((await api('GET', '/api/console/audit-log?limit=500')).data);
  for (const action of ['webhook.received', 'webhook.ignored', 'webhook.rejected', 'github.webhook.secret.create']) assert.ok(audit.includes(action), `audit has ${action}`);
  for (const forbidden of [secret, next, sign(sample, secret), 'Change 4', 'b2b2b2b2']) assert.ok(!audit.includes(forbidden), 'audit carries no secret, signature or payload');
  for (const forbidden of [secret, next, sign(sample, secret)]) assert.ok(!output.includes(forbidden) && !errors.includes(forbidden), 'logs carry no secret or signature');
  const listCalls = (await ghCalls()).filter(args => args[0] === 'pr' && args[1] === 'list').length;
  assert.ok(listCalls >= 3, 'the poller routine ran for baseline, the webhook and the explicit check');
  lap('done');
  console.log(`webhook e2e ok in ${Math.round(performance.now() - started)} ms ${JSON.stringify(timings)}`);
} catch (error) {
  console.error(`engine stderr tail:\n${errors.slice(-3000)}\n${error?.stack}`);
  throw error;
} finally {
  model.closeAllConnections?.();
  await new Promise(done => model.close(done));
  if (child && child.exitCode === null) {
    await new Promise(done => { const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('exit', () => { clearTimeout(timer); done(); }); child.kill('SIGTERM'); });
  }
  await rm(base, { recursive: true, force: true });
}
