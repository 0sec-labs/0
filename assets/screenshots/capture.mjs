// Current UI only: historical source-only review in a closed reading view,
// plus an unexecuted workflow template. No model requests or workflow runs.
// Run after pnpm run build: node assets/screenshots/capture.mjs
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { createSecurityWorkflowTemplate } = await import(
  pathToFileURL(join(repo, 'packages/shared/dist/security-workflow-templates.js'))
);
const root = mkdtempSync(join(tmpdir(), '0-current-preview-'));
let browser;
let server;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function stopServer(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, delay(2000)]);
  }
}

try {
  const home = join(root, 'home');
  const workspace = join(root, 'customer-api');
  mkdirSync(home);
  mkdirSync(workspace);
  for (const file of ['README.md', 'server.js']) {
    writeFileSync(
      join(workspace, file),
      readFileSync(join(repo, 'assets/examples/demo-api', file))
    );
  }
  const env = { PATH: process.env.PATH, HOME: home, NO_COLOR: '1', TERM: 'dumb' };
  const db = join(root, 'preview.db');
  const seed = `
    import { saveSession } from ${JSON.stringify(join(repo, 'packages/cli/dist/tui/session-store.js'))};
    import { readFileSync } from 'node:fs';
    const review = readFileSync(${JSON.stringify(join(repo, 'assets/examples/demo-api/review.md'))}, 'utf8');
    if (!review.includes('### 1.')) throw Error('Expected retained report body');
    const saved = saveSession({
      id: 'historical-demo-review', savedAt: Date.now(),
      cwd: ${JSON.stringify(workspace)}, target: ${JSON.stringify(workspace)},
      model: 'gpt-5.6-sol', mode: 'standard', messageCount: 1,
      preview: 'Customer API security review', summary: 'Customer API security review',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: review.slice(review.indexOf('### 1.')) }] }]
    });
    if (!saved) process.exit(1);
  `;
  const seeded = spawnSync('node', ['--input-type=module', '-e', seed], {
    env, cwd: workspace, encoding: 'utf8', timeout: 10_000,
  });
  if (seeded.error || seeded.status !== 0) throw Error('Transcript seed failed');

  let output = '';
  let spawnError;
  server = spawn('node', [
    join(repo, 'dist/0.js'), 'web', '--port', '0', '--no-open',
    '--ready-json', '--db-path', db,
  ], { cwd: root, env });
  server.on('error', error => { spawnError = error; });
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  for (let attempt = 0; attempt < 100 && !output.includes('ZERO_DASHBOARD_READY '); attempt++) {
    if (spawnError) throw Error('Unable to spawn capture server', { cause: spawnError });
    if (server.exitCode !== null || server.signalCode !== null) break;
    await delay(100);
  }
  if (spawnError) throw Error('Unable to spawn capture server', { cause: spawnError });
  const line = output.split('\n').find(line => line.includes('ZERO_DASHBOARD_READY '));
  if (!line) throw Error('Server not ready: ' + output);
  const url = JSON.parse(line.split('ZERO_DASHBOARD_READY ')[1]).url;
  const origin = url.replace(/\/$/, '');
  const html = await (await fetch(url, { signal: AbortSignal.timeout(10_000) })).text();
  const token = html.match(/name="0-control-token" content="([^"]+)"/)?.[1];
  if (!token) throw Error('No bootstrap');

  async function api(path, body) {
    const response = await fetch(origin + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-0-Control-Token': token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, value: await response.json() };
  }
  const resumed = await api('/api/console/saved/historical-demo-review/resume', {});
  let session = resumed.value.session?.id;
  if (!session) {
    const list = await api('/api/console/sessions');
    session = list.value.sessions?.[0]?.id;
  }
  if (!session) throw Error('No restored transcript session');
  const template = createSecurityWorkflowTemplate('repository-review', { target: './customer-api' });
  const saved = await api('/api/console/workflow-definitions', template);
  if (saved.status !== 201) throw Error('Workflow save failed');
  const workflow = saved.value.definition.id;

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await fetch(origin + '/api/console/sessions/' + session, {
    method: 'DELETE', headers: { 'X-0-Control-Token': token },
    signal: AbortSignal.timeout(10_000),
  });
  await page.goto(origin + '/console/' + session);
  await page.getByText('Customer API security review', { exact: true }).first().waitFor({ timeout: 15_000 });
  await page.getByText('1. SQL injection', { exact: false }).first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(repo, 'assets/screenshots/web-chat.jpg'), type: 'jpeg', quality: 93 });

  await page.goto(origin + '/workflows?workflow=' + workflow);
  await page.getByText('Repository security review', { exact: false }).first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(repo, 'assets/screenshots/web-workflow.jpg'), type: 'jpeg', quality: 93 });
  console.log(JSON.stringify({
    captured: ['web-chat.jpg', 'web-workflow.jpg'], viewport: '1280x900',
    source: 'retained demo review + unrun template', chatResumeStatus: resumed.status,
  }));
} finally {
  try {
    await browser?.close();
  } finally {
    try { await stopServer(server); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}
