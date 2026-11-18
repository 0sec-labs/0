// Sidebar layout: the list header is a fixed layout (toggle, search, "+" and "..." sit at the same x in Agents and Threads mode, nothing shifts
// on a click), and a thread row's second line keeps the folder tile at the left and the computer group fully visible at the right, even with long
// folder names and titles; a waiting thread shows the accent line with the folder tile. API lists are mocked; the engine only serves the dashboard.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(root, 'packages/engine/package.json'))('playwright');
const base = await mkdtemp(join(tmpdir(), 'zero-sidebar-layout-'));
const home = join(base, 'home'), workspace = join(base, 'ws');
await mkdir(home, { recursive: true }); await mkdir(workspace, { recursive: true });
const wait = ms => new Promise(done => setTimeout(done, ms));
const env = { PATH: process.env.PATH, HOME: home, NO_COLOR: '1', ZERO_SKIP_UPDATE_CHECK: '1', ZERO_NO_DEPRECATION_WARNINGS: '1', ZERO_E2E_ENGINE_TOKEN: randomBytes(32).toString('hex') };
const agent = (id, name, patch = {}) => ({ id, name, mission: `Watch ${name}`, avatar: { color: '#7c5cff', initials: name.slice(0, 2).toUpperCase() }, role: 'security', skills: [], scope: { repos: [], targets: [], domains: [], outOfScope: [], production: false }, budget: { dailyUsd: 10, maxRunsPerDay: 20 }, notifications: { channels: ['in-app'], on: [], quiet: false }, memory: { enabled: true }, status: 'active', automationIds: [], homeMissionId: null, owner: 'me', version: 1, createdAt: '2026-11-10T00:00:00Z', updatedAt: new Date().toISOString(), ...patch });
const session = (id, title, workspacePath, status = 'ready') => ({ id, title, titleSource: 'user', target: '', status, messageCount: 4, workspacePath, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const sessions = [
  session('t1', 'A remarkably long thread title that cannot possibly fit in the sidebar width', '/work/an-extremely-long-folder-name-for-a-project'),
  session('t2', 'Short', '/work/app'),
  session('t3', 'Needs an answer about the deploy key rotation schedule', '/work/0cloud', 'waiting'),
  session('t4', 'No folder', undefined),
];
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
  browser = await chromium.launch({ headless: true });
  for (const agents of [[], [agent('a1', 'Pen Tester'), agent('a2', 'Dependency Watch')]]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.route('**/api/console/sentinels', route => route.request().method() === 'GET' ? route.fulfill({ json: { sentinels: agents } }) : route.continue());
    await page.route('**/api/console/sessions', route => route.fulfill({ json: { sessions } }));
    await page.route('**/api/console/saved', route => route.fulfill({ json: { sessions: [] } }));
    await page.goto(origin, { waitUntil: 'load' });
    const header = async () => page.evaluate(() => {
      const group = document.querySelector('[aria-label="Sidebar list"]');
      const box = element => { const r = element?.getBoundingClientRect(); return r ? { x: Math.round(r.x * 2) / 2, y: Math.round((r.y + r.height / 2) * 2) / 2, w: Math.round(r.width * 2) / 2, h: Math.round(r.height * 2) / 2 } : null; };
      const row = group?.parentElement;
      return { toggle: box(group), buttons: [...row.querySelectorAll('button')].map(b => box(b)), title: box(row.querySelector('h2')), height: box(row).h };
    });
    const toggle = page.locator('[aria-label="Sidebar list"]');
    await toggle.waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Sentinels', exact: true }).click();
    await wait(300);
    const inAgents = await header();
    await page.getByRole('button', { name: 'Threads', exact: true }).click();
    await page.locator('[data-sidebar-row]').first().waitFor({ timeout: 15000 });
    await wait(300);
    const inThreads = await header();
    assert.deepEqual(inThreads, inAgents, `header layout must not change between modes (${agents.length} agents)`);
    // Five equal 28px icon buttons with 4px gaps, vertically centred on the title, and no box around the toggle.
    assert.equal(inThreads.buttons.length, 5, 'agents, threads, search, plus, options');
    for (const [index, button] of inThreads.buttons.entries()) {
      assert.equal(button.w, 28); assert.equal(button.h, 28);
      assert.equal(button.y, inThreads.title.y, 'buttons are centred on the title');
      if (index) assert.equal(button.x - (inThreads.buttons[index - 1].x + 28), 4, 'gap between header buttons is 4px');
    }
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[aria-label="Sidebar list"]')).backgroundColor), 'rgba(0, 0, 0, 0)', 'the toggle has no filled box');
    const rows = await page.evaluate(() => [...document.querySelectorAll('#navigation-chat-history [data-sidebar-row]')].map(row => {
      const r = row.getBoundingClientRect(), line2 = row.querySelector('[data-slot="thread-line2"]')?.getBoundingClientRect();
      const tile = row.querySelector('[data-slot="thread-folder-tile"]')?.getBoundingClientRect();
      const computer = row.querySelector('[data-slot="thread-computer"]');
      const c = computer?.getBoundingClientRect();
      const age = row.querySelector('span.tabular-nums')?.getBoundingClientRect();
      return { title: row.getAttribute('title'), left: r.left, right: r.right, line2Left: line2?.left, tileLeft: tile?.left, computerRight: c?.right, computerClipped: computer ? computer.scrollWidth > computer.clientWidth : null, computerLeft: c?.left, ageRight: age?.right, h: line2 ? undefined : null, accent: !!row.querySelector('.text-primary-ink') };
    }));
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.ok(Math.abs(row.line2Left - row.left - 8) < 1, `line 2 starts at the row's 8px padding edge: ${JSON.stringify(row)}`);
      if (row.tileLeft != null) assert.ok(Math.abs(row.tileLeft - row.line2Left) < 1, `folder tile sits at the left of line 2: ${JSON.stringify(row)}`);
      if (row.computerRight != null) {
        assert.ok(row.computerRight <= row.right - 8 + 0.5, `computer group inside the row padding: ${JSON.stringify(row)}`);
        assert.equal(row.computerClipped, false, `computer group is not clipped: ${JSON.stringify(row)}`);
        if (row.tileLeft != null) assert.ok(row.computerLeft > row.line2Left, 'computer group is right of line 2 start');
        else assert.ok(Math.abs(row.computerLeft - row.line2Left) < 1, `without a folder the computer group is at the left: ${JSON.stringify(row)}`);
      }
    }
    const waiting = rows.find(row => row.title.startsWith('Needs an answer'));
    assert.ok(waiting.accent && waiting.tileLeft != null && waiting.computerRight == null, 'a waiting thread shows the accent line with the folder tile');
    assert.equal(rows.find(row => row.title === 'No folder').tileLeft, undefined, 'no folder, no tile');
    await context.close();
  }
  console.log('sidebar layout ok');
} finally {
  await browser?.close();
  child?.kill();
}
