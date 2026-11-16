// One engine, one reporter: crash reports reach the (fake) Sentry only after review.
//
// Starts a disposable `0` engine (loopback, isolated HOME, no provider
// credentials, diagnosticReporting=ask saved as an explicit choice) whose ZERO_SENTRY_DSN points at a local
// HTTPS server that records every request. A browser-style error report is
// posted to the engine; the e2e asserts NOTHING reaches the fake Sentry until
// the stored report is previewed and confirmed through the API, then that
// exactly one envelope arrives carrying finite fields only. It also covers the
// control-token gate, malformed ids/bodies and `0 config doctor --discard-reports`.
// The real DSN is never used.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages/cli/dist/index.js');
const assets = join(root, 'packages/web/dist');
const base = await mkdtemp(join(tmpdir(), 'zero-crash-'));
const home = join(base, 'home');
const workspace = join(base, 'workspace');
await mkdir(home, { recursive: true });
await mkdir(workspace, { recursive: true });
// `automatic` is the default now; this e2e covers the review flow, so choose `ask` explicitly.
await mkdir(join(home, '.0'), { recursive: true });
await writeFile(join(home, '.0', 'tui-settings.json'), JSON.stringify({ diagnosticReporting: 'ask', diagnosticReportingPrompted: true }));
const wait = ms => new Promise(done => setTimeout(done, ms));

// Self-signed certificate for the fake Sentry, trusted only by the engine under test.
const key = join(base, 'key.pem');
const cert = join(base, 'cert.pem');
const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
assert.equal(made.status, 0, `openssl failed: ${made.stderr}`);

const received = [];
const sentry = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => { received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }); res.writeHead(200).end('{}'); });
});
await new Promise(done => sentry.listen(0, '127.0.0.1', done));
const dsn = `https://abc123@127.0.0.1:${sentry.address().port}/1`;

const env = {
  PATH: process.env.PATH, HOME: home, NO_COLOR: '1', ZERO_SKIP_UPDATE_CHECK: '1', ZERO_NO_DEPRECATION_WARNINGS: '1',
  ZERO_SENTRY_DSN: dsn, NODE_EXTRA_CA_CERTS: cert, ZERO_E2E_ENGINE_TOKEN: randomBytes(32).toString('hex'),
};

