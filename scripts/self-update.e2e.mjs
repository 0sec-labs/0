// Update from the web console, end to end, fully offline.
//
// A copy of the bun runtime stands in for the installed `0` binary (a managed install: named `0`, in a
// writable folder). It serves the real built console. A fake release server (loopback) plays GitHub: the
// latest-release JSON, the real install.sh, checksums and a "new" 0 that is the same console built as
// version 999.0.0. A headless Chromium then:
//   1. sees "Update available · 999.0.0" with the primary button "Update and restart",
//   2. clicks it, watches the card turn into "Updating…" / "Restarting…", the server go away and come back,
//   3. reconnects on its own and shows the "Updated to 999.0.0" toast, with the binary replaced on disk,
//      the audit log holding update.apply, and a different process serving the page.
// It also checks that Docker and source installs show the right instruction and no Update button.
// Run after `pnpm build` (needs dist/0.js and packages/web/dist). HOME is always a temp folder.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const assets = join(root, 'packages/web/dist');
const requireEngine = createRequire(join(root, 'packages/engine/package.json'));
const { chromium } = (() => {
  try { return requireEngine('playwright'); }
  catch { return requireEngine(join(root, 'node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core')); }
})();
const shots = process.env.UPDATE_E2E_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const wait = ms => new Promise(done => setTimeout(done, ms));
const NEW_VERSION = '999.0.0';
const OLD_VERSION = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const asset = process.platform === 'darwin' && process.arch === 'arm64' ? '0-darwin-arm64'
  : process.platform === 'linux' && process.arch === 'x64' ? '0-linux-x64'
  : process.platform === 'linux' && process.arch === 'arm64' ? '0-linux-arm64' : undefined;
if (!asset) { console.log('self-update e2e: no release asset for this platform; skipped'); process.exit(0); }
if (!existsSync(join(dist, '0.js')) || !existsSync(join(assets, 'index.html'))) throw new Error('Build first: pnpm build (needs dist/0.js and packages/web/dist).');
const bun = spawnSync('which', ['bun'], { encoding: 'utf8' }).stdout.trim();
if (!bun) { console.log('self-update e2e: bun is not installed; skipped'); process.exit(0); }

const base = mkdtempSync(join(tmpdir(), 'zero-self-update-'));
const children = [];
let browser;
const servers = [];
const cleanups = [() => rmSync(base, { recursive: true, force: true })];

async function freePort() {
  return new Promise(done => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
}

// ---- the "new release": the same console, built as 999.0.0 ------------------------------------------------
// dist-bin/ is git-ignored and a sibling of dist/, so the copy resolves node_modules the same way.
const newDist = join(root, 'dist-bin', `update-e2e-${process.pid}`);
cleanups.push(() => rmSync(newDist, { recursive: true, force: true }));
mkdirSync(dirname(newDist), { recursive: true });
cpSync(dist, newDist, { recursive: true });
let replaced = 0;
(function patch(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) patch(path);
    else if (/\.(?:js|json)$/.test(entry.name) && statSync(path).size < 8_000_000) {
      const text = readFileSync(path, 'utf8');
      if (text.includes(`"${OLD_VERSION}"`)) { writeFileSync(path, text.replaceAll(`"${OLD_VERSION}"`, `"${NEW_VERSION}"`)); replaced++; }
    }
  }
})(newDist);
assert.ok(replaced > 0, 'could not stamp the new version into the copied bundle');
// What a release asset would be: a program. Here a script that starts the 999.0.0 console; `shift` drops the
// old bundle path the restart carries over (a compiled 0 has no such argument).
const newProgram = `#!/bin/sh\nshift\nexec "${bun}" "${newDist}/0.js" "$@"\n`;
const checksums = `${createHash('sha256').update(newProgram).digest('hex')}  ${asset}\n`;
const release = createServer((req, res) => {
  const route = req.url ?? '';
  if (route === '/latest') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ tag_name: `v${NEW_VERSION}` })); }
  else if (route === '/install.sh') res.end(readFileSync(join(root, 'install.sh')));
  else if (route === `/releases/download/v${NEW_VERSION}/checksums.txt`) res.end(checksums);
  else if (route === `/releases/download/v${NEW_VERSION}/${asset}`) res.end(newProgram);
  else { res.writeHead(404); res.end('not found'); }
});
await new Promise(done => release.listen(0, '127.0.0.1', done));
cleanups.push(() => release.close());
const origin = `http://127.0.0.1:${release.address().port}`;

