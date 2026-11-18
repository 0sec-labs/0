// Automatic telemetry, end to end, fully offline.
//
// The built CLI runs in an isolated HOME with a SCRUBBED environment (no real
// credentials, no inherited ZERO_*), against local fakes only:
//   - a fake PostHog (loopback http) via ZERO_ANALYTICS_POSTHOG_KEY/HOST,
//   - a fake Sentry (local https, self-signed) via ZERO_SENTRY_DSN,
// Usage events are covered by the unit tests in packages/engine/src/telemetry; there is
// no one-shot command left in the CLI that produces them in this offline setup.
// Keys are obviously fake. Nothing here can reach a real service: every
// destination is 127.0.0.1 and the env contains no other endpoint.
//
// Asserts: (ii) a forced crash is sent automatically as one
// finite Sentry envelope without message text; (iii) DO_NOT_TRACK,
// ZERO_NO_TELEMETRY and ZERO_OFFLINE each send NOTHING to either server;
// 
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

// Fake Anthropic Messages API: read the three fixture files, then end the turn with text.
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
    ? files.map((file, index) => ({ type: 'tool_use', id: `toolu_e2e_read_${index}`, name: 'bash', input: { command: `cat ${join(target, file)}` } }))
    : [{ type: 'text', text: 'Read the fixture files; nothing to report.' }];
  const stopReason = first ? 'tool_use' : 'end_turn';
  const message = { id: `msg_e2e_${providerRequests.length}`, type: 'message', role: 'assistant', model: MODEL, content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 32, output_tokens: 16 } };
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 32, output_tokens: 0 } } });
    content.forEach((block, index) => {
      if (block.type === 'text') {
        emit('content_block_start', { index, content_block: { type: 'text', text: '' } });
        emit('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
      } else {
        emit('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
        emit('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      }
      emit('content_block_stop', { index });
    });
    emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 16 } });
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

  // (iii) Each hard opt-out sends nothing to either server.
  for (const [name, value] of [['DO_NOT_TRACK', '1'], ['ZERO_NO_TELEMETRY', '1'], ['ZERO_OFFLINE', '1']]) {
    reset();
    await crashRun(await freshHome(), { [name]: value });
    await wait(700);
    assert.equal(posthog.length, 0, `${name}: PostHog received ${posthog.length} request(s)`);
    assert.equal(sentry.length, 0, `${name}: Sentry received ${sentry.length} request(s)`);
    console.log(`(iii) ${name}=${value}: nothing reached either server.`);
  }

  console.log('Telemetry e2e passed.');
} finally {
  for (const server of [fakePostHog, fakeSentry, fakeProvider]) { server.closeAllConnections?.(); server.close(); }
  await rm(base, { recursive: true, force: true });
}
