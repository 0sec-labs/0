// Isolated browser E2E: real dashboard/Chromium, deterministic engine API fixtures.
// No model credentials, production data, or external execution services are used.
// Run: node scripts/unified-workspace-browser.e2e.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const dashboardRoot = fileURLToPath(new URL('../packages/dashboard/', import.meta.url));
const require = createRequire(new URL('../packages/dashboard/package.json', import.meta.url));
const { build, preview } = await import(pathToFileURL(require.resolve('vite')).href);
await build({ root: dashboardRoot, logLevel: 'error' });
const server = await preview({ root: dashboardRoot, preview: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
let browser;
const capabilities = ['sessions', 'workflows', 'workflow-engine', 'artifacts', 'events'];
const descriptor = id => ({ id, name: id === 'local' ? 'This computer' : 'Staging fixture', transport: id === 'local' ? 'local' : 'http', status: 'connected', protocolVersion: 1, capabilities, platform: { os: 'linux', pathStyle: 'posix' } });
const summary = { totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 };
const scan = id => ({ id, target: '/fixture/payments', depth: 'quick', runtime: 'fixture', mode: 'source', status: 'completed', startedAt: '2026-11-13T10:00:00Z', completedAt: '2026-11-13T10:00:01Z', durationMs: 1000, summary });
const workflow = { status: 'todo', persistedStatus: 'todo', recommendedStatus: 'todo', phase: 'todo', reviewGate: 'none', reviewReason: null, assignee: null, updatedAt: null, consensus: 'pending', activeAgentRoles: [], evidenceSignal: 'strong', verdictCounts: { truePositive: 0, falsePositive: 0, unsure: 0, total: 0 } };
const group = { fingerprint: 'fixture-authorization', latest: { id: 'finding-1', scanId: 'child-scan', title: 'Cross-tenant invoice access', description: 'Synthetic finding for navigation testing.', severity: 'high', category: 'authorization', status: 'discovered', triageStatus: 'new', timestamp: Date.parse('2026-11-13T10:00:00Z'), evidenceRequest: 'fixture request', evidenceResponse: 'fixture response' }, count: 1, scanCount: 1, sourceScanIds: ['child-scan'], workflow };
const runs = id => [
  { id: 'workflow:review-1', kind: 'workflow', title: id === 'local' ? 'Payments security review' : 'Staging security review', target: '/fixture/payments', status: 'completed', createdAt: '2026-11-13T10:00:00Z', updatedAt: '2026-11-13T10:00:01Z', conversation: { sessionId: 'chat-1' }, native: { workflowExecutionId: 'review-1', workflowId: 'definition-1', scanIds: ['child-scan'] } },
  { id: 'scan:standalone-1', kind: 'scan', title: 'Standalone API assessment', target: '/fixture/api', status: 'failed', createdAt: '2026-11-13T09:00:00Z', updatedAt: '2026-11-13T09:00:01Z', conversation: null, native: { scanIds: ['standalone-1'] } },
  { id: 'workflow:no-report', kind: 'workflow', title: 'Evidence-only investigation', target: '/fixture/payments', status: 'completed', createdAt: '2026-11-13T08:00:00Z', updatedAt: '2026-11-13T08:00:01Z', conversation: { sessionId: 'chat-2' }, native: { workflowExecutionId: 'no-report', scanIds: [] } },
];
const requests = [];
const pageErrors = [];
let failRuns = false;
try {
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    let path = new URL(request.url()).pathname;
    const proxy = /^\/api\/backends\/([^/]+)\/proxy(\/api\/.*)$/.exec(path);
    const owner = proxy ? proxy[1] : 'local';
    if (proxy) path = proxy[2];
    const body = request.postDataJSON();
    requests.push({ path, owner, body, method: request.method() });
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/team/session') return json({ enabled: false, sso: false });
    if (path === '/api/backends') return json({ backends: [descriptor('local'), descriptor('staging')] });
    const handshake = /^\/api\/backends\/([^/]+)\/handshake$/.exec(path);
    if (handshake) return json({ backend: descriptor(handshake[1]), handshake: { protocolVersion: 1, engineId: `engine-${handshake[1]}`, serverInstanceId: 'fixture-epoch', capabilities, platform: { os: 'linux', pathStyle: 'posix' } } });
    if (path === '/api/dashboard') return json({ cases: [], scans: [scan('child-scan'), scan('standalone-1')], groups: [group], workers: [], queue: { runnable: 0, active: 0, blockedByDependency: 0, manualReview: 0, staleWorkers: 0, recoveredClaims: 0 } });
    if (path === '/api/scans') return json({ scans: [scan('child-scan'), scan('standalone-1')] });
    if (path === '/api/work') {
      assert.equal(request.method(), 'GET');
      return failRuns ? json({ error: 'Fixture engine is unavailable' }, 503) : json(runs(owner));
    }
    if (path === '/api/console/sessions' || path === '/api/console/saved') return json({ sessions: [] });
    const report = /^\/api\/scans\/([^/]+)\/(events|findings)$/.exec(path);
    if (report) {
      const record = scan(report[1]);
      if (report[1] === 'standalone-1') record.status = 'failed';
      if (report[2] === 'findings') return json({ scan: record, findings: report[1] === 'child-scan' ? [group.latest] : [], groups: report[1] === 'child-scan' ? [group] : [] });
      return json({ scan: record, events: report[1] === 'standalone-1' ? [{ id: 'error-1', scanId: report[1], stage: 'assessment', eventType: 'scan_error', timestamp: Date.parse('2026-11-13T09:00:01Z'), payload: { error: 'Fixture scanner could not complete' } }] : [] });
    }
    return json({ error: `Unconfigured fixture route: ${path}` }, 404);
  });

  await page.goto(`${origin}/runs`);
  await page.getByRole('link', { name: /Payments security review/ }).waitFor();
  assert.equal(await page.getByRole('link', { name: /Standalone API assessment/ }).count(), 1);
  assert.equal(await page.getByRole('link', { name: 'Runs', exact: true }).count(), 1);
  await page.getByRole('link', { name: 'Cross-tenant invoice access', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open chat', exact: true }).getAttribute('href'), '/console/chat-1');
  assert.equal(await page.getByRole('link', { name: 'Open automation', exact: true }).getAttribute('href'), '/automations?workflow=definition-1');
  assert.equal(await page.getByRole('link', { name: 'Cross-tenant invoice access', exact: true }).getAttribute('href'), '/findings/fixture-authorization');

  await page.getByRole('link', { name: /Standalone API assessment/ }).click();
  await page.getByText('Fixture scanner could not complete', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open chat', exact: true }).count(), 0);
  await page.getByPlaceholder('Search runs').fill('evidence-only');
  await page.getByRole('link', { name: /Evidence-only investigation/ }).click();
  await page.getByText('No scan reports', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open chat', exact: true }).getAttribute('href'), '/console/chat-2');

  // Compatibility routes canonicalize without losing query, hash or resource IDs.
  await page.goto(`${origin}/audits?workflow=definition-1#steps`);
  await page.waitForURL(url => url.pathname === '/automations');
  assert.equal(new URL(page.url()).search, '?workflow=definition-1');
  assert.equal(new URL(page.url()).hash, '#steps');

  // A legacy scan route and child ID resolve the canonical parent workflow.
  await page.goto(`${origin}/scans/child-scan?report=retained#evidence`);
  await page.waitForURL(url => url.pathname === '/runs/child-scan');
  assert.equal(new URL(page.url()).search, '?report=retained');
  assert.equal(new URL(page.url()).hash, '#evidence');
  await page.getByRole('link', { name: 'Open chat', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open chat', exact: true }).getAttribute('href'), '/console/chat-1');

  // Touch navigation exposes the same Runs destination as the desktop rail.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  const mobileRuns = page.getByRole('navigation', { name: 'Command Center pages', exact: true }).getByRole('link', { name: 'Runs', exact: true });
  await mobileRuns.waitFor({ state: 'visible' });
  assert.equal(await mobileRuns.getAttribute('href'), '/runs');
  await mobileRuns.click();
  await page.waitForURL(url => url.pathname === '/runs');
  await page.getByRole('link', { name: /Payments security review/ }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1100 });

  // Identical resource IDs on another engine retain their namespace in links.
  await page.goto(`${origin}/b/staging/runs/workflow%3Areview-1`);
  await page.getByRole('link', { name: /Staging security review/ }).waitFor();
  await page.getByRole('link', { name: 'Cross-tenant invoice access', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open chat', exact: true }).getAttribute('href'), '/b/staging/console/chat-1');
  assert.equal(await page.getByRole('link', { name: 'Cross-tenant invoice access', exact: true }).getAttribute('href'), '/b/staging/findings/fixture-authorization');
  assert.ok(requests.some(request => request.owner === 'staging' && request.path === '/api/work'));

  failRuns = true;
  await page.goto(`${origin}/runs`);
  await page.getByText('Fixture engine is unavailable', { exact: true }).waitFor({ timeout: 20000 });
  assert.deepEqual(pageErrors, [], 'Dashboard must not emit uncaught browser errors.');
  console.log('PASS unified workspace browser E2E (fixture engine): workflow + scan history, evidence/finding links, conversations, search, canonical redirects, mobile navigation, remote ownership, and API failure state.');
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