// ---- an installed 0 ------------------------------------------------------------------------------------------
function install(name, { binary = true, settings = { updatePolicy: 'notify' } } = {}) {
  const folder = join(base, name);
  const home = join(folder, 'home');
  mkdirSync(join(home, '.0'), { recursive: true });
  writeFileSync(join(home, '.0', 'tui-settings.json'), JSON.stringify({ executionProfile: 'local', analyticsLevel: 'off', diagnosticReporting: 'off', onboardingCompleted: true, ...settings }));
  // A fresh cache so the card shows without waiting for the first background check.
  writeFileSync(join(home, '.0', 'last-update-check'), JSON.stringify({ lastCheckedAt: new Date().toISOString(), latestVersion: `v${NEW_VERSION}` }));
  const bin = join(folder, 'bin');
  mkdirSync(bin, { recursive: true });
  const program = binary ? join(bin, '0') : bun;
  if (binary) { cpSync(bun, program); chmodSync(program, 0o755); }
  return { folder, home, bin, program };
}

function start(installed, env = {}) {
  return new Promise(async (done, fail) => {
    const port = await freePort();
    const child = spawn(installed.program, [join(dist, '0.js'), 'web', '--port', String(port), '--db-path', join(installed.folder, 'data.db'), '--asset-dir', assets, '--no-open'], {
      cwd: installed.folder, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: installed.home, SHELL: '/bin/sh', TMPDIR: installed.folder, ZERO_UPDATE_ORIGIN: origin, INSTALL_FOXGUARD: '0', ZERO_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', ...env },
    });
    children.push(child);
    let output = '';
    servers.push(() => output);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('exit', code => fail(new Error(`0 web exited early (${code}): ${output.slice(-600)}`)));
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok || (await fetch(`http://127.0.0.1:${port}/`)).ok) { child.removeAllListeners('exit'); return done({ child, port, url: `http://127.0.0.1:${port}`, output: () => output }); } } catch { /* not up yet */ }
      await wait(250);
    }
    fail(new Error(`0 web did not start: ${output.slice(-600)}`));
  });
}

const snap = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const card = page => page.locator('section[aria-label="Update available"]');

async function pageFor(server) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  if (process.env.UPDATE_E2E_VERBOSE) { page.on('console', m => console.error('[console]', m.text().slice(0, 200))); page.on('response', r => { if (/update-status|update\/apply|handshake/.test(r.url())) console.error('[http]', r.status(), r.url().replace(/^http:\/\/127.0.0.1:\d+/, '')); }); page.on('requestfailed', r => console.error('[failed]', r.url().replace(/^http:\/\/127.0.0.1:\d+/, ''))); }
  await page.goto(`${server.url}/chats`, { waitUntil: 'domcontentloaded' });
  await card(page).waitFor({ timeout: 30_000 });
  return page;
}

async function controlGet(server, path) {
  const html = await (await fetch(`${server.url}/`)).text();
  const token = /name="0-control-token" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(token, 'control token is embedded for the local browser');
  const response = await fetch(`${server.url}${path}`, { headers: { 'x-0-control-token': token } });
  return response.json();
}

