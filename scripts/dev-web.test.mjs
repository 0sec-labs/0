import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { options, selectPort, supervise } from './dev-web.mjs';

test('ports accept flags/environment and reject malformed or ambiguous options', () => {
  assert.deepEqual(options(['--port', '48141', '--frontend-port', '5175'], {}), { backend: 48141, frontend: 5175 });
  assert.deepEqual(options([], { ZERO_DEV_PORT: '0', ZERO_DEV_FRONTEND_PORT: '5176' }), { backend: 0, frontend: 5176 });
  for (const args of [['--port'], ['--port', 'oops'], ['--port', '-1'], ['--port', '65536'], ['--unknown']]) assert.throws(() => options(args, {}));
});
test('a busy default selects another port while explicit ports never attach to it', async () => {
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const busy = occupied.address().port;
    assert.notEqual(await selectPort(undefined, busy), busy);
    await assert.rejects(selectPort(busy, busy), { code: 'EADDRINUSE' });
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});
test('persistent process failure is observed even before the runner awaits it', async () => {
  const runner = supervise({ graceMs: 100 });
  const entry = runner.launch(process.execPath, ['-e', 'process.exit(7)'], 'Fixture compiler', true);
  await entry.closed;
  await assert.rejects(runner.failed, /Fixture compiler exited \(7\)/);
  await runner.stop();
});
test('cleanup drains only owned wrapper/descendant groups, escalating ignored termination', { skip: process.platform === 'win32' }, async () => {
  const temp = await mkdtemp(join(tmpdir(), '0-dev-process-test-'));
  const receipt = join(temp, 'pid');
  const runner = supervise({ graceMs: 100 });
  const childCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(receipt)},String(process.pid));setInterval(()=>{},1000)`;
  const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const owned = runner.launch(process.execPath, ['-e', parentCode], 'Fixture watcher', true);
  try {
    let descendant;
    for (let i = 0; i < 100; i++) { try { descendant = Number(await readFile(receipt, 'utf8')); break; } catch {} await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.ok(descendant);
    await runner.stop();
    assert.throws(() => process.kill(-owned.child.pid, 0), { code: 'ESRCH' });
  } finally { await runner.stop(); await rm(temp, { recursive: true, force: true }); }
});
