// One engine, two interfaces: the CLI and the browser must see the same state.
//
// Starts a disposable `0 web` engine (loopback, isolated HOME, no provider
// credentials), creates a chat through the CLI, then walks every browser route
// and fails on a console error, a failed /api call or an error screen. Finally
// asserts the chat the CLI created is visible in the browser and through the
// engine's HTTP API.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages/cli/dist/index.js');
const assets = join(root, 'packages/web/dist');
const { chromium } = createRequire(join(root, 'packages/engine/package.json'))('playwright');

// Every user-facing route in packages/web/src/pages/operations-app.tsx that does
// not need an id. Keep in sync when routes are added.
const ROUTES = ['/', '/console', '/automations', '/findings', '/runs', '/workers', '/skills', '/learning',
  '/engagements', '/team', '/api-access', '/connections', '/settings', '/doctor', '/scans', '/threads'];
// Provider credentials must never leak into an e2e run.
const SCRUB = /(_API_KEY|_TOKEN|_SECRET|_ACCESS_KEY|^OPENAI|^ANTHROPIC|^AZURE_|^GOOGLE_|^GEMINI|^DEEPSEEK|^OPENROUTER|^QWEN)/;

const base = await mkdtemp(join(tmpdir(), 'zero-parity-'));
const home = join(base, 'home');
const workspace = join(base, 'workspace');
await mkdir(home, { recursive: true });
await mkdir(workspace, { recursive: true });
const engineToken = randomBytes(32).toString('hex');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SCRUB.test(key)));
Object.assign(env, {
  HOME: home, ZERO_OFFLINE: '1', ZERO_NO_TELEMETRY: '1', NO_COLOR: '1', ZERO_SKIP_UPDATE_CHECK: '1',
  ZERO_E2E_ENGINE_TOKEN: engineToken, ZERO_NO_DEPRECATION_WARNINGS: '1',
});
const wait = ms => new Promise(done => setTimeout(done, ms));

let child;
let browser;
try {
  child = spawn(process.execPath, [cli, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open', '--ready-json',
    '--db-path', join(base, 'engine.db'), '--asset-dir', assets, '--engine-token-env', 'ZERO_E2E_ENGINE_TOKEN',
    '--engine-workspace', workspace], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
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

  // 1. CLI -> engine.
  const attach = ['--engine-url', origin, '--engine-token-env', 'ZERO_E2E_ENGINE_TOKEN', '--format', 'json'];
  const run = args => {
    const result = spawnSync(process.execPath, [cli, ...args, ...attach], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const created = run(['chats', 'create']);
  assert.equal(typeof created.id, 'string');
  assert.ok(run(['chats', 'list']).some(chat => chat.id === created.id), 'CLI cannot see the chat it created');
  assert.ok(run(['automation', 'list', '--templates']).some(template => template.id === 'repository-review'));
  assert.deepEqual(run(['runs', 'list']), []);

  // 2. Browser -> same engine: every route renders without errors.
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const problems = [];
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/') && response.status() >= 400) problems.push(`${response.status()} ${url.pathname}`);
  });
  for (const route of ROUTES) {
    problems.length = 0;
    await page.goto(new URL(route, origin).href, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const text = await page.locator('body').innerText();
    assert.ok(text.trim().length > 20, `${route}: page is blank`);
    assert.doesNotMatch(text, /Something went wrong|Unexpected Application Error|Cannot read properties/i, `${route}: error screen`);
    assert.deepEqual(problems, [], `${route}: ${problems.join(' | ')}`);
  }

  // 3. The chat the CLI created is the chat the browser shows (same engine state).
  const html = await (await fetch(origin)).text();
  const control = /<meta name="0-control-token" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(control, 'control token meta tag missing');
  const sessions = await (await fetch(new URL('/api/console/sessions', origin), { headers: { 'X-0-Control-Token': control } })).json();
  const ids = JSON.stringify(sessions);
  assert.ok(ids.includes(created.id), 'engine API does not list the CLI-created chat');
  await page.goto(new URL(`/console/${created.id}`, origin).href, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  assert.doesNotMatch(await page.locator('body').innerText(), /not found|Something went wrong/i, 'browser cannot open the CLI-created chat');
  console.log(`CLI and browser agree: ${ROUTES.length} routes render cleanly and chat ${created.id.slice(0, 8)} is shared.`);
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    await new Promise(done => { const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('exit', () => { clearTimeout(timer); done(); }); child.kill('SIGTERM'); });
  }
  await rm(base, { recursive: true, force: true });
}
