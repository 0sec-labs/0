// Automatic telemetry, end to end, fully offline.
//
// The built CLI runs in an isolated HOME with a SCRUBBED environment (no real
// credentials, no inherited ZERO_*), against local fakes only:
//   - a fake PostHog (loopback http) via ZERO_ANALYTICS_POSTHOG_KEY/HOST,
//   - a fake Sentry (local https, self-signed) via ZERO_SENTRY_DSN,
//   - a fake Anthropic provider so a real `scan source` run produces a real
//     usage record from the real event bus (no harness is injected into the
//     engine; the same bus, pipeline and flush path as a user's run).
// Keys are obviously fake. Nothing here can reach a real service: every
// destination is 127.0.0.1 and the env contains no other endpoint.
//
// Asserts: (i) a default fresh install sends anonymous usage with the
// allowlisted fields only; (ii) a forced crash is sent automatically as one
// finite Sentry envelope without message text; (iii) DO_NOT_TRACK,
// ZERO_NO_TELEMETRY and ZERO_OFFLINE each send NOTHING to either server;
// (iv) a saved analyticsLevel off sends nothing to PostHog.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages/cli/dist/index.js');
const assets = join(root, 'packages/web/dist');
const base = await mkdtemp(join(tmpdir(), 'zero-telemetry-'));
const wait = ms => new Promise(done => setTimeout(done, ms));
const FAKE_KEY = 'phc_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000';
const PROVIDER_KEY = '0-telemetry-e2e-local-provider';
const MODEL = 'claude-sonnet-4-6';

// Property set a PostHog usage event may carry. Written out here on purpose,
// independently of the source: adding a field must fail this test until it is
// reviewed and added deliberately.
const REQUIRED_PROPERTIES = ['$geoip_disable', '$ip', '$lib', '$process_person_profile', 'arch', 'channel', 'duration_ms', 'error_counts',
  'finding_severity_counts', 'os', 'runtime', 'surface', 'tool_counts', 'turn_count', 'version'];
const OPTIONAL_PROPERTIES = ['cost_usd'];
const SECRET_MARKERS = ['victim.example', 'SECRET-CRASH-MESSAGE', '/Users/alice', 'hunter2', PROVIDER_KEY, 'console.log', 'tinyrepo', 'index.js'];

// ---- fakes -----------------------------------------------------------------
const posthog = [];
const fakePostHog = createHttpServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => { posthog.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') }); res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":1}'); });
});
await new Promise(done => fakePostHog.listen(0, '127.0.0.1', done));
const posthogHost = `http://127.0.0.1:${fakePostHog.address().port}`;

const key = join(base, 'key.pem');
const cert = join(base, 'cert.pem');
const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
assert.equal(made.status, 0, `openssl failed: ${made.stderr}`);
const sentry = [];
const fakeSentry = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => { sentry.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') }); res.writeHead(200).end('{}'); });
});
await new Promise(done => fakeSentry.listen(0, '127.0.0.1', done));
const dsn = `https://abc123@127.0.0.1:${fakeSentry.address().port}/1`;

// Fake Anthropic Messages API: read the three fixture files, then call `done`.
const providerRequests = [];
const files = ['index.js', 'helper.js', 'value.js'];
const target = join(base, 'tinyrepo');
await mkdir(target, { recursive: true });
for (const file of files) await writeFile(join(target, file), `console.log(${JSON.stringify(file)});\n`);
const fakeProvider = createHttpServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* fall through */ }
  providerRequests.push(req.url);
  const first = !(body.messages ?? []).some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
  const content = first
    ? files.map((file, index) => ({ type: 'tool_use', id: `toolu_e2e_read_${index}`, name: 'read_file', input: { path: join(target, file) } }))
    : [{ type: 'tool_use', id: 'toolu_e2e_done', name: 'done', input: { summary: 'Local fixture completed; no findings.' } }];
  const message = { id: `msg_e2e_${providerRequests.length}`, type: 'message', role: 'assistant', model: MODEL, content, stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 32, output_tokens: 16 } };
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 32, output_tokens: 0 } } });
    content.forEach((block, index) => {
      emit('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      emit('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      emit('content_block_stop', { index });
    });
    emit('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 16 } });
    emit('message_stop', {});
    res.end();
  } else {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify(message));
  }
});
await new Promise(done => fakeProvider.listen(0, '127.0.0.1', done));
const providerOrigin = `http://127.0.0.1:${fakeProvider.address().port}`;