try {
  browser = await chromium.launch({ headless: true });
  cleanups.push(() => browser?.close());

  // ---- 1. a managed binary: Update and restart -------------------------------------------------------------
  const managed = install('managed');
  const first = await start(managed);
  const page = await pageFor(first);
  const text = await card(page).innerText();
  assert.match(text, new RegExp(`Update available · ${NEW_VERSION}`));
  assert.match(text, new RegExp(`You have ${OLD_VERSION.replaceAll('.', '\\.')}`));
  assert.equal(await card(page).getByRole('link', { name: "What's new" }).count(), 1);
  assert.equal(await card(page).getByRole('button', { name: 'Copy update command' }).count(), 0, 'a managed install is not told to copy a command');
  const button = card(page).getByRole('button', { name: 'Update and restart' });
  await button.waitFor();
  await snap(page, '01-managed-update-available');
  const status = await controlGet(first, '/api/console/update-status');
  assert.equal(status.canApply, true);
  assert.deepEqual({ kind: status.install.kind, managed: status.install.managed }, { kind: 'binary', managed: true });
  const oldPid = first.child.pid;
  const before = readFileSync(managed.program);

  await button.click();
  const busy = card(page).getByRole('button', { name: /Updating…|Restarting…/ });
  await busy.waitFor({ timeout: 20_000 });
  await snap(page, '02-updating');
  // The server goes away and a new one answers on the same port; the page finds it again by itself.
  await page.getByText(`Updated to ${NEW_VERSION}`).waitFor({ timeout: 90_000 });
  await snap(page, '03-updated-toast');
  await wait(300);
  assert.equal(await card(page).count(), 0, 'the card is gone once the new version runs');

  const after = readFileSync(managed.program);
  assert.notDeepEqual(after, before, 'the binary in the folder of the running one was replaced');
  assert.equal(after.toString('utf8'), newProgram, 'the replacement is the verified release asset');
  assert.equal(statSync(managed.program).mode & 0o111 ? true : false, true, 'the replacement is executable');
  const current = await controlGet(first, '/api/console/update-status');
  assert.equal(current.current, NEW_VERSION, 'the same URL now serves the new version');
  assert.equal(current.available, false);
  const audit = await controlGet(first, '/api/console/audit-log?limit=50');
  assert.ok(audit.events.some(event => event.action === 'update.apply' && event.outcome === 'ok'), 'update.apply is in the audit log');
  assert.ok(audit.events.every(event => !/token|secret/i.test(JSON.stringify(event.detail))), 'the audit detail carries no credentials');
  await wait(1500);
  assert.equal(first.child.exitCode, 0, 'the old process exited cleanly after handing over');
  assert.notEqual(oldPid, undefined);
  await page.context().close();
  // Stop the restarted server (not a child of ours: find it through the registered engine listing by port).
  spawnSync('pkill', ['-f', `${newDist}/0.js`]);

  // ---- 2. other install kinds: the right instruction, no button that cannot work ---------------------------
  for (const [name, env, command, forbidden] of [
    ['docker', { ZERO_IN_DOCKER: '1' }, 'docker pull ghcr.io/0sec-labs/0security:latest', 'Update and restart'],
    ['source', {}, 'git pull', 'Update and restart'],
  ]) {
    const kind = install(name, { binary: false });
    const server = await start(kind, env);
    const view = await pageFor(server);
    const cardText = await card(view).innerText();
    assert.equal(await card(view).getByRole('button', { name: forbidden }).count(), 0, `${name}: no self-update button`);
    await card(view).getByRole('button', { name: 'Copy update command' }).waitFor();
    assert.match(cardText, new RegExp(`Update available · ${NEW_VERSION}`));
    const apply = await fetch(`${server.url}/api/console/update/apply`, { method: 'POST' });
    assert.equal(apply.status === 403 || apply.status === 409, true, `${name}: the server refuses an apply without the control token or for an unmanaged install`);
    const html = await (await fetch(`${server.url}/`)).text();
    const token = /name="0-control-token" content="([^"]+)"/.exec(html)?.[1];
    const refused = await fetch(`${server.url}/api/console/update/apply`, { method: 'POST', headers: { 'x-0-control-token': token, 'content-type': 'application/json' }, body: '{"confirm":true}' });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, 'not_managed');
    await view.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: text => { window.__copied = text; return Promise.resolve(); } }, configurable: true }); });
    await card(view).getByRole('button', { name: 'Copy update command' }).click();
    await view.getByText('Copied').first().waitFor();
    assert.equal(await view.evaluate(() => window.__copied), command, `${name}: copies the right command`);
    await snap(view, `04-${name}`);
    await view.context().close();
    server.child.kill('SIGTERM');
  }
  console.log('self-update e2e: ok');
} catch (error) {
  if (process.env.UPDATE_E2E_VERBOSE) for (const output of servers) console.error('--- server output ---\n' + output().slice(-2500));
  throw error;
} finally {
  for (const child of children) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  spawnSync('pkill', ['-f', `${newDist}/0.js`]);
  for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch { /* best effort */ } }
}
