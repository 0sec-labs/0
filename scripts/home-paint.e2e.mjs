// Home paints its composer at once and nothing thrashes: with a slow API, cold /chats and a /chats/<unknown id>
// each reach the real composer, never lose it again, show no transcript skeleton on Home, navigate at most
// three times and stop mutating the DOM. A mission whose snapshot never arrives ends in an inline error with
// Retry, not an endless skeleton. Disposable engine, isolated HOME, no provider credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(root, 'packages/engine/package.json'))('playwright');
const base = await mkdtemp(join(tmpdir(), 'zero-home-paint-'));
const home = join(base, 'home'), workspace = join(base, 'ws');
await mkdir(home, { recursive: true }); await mkdir(workspace, { recursive: true });
const wait = ms => new Promise(done => setTimeout(done, ms));
const env = { PATH: process.env.PATH, HOME: home, NO_COLOR: '1', ZERO_SKIP_UPDATE_CHECK: '1', ZERO_NO_DEPRECATION_WARNINGS: '1', ZERO_E2E_ENGINE_TOKEN: randomBytes(32).toString('hex') };
let child, browser;
try {
  child = spawn(process.execPath, [join(root, 'packages/cli/dist/index.js'), '--host', '127.0.0.1', '--port', '0', '--no-open', '--ready-json',
    '--db-path', join(base, 'engine.db'), '--asset-dir', join(root, 'packages/web/dist'), '--engine-token-env', 'ZERO_E2E_ENGINE_TOKEN', '--engine-workspace', workspace],
  { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-32000); });
  child.stderr.on('data', data => { output = (output + data).slice(-32000); });
  let origin;
  for (let i = 0; i < 600 && !origin; i++) { const ready = /ZERO_DASHBOARD_READY (\{[^\n]+\})/.exec(output); if (ready) origin = JSON.parse(ready[1]).url; else await wait(50); }
  assert.ok(origin, `engine did not become ready: ${output}`);
  const token = /<meta name="0-control-token" content="([^"]+)"/.exec(await (await fetch(origin)).text())?.[1];
  assert.ok(token, 'control token missing');
  browser = await chromium.launch({ headless: true });

  async function watch(target, { delay = 0, seconds = 4, setup } = {}) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript(() => {
      window.__nav = [];
      for (const key of ['pushState', 'replaceState']) { const original = history[key]; history[key] = function (...args) { window.__nav.push(`${key}:${args[2]}`); return original.apply(this, args); }; }
      window.__mutations = 0;
      document.addEventListener('DOMContentLoaded', () => new MutationObserver(list => { window.__mutations += list.length; }).observe(document.body, { subtree: true, childList: true, attributes: true }));
    });
    const page = await context.newPage();
    if (delay) await page.route('**/api/console/**', async route => { await wait(delay); route.continue().catch(() => {}); });
    // Track the API in flight: a skeleton is honest only while the host has not answered (it fades in after 250 ms by design).
    let inflight = 0, lastSettled = Date.now();
    const settle = request => { if (request.url().includes('/api/console/')) { inflight = Math.max(0, inflight - 1); lastSettled = Date.now(); } };
    page.on('request', request => { if (request.url().includes('/api/console/')) inflight++; });
    page.on('requestfinished', settle); page.on('requestfailed', settle);
    if (setup) await setup(page);
    await page.goto(new URL(target, origin).href, { waitUntil: 'commit' });
    const frames = [];
    for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
      const frame = await page.evaluate(() => {
        const panel = document.querySelector('[data-conversation-skeleton][data-slot="skeleton-panel"], [data-conversation-skeleton] [data-slot="skeleton-panel"]');
        return { t: performance.now(), path: location.pathname, composer: !!document.querySelector('textarea[aria-autocomplete="list"]'), skeleton: !!panel && Number(getComputedStyle(panel).opacity) > 0.05, error: !!document.querySelector('[data-chat-load-error]'), mutations: window.__mutations };
      }).catch(() => null);
      if (frame) frames.push({ ...frame, inflight, idleMs: Date.now() - lastSettled });
      await wait(50);
    }
    const nav = await page.evaluate(() => window.__nav);
    await context.close();
    return { frames, nav };
  }
  const describe = frames => frames.map(f => `${Math.round(f.t)}ms ${f.path.replace(/[0-9a-f-]{36}/, '<id>')} composer=${+f.composer} skeleton=${+f.skeleton} error=${+f.error}`).join('\n');
  function assertSteady(name, { frames, nav }, { skeletonAllowed }) {
    const first = frames.findIndex(f => f.composer);
    assert.ok(first >= 0, `${name}: the composer never appeared\n${describe(frames)}`);
    const lost = frames.slice(first).filter(f => !f.composer);
    assert.equal(lost.length, 0, `${name}: the composer disappeared after it first painted (flicker)\n${describe(frames)}`);
    // Home never shows a transcript skeleton. An unknown id may show one only while the host is still answering (a slow
    // runner can take longer than the 250 ms delay); once every request is back it must be gone within a render or two.
    const shown = frames.filter(f => f.skeleton);
    assert.equal(shown.filter(f => f.t < 250).length, 0, `${name}: a skeleton showed inside the first 250 ms\n${describe(frames)}`);
    const stale = shown.filter(f => !skeletonAllowed ? true : f.inflight === 0 && f.idleMs > 500);
    assert.equal(stale.length, 0, `${name}: Home showed a transcript skeleton${skeletonAllowed ? ' after the host had answered' : ''}\n${describe(frames)}`);
    const end = frames.at(-1);
    assert.ok(end.composer && !end.skeleton && !end.error, `${name}: did not settle on Home: ${end.path}\n${describe(frames)}`);
    assert.ok(nav.length <= 3, `${name}: route thrash: ${nav.join(', ')}`);
    const last = frames.at(-1), settled = frames.find(f => f.t >= last.t - 1000);
    assert.ok(last.mutations - settled.mutations <= 40, `${name}: the DOM kept mutating after settling (${last.mutations - settled.mutations} in 1s)`);
  }

  for (const delay of [0, 700]) {
    assertSteady(`cold /chats (api +${delay}ms)`, await watch('/chats', { delay }), { skeletonAllowed: false });
    assertSteady(`unknown mission id (api +${delay}ms)`, await watch('/chats/3948769d-129d-4ae0-b4da-d487c358f2d9', { delay }), { skeletonAllowed: true });
  }

  // A mission whose snapshot never arrives must end in an error with Retry, with the composer's slot kept.
  const created = await (await fetch(new URL('/api/console/sessions', origin), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-0-Control-Token': token }, body: JSON.stringify({ title: 'Existing', role: 'audit' }) })).json();
  const id = created.session?.id ?? created.id;
  assert.ok(id, 'could not create a mission');
  const hung = await watch(`/chats/${id}`, { seconds: 16, setup: page => page.route(/\/api\/console\/sessions\/[^/?]+(\?|\/events)/, () => {}) });
  assert.ok(hung.frames.some(f => f.error), `a hung snapshot never produced the inline error\n${describe(hung.frames.filter((_, i) => i % 20 === 0))}`);
  assert.equal(hung.frames.at(-1).skeleton, false, 'the skeleton stayed on screen after the load timed out');
  console.log('Home paints at once, does not thrash, and a stuck mission ends in Retry.');
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { child.kill('SIGINT'); await Promise.race([new Promise(done => child.once('exit', done)), wait(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  await rm(base, { recursive: true, force: true });
}