let child;
try {
  child = spawn(process.execPath, [cli, '--host', '127.0.0.1', '--port', '0', '--no-open', '--ready-json',
    '--db-path', join(base, 'engine.db'), '--asset-dir', assets, '--engine-token-env', 'ZERO_E2E_ENGINE_TOKEN', '--engine-workspace', workspace],
  { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const html = await (await fetch(origin)).text();
  const token = /<meta name="0-control-token" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(token, 'control token meta tag missing');

  const api = (path, method = 'GET', body, headers = { 'X-0-Control-Token': token }) =>
    fetch(new URL(`/api/console/${path}`, origin), { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const json = async response => response.json().catch(() => null);
  const report = { name: 'TypeError', frames: ['assets/index-abc123.js:10:20', 'assets/vendor.js:3:4'], surface: 'web' };

  // 1. Control-token gate: wrong or missing token is 403 on every new route.
  for (const headers of [{}, { 'X-0-Control-Token': 'wrong' }]) {
    assert.equal((await api('diagnostics/report', 'POST', report, headers)).status, 403);
    assert.equal((await api('diagnostics/pending', 'GET', undefined, headers)).status, 403);
    assert.equal((await api(`diagnostics/pending/${'a'.repeat(32)}`, 'POST', { action: 'discard' }, headers)).status, 403);
  }
  assert.deepEqual((await json(await api('diagnostics/pending'))).reports, [], 'a rejected request must store nothing');

  // 2. A browser report is stored, not sent (diagnosticReporting=ask).
  assert.equal((await api('diagnostics/report', 'POST', report)).status, 202);
  assert.equal((await api('diagnostics/report', 'POST', report)).status, 202, 'a burst is accepted but collapsed');
  const { reports } = await json(await api('diagnostics/pending'));
  assert.equal(reports.length, 1, 'duplicate must be collapsed');
  assert.deepEqual(Object.keys(reports[0]).sort(), ['category', 'createdAt', 'id', 'surface']);
  assert.equal(reports[0].category, 'TypeError');
  const id = reports[0].id;

  // 3. Malformed input is a client error, never a 500, and never sends.
  for (const bad of [null, [], 'x', {}, { name: 'Error: host.example', frames: [], surface: 'web' }, { ...report, message: 'leak' }, { ...report, frames: ['/Users/a/x.js:1:1'] }]) {
    const status = (await api('diagnostics/report', 'POST', bad)).status;
    assert.ok(status >= 400 && status < 500, `report body ${JSON.stringify(bad)} -> ${status}`);
  }
  for (const badId of ['%zz', '..%2f..%2fetc%2fpasswd', '..', 'A'.repeat(32), 'a'.repeat(31), '%00']) {
    for (const body of [{ action: 'preview' }, { action: 'send', previewId: 'x' }, { action: 'discard' }, null, []]) {
      const status = (await api(`diagnostics/pending/${badId}`, 'POST', body)).status;
      assert.ok(status >= 400 && status < 500, `id ${badId} -> ${status}`);
    }
  }
  for (const body of [null, [], {}, { action: 'delete' }]) assert.equal((await api(`diagnostics/pending/${id}`, 'POST', body)).status, 400);
  assert.equal((await json(await api('diagnostics/pending'))).reports.length, 1, 'bad requests must not discard the report');

  // 4. Nothing has reached Sentry, even after waiting; sending needs a confirmed preview.
  await wait(1500);
  assert.equal(received.length, 0, 'nothing may be sent before review');
  assert.equal((await api(`diagnostics/pending/${id}`, 'POST', { action: 'send' })).status, 409);
  assert.equal((await api(`diagnostics/pending/${id}`, 'POST', { action: 'send', previewId: 'guess' })).status, 409);
  assert.equal(received.length, 0);

  // 5. Preview shows the literal body with the key redacted; still nothing sent.
  const previewed = await json(await api(`diagnostics/pending/${id}`, 'POST', { action: 'preview' }));
  assert.equal(typeof previewed.previewId, 'string');
  assert.ok(previewed.preview.body.includes('"WebError"') || previewed.preview.body.includes('WebError'));
  assert.ok(!JSON.stringify(previewed).includes('abc123@'));
  assert.match(previewed.preview.headers['x-sentry-auth'], /<redacted>/);
  assert.equal(received.length, 0, 'preview must not send');

  // 6. Confirm: exactly one envelope arrives, with finite fields only.
  const sent = await api(`diagnostics/pending/${id}`, 'POST', { action: 'send', previewId: previewed.previewId });
  assert.equal(sent.status, 200, JSON.stringify(await json(sent)));
  await wait(300);
  assert.equal(received.length, 1, 'exactly one envelope');
  const [request] = received;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/1/envelope/');
  assert.match(request.headers['x-sentry-auth'], /sentry_key=abc123/);
  assert.equal(request.body, previewed.preview.body, 'wire bytes equal the reviewed preview');
  const [header, itemHeader, payload] = request.body.trim().split('\n');
  assert.ok(JSON.parse(header).event_id);
  assert.equal(JSON.parse(itemHeader).type, 'event');
  const event = JSON.parse(payload);
  assert.equal(event.tags.surface, 'web');
  assert.equal(event.exception.values[0].value, 'TypeError');
  assert.deepEqual(event.exception.values[0].stacktrace.frames.map(frame => frame.filename), ['app:///assets/index-abc123.js', 'app:///assets/vendor.js']);
  const allowedTags = ['cli_version', 'release_channel', 'build_commit', 'kind', 'surface', 'command', 'platform', 'arch', 'runtime'];
  assert.ok(Object.keys(event.tags).every(tag => allowedTags.includes(tag)), `unexpected tags ${Object.keys(event.tags)}`);
  assert.ok(!/message|Cannot|\/Users|\/home|localhost|tmp/i.test(payload.replace(/"platform":"node"/, '')), `payload leaks: ${payload}`);
  assert.deepEqual((await json(await api('diagnostics/pending'))).reports, [], 'a sent report leaves the queue');
  assert.equal((await api(`diagnostics/pending/${id}`, 'POST', { action: 'send', previewId: previewed.previewId })).status, 404, 'a preview cannot be replayed');

  // 7. `0 config doctor` announces waiting reports, and --discard-reports removes them without sending.
  assert.equal((await api('diagnostics/report', 'POST', { ...report, name: 'RangeError' })).status, 202);
  const doctorEnv = { ...env, ZERO_SENTRY_DSN: dsn };
  const doctor = spawnSync(process.execPath, [cli, 'config', 'doctor'], { cwd: workspace, env: doctorEnv, encoding: 'utf8', timeout: 30000 });
  assert.match(doctor.stdout, /1 crash report is waiting for review: open the web console .* 0 config doctor --discard-reports/);
  const discard = spawnSync(process.execPath, [cli, 'config', 'doctor', '--discard-reports'], { cwd: workspace, env: doctorEnv, encoding: 'utf8', timeout: 30000 });
  assert.equal(discard.status, 0, discard.stderr);
  assert.match(discard.stdout, /Discarded 1 crash report\. Nothing was sent\./);
  assert.deepEqual((await json(await api('diagnostics/pending'))).reports, []);
  await wait(300);
  assert.equal(received.length, 1, 'discard must not send');

  console.log('Crash reporting: nothing is sent before review; one finite envelope after confirmation.');
} finally {
  if (child && child.exitCode === null) {
    await new Promise(done => { const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('exit', () => { clearTimeout(timer); done(); }); child.kill('SIGTERM'); });
  }
  sentry.close();
  await rm(base, { recursive: true, force: true });
}