// ---- harness ---------------------------------------------------------------
let runCount = 0;
async function freshHome(settings) {
  const home = join(base, `home-${++runCount}`);
  await mkdir(join(home, '.0'), { recursive: true });
  if (settings) await writeFile(join(home, '.0', 'tui-settings.json'), JSON.stringify(settings));
  return home;
}

/** A scrubbed env: nothing is inherited except PATH, and every endpoint is a local fake. */
function scrubbedEnv(home, extra = {}) {
  const bin = join(home, 'bin');
  return {
    PATH: `${bin}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), TMPDIR: home,
    NO_COLOR: '1', TERM: 'dumb', ZERO_SKIP_UPDATE_CHECK: '1', ZERO_NO_DEPRECATION_WARNINGS: '1',
    ZERO_ANALYTICS_POSTHOG_KEY: FAKE_KEY, ZERO_ANALYTICS_POSTHOG_HOST: posthogHost,
    ZERO_SENTRY_DSN: dsn, NODE_EXTRA_CA_CERTS: cert,
    ANTHROPIC_API_KEY: PROVIDER_KEY, ANTHROPIC_BASE_URL: providerOrigin,
    ZERO_FORCE_PROVIDER: 'anthropic', ZERO_SELECTED_PROVIDER: 'anthropic', ZERO_MODEL: MODEL,
    ZERO_CODEX_AUTH_JSON_PATH: join(home, 'no-auth.json'), CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'),
    ZERO_FEATURE_WEB_RECON: '0', ZERO_FEATURE_WP_FINGERPRINT: '0',
    ...extra,
  };
}

async function runCapture(args, env, home, { nodeArgs = [], timeoutMs = 90000 } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, cli, ...args], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-200000); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-200000); });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** A real offline `scan source` run: the fake provider drives tool calls through the real bus. */
async function usageRun(home, extra = {}) {
  const bin = join(home, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'foxguard'), `#!${process.execPath}\nconsole.log(JSON.stringify({ schema_version: "1.0.0", findings: [], target: { files_scanned: 3 } }));\n`, { mode: 0o700 });
  const result = await runCapture(['scan', 'source', target, '--depth', 'quick', '--runtime', 'api', '--timeout', '10000', '--format', 'json', '--db-path', join(home, 'smoke.db')], scrubbedEnv(home, extra), home);
  assert.equal(result.code, 0, `scan failed (exit ${result.code}): ${result.stderr.slice(-2000)}`);
  return result;
}

/** A forced crash: a preload throws after the engine is up, so the real crash handler runs. */
const preload = join(base, 'crash-preload.mjs');
await writeFile(preload, `setTimeout(() => { throw new Error('SECRET-CRASH-MESSAGE contacting victim.example from /Users/alice/hunter2'); }, 2500);\n`);
async function crashRun(home, extra = {}) {
  const workspace = join(home, 'workspace');
  await mkdir(workspace, { recursive: true });
  const result = await runCapture(['--host', '127.0.0.1', '--port', '0', '--no-open', '--ready-json', '--db-path', join(home, 'engine.db'), '--asset-dir', assets, '--engine-token-env', 'ZERO_E2E_ENGINE_TOKEN', '--engine-workspace', workspace],
    scrubbedEnv(home, { ZERO_E2E_ENGINE_TOKEN: randomBytes(32).toString('hex'), ...extra }), workspace, { nodeArgs: ['--import', preload], timeoutMs: 45000 });
  assert.equal(result.code, 1, `crash run should exit 1, got ${result.code}: ${result.stderr.slice(-1500)}`);
  assert.match(result.stderr, /SECRET-CRASH-MESSAGE/, 'the crash must still be printed locally exactly as before');
  return result;
}

const events = () => posthog.flatMap(request => JSON.parse(request.body).batch);
const reset = () => { posthog.length = 0; sentry.length = 0; };
const everything = () => JSON.stringify({ posthog, sentry });

try {
  // (i) Default fresh install: anonymous usage reaches the fake PostHog, allowlisted fields only.
  {
    reset();
    const home = await freshHome();
    const result = await usageRun(home);
    assert.ok(providerRequests.length >= 2, 'the fake provider must have driven the run');
    await wait(500);
    assert.ok(posthog.length >= 1, `no usage reached the fake PostHog. stderr: ${result.stderr.slice(-800)}`);
    for (const request of posthog) { assert.equal(request.method, 'POST'); assert.equal(request.url, '/batch/'); }
    const body = JSON.parse(posthog[0].body);
    assert.deepEqual(Object.keys(body).sort(), ['api_key', 'batch']);
    assert.equal(body.api_key, FAKE_KEY);
    const installId = (await readFile(join(home, '.0', 'analytics-id'), 'utf8')).trim();
    assert.match(installId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const sent = events();
    assert.ok(sent.length >= 1);
    for (const event of sent) {
      assert.deepEqual(Object.keys(event).sort(), ['distinct_id', 'event', 'properties', 'timestamp']);
      assert.equal(event.event, 'usage');
      assert.equal(event.distinct_id, installId, 'distinct_id is the random install id');
      const keys = Object.keys(event.properties);
      for (const required of REQUIRED_PROPERTIES) assert.ok(keys.includes(required), `missing property ${required}`);
      for (const k of keys) assert.ok([...REQUIRED_PROPERTIES, ...OPTIONAL_PROPERTIES].includes(k), `unexpected property ${k}`);
      assert.equal(event.properties.$geoip_disable, true);
      assert.equal(event.properties.$process_person_profile, false);
      assert.equal(event.properties.$ip, null);
      assert.equal(event.properties.$lib, '0security');
      assert.equal(event.properties.surface, 'cli');
      assert.equal(event.properties.runtime, 'node');
    }
    assert.ok(sent.some(event => (event.properties.tool_counts.read_file ?? 0) >= 1), 'read_file counts should be present');
    const wire = everything();
    for (const marker of SECRET_MARKERS) assert.equal(wire.includes(marker), false, `leaked ${marker}`);
    assert.equal(wire.includes(home), false, 'no filesystem path');
    assert.equal(sentry.length, 0, 'a clean run reports no crash');
    assert.equal(result.stderr.includes('anonymous usage counts'), false, 'no first-run notice on a non-TTY stderr');
    console.log(`(i) default fresh install: ${sent.length} anonymous usage event(s), allowlisted fields only.`);
  }

  // (ii) A forced crash is sent automatically as one finite envelope, no message text.
  {
    reset();
    const home = await freshHome();
    await crashRun(home);
    assert.equal(sentry.length, 1, `expected exactly one envelope, got ${sentry.length}`);
    assert.equal(sentry[0].url, '/api/1/envelope/');
    const [header, itemHeader, payload] = sentry[0].body.trim().split('\n');
    assert.ok(JSON.parse(header).event_id);
    assert.equal(JSON.parse(itemHeader).type, 'event');
    const event = JSON.parse(payload);
    assert.equal(event.tags.surface, 'web');
    const allowedTags = ['cli_version', 'release_channel', 'build_commit', 'kind', 'surface', 'command', 'platform', 'arch', 'runtime'];
    for (const tag of Object.keys(event.tags)) assert.ok(allowedTags.includes(tag), `unexpected tag ${tag}`);
    for (const marker of ['SECRET-CRASH-MESSAGE', 'victim.example', '/Users/alice', 'hunter2', home]) assert.equal(sentry[0].body.includes(marker), false, `crash envelope leaked ${marker}`);
    assert.equal(posthog.length, 0, 'a crash alone is not usage');
    console.log('(ii) forced crash: one finite Sentry envelope, no message text.');
  }

  // (iii) Each hard opt-out sends nothing to either server, for usage and crash alike.
  for (const [name, value] of [['DO_NOT_TRACK', '1'], ['ZERO_NO_TELEMETRY', '1'], ['ZERO_OFFLINE', '1']]) {
    reset();
    await usageRun(await freshHome(), { [name]: value });
    await crashRun(await freshHome(), { [name]: value });
    await wait(700);
    assert.equal(posthog.length, 0, `${name}: PostHog received ${posthog.length} request(s)`);
    assert.equal(sentry.length, 0, `${name}: Sentry received ${sentry.length} request(s)`);
    console.log(`(iii) ${name}=${value}: nothing reached either server.`);
  }

  // (iv) A saved analyticsLevel off sends nothing to PostHog.
  {
    reset();
    await usageRun(await freshHome({ analyticsLevel: 'off' }));
    await wait(700);
    assert.equal(posthog.length, 0, `analyticsLevel off: PostHog received ${posthog.length} request(s)`);
    console.log('(iv) saved analyticsLevel off: nothing reached PostHog.');
  }

  console.log('Telemetry e2e passed.');
} finally {
  for (const server of [fakePostHog, fakeSentry, fakeProvider]) { server.closeAllConnections?.(); server.close(); }
  await rm(base, { recursive: true, force: true });
}
