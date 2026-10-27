#!/usr/bin/env node
/**
 * Review-first update for an existing managed worker. The default performs only
 * reads. --apply requires the exact local dist/0.js digest printed by preflight.
 * Never calls deployWorker: work/, home state, credentials and dependencies stay.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeStateDir } from '../packages/shared/dist/index.js';
import { loadManagedWorker, createRunner, repairWorker } from '../packages/cli/dist/worker-deploy.js';
import { BackendConnectionRegistry, createBackendHandshake } from '../packages/cli/dist/web/backend-connections.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const backendId = args.find(value => !value.startsWith('--'));
const apply = args.includes('--apply');
const expected = args.find(value => value.startsWith('--expect-cli-sha256='))?.slice('--expect-cli-sha256='.length);
if (!backendId || args.some(value => value.startsWith('--') && value !== '--apply' && !value.startsWith('--expect-cli-sha256='))) {
  throw new Error('Usage: node scripts/managed-worker-in-place-update.mjs BACKEND_ID [--apply --expect-cli-sha256=HEX]');
}
if (apply && !/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('--apply requires --expect-cli-sha256 from the reviewed preflight.');
const worker = loadManagedWorker(backendId);
const runner = createRunner(worker);
const remote = worker.remoteDir; // loadManagedWorker validates the exact owned directory.
const cliHash = createHash('sha256').update(readFileSync(join(repo, 'dist/0.js'))).digest('hex');
if (expected && expected !== cliHash) throw new Error('The production bundle changed since review. Run preflight again.');
const registry = new BackendConnectionRegistry({ localHandshake: createBackendHandshake(':memory:'), timeoutMs: 10000 });
const quoted = value => `'${value.replaceAll("'", "'\\''")}'`;
const digest = value => createHash('sha256').update(value).digest('hex');
const status = value => process.stdout.write(`${JSON.stringify(value)}\n`);

async function json(path) {
  const response = await registry.request(backendId, path);
  if (!response.ok) throw new Error(`Read-only preflight failed (HTTP ${response.status}).`);
  return response.json();
}
async function idle() {
  const sessions = (await json('/api/console/sessions')).sessions;
  const saved = (await json('/api/console/saved')).sessions;
  const triggers = (await json('/api/console/workflow-triggers')).triggers;
  if (![sessions, saved, triggers].every(Array.isArray)) throw new Error('Unexpected preflight API response.');
  if (triggers.some(item => item.enabled)) throw new Error('An enabled schedule can start work during cutover. Update requires a maintenance window.');
  const savedIds = new Set(saved.map(item => item.id));
  for (const session of sessions) {
    if (!['ready', 'closed', 'failed'].includes(session.status)) throw new Error('A conversation is active. No engine was stopped.');
    const snapshot = (await json(`/api/console/sessions/${encodeURIComponent(session.id)}`)).snapshot;
    if (!snapshot || !Array.isArray(snapshot.workers) || !Array.isArray(snapshot.queuedMessages) || !Array.isArray(snapshot.pendingDecisions)) throw new Error('A session snapshot could not be verified.');
    if (snapshot.workers.some(item => ['queued', 'running', 'parked'].includes(item.status)) || snapshot.queuedMessages.length || snapshot.pendingDecisions.length) throw new Error('Queued work, live workers, or a pending decision prevents update.');
    if (session.messageCount > 0 && !savedIds.has(session.savedId ?? session.id)) throw new Error('A live conversation has no matching saved transcript.');
  }
  return { sessions: sessions.length, savedIds: [...savedIds].sort() };
}
function ownership(expectedPid) {
  return `set -eu
cd ${remote}
test ! -L dist && test -f dist/0.js && test -d work && test -d node_modules
pid=$(cat engine.pid)
case "$pid" in ''|*[!0-9]*) echo INVALID_ENGINE_PID >&2; exit 1;; esac
test "$pid" -gt 1
${expectedPid ? `test "$pid" = ${expectedPid} || { echo ENGINE_PID_CHANGED >&2; exit 1; }` : ''}
kill -0 "$pid"
test "$(readlink /proc/$pid/cwd)" = ${remote}
command=$(tr '\\000' ' ' < /proc/$pid/cmdline)
case "$command" in 'node dist/0.js dashboard '*|'node /tmp/zero-engine/dist/0.js dashboard '*) :;; *) echo ENGINE_OWNERSHIP_MISMATCH >&2; exit 1;; esac
`;
}
function stopOwned(expectedPid) {
  return `${ownership(expectedPid)}
kill "$pid"
for attempt in $(seq 1 100); do
 if ! kill -0 "$pid" 2>/dev/null; then rm -f engine.pid; break; fi
 sleep 0.1
done
if kill -0 "$pid" 2>/dev/null; then echo ENGINE_DID_NOT_STOP >&2; exit 1; fi
`;
}
function reconnectPreference(value) {
  const latest = loadManagedWorker(backendId);
  const metadataPath = join(homeStateDir(), 'workers', `${backendId}.json`);
  writeFileSync(metadataPath, `${JSON.stringify({ ...latest, autoReconnect: value }, null, 2)}\n`, { mode: 0o600 });
}
let localStage;
let paused = false;
let swapped = false;
let stage;
try {
  const view = await registry.handshake(backendId);
  if (view.backend.status !== 'connected') throw new Error('The authenticated registered engine is not connected.');
  const before = await idle();
  const observed = runner.shell(`${ownership()}\nprintf 'PID=%s\\n' "$pid"\nprintf 'SHA256='\nsha256sum dist/0.js | cut -d' ' -f1\n`, 30000);
  const pid = /^PID=(\d+)$/m.exec(observed)?.[1];
  const priorHash = /^SHA256=([a-f0-9]{64})$/m.exec(observed)?.[1];
  if (!pid || !priorHash) throw new Error('Cannot verify managed engine identity and existing bundle.');
  status({ backendId, mode: apply ? 'apply' : 'read-only', remoteDir: remote, port: worker.port, sessions: before.sessions, savedChats: before.savedIds.length, activeWork: 0, enabledSchedules: 0, localCliSha256: cliHash, remoteCliSha256: priorHash });
  if (!apply) {
    status({ plan: ['Stage only the new dist/ tree', 'Recheck idle sessions and saved transcripts', 'Pause this host auto-reconnect', 'Stop the exact verified engine PID', 'Rename prior dist/ into a retained backup and install staged dist/', 'Restart via repairWorker with existing credentials', 'Verify registered engine identity, bundle digest and saved transcript IDs'], preserved: ['work/', 'node_modules/', 'vendor/', 'package.json', 'engine identity', 'home state', 'credentials', 'saved transcripts'], caveat: 'No maintenance admission lock exists; do not send new work during cutover. One-off process-only launch environment is not replayed by repairWorker.' });
  } else {
    stage = `${remote}/.in-place-update-${randomUUID()}`;
    localStage = mkdtempSync(join(tmpdir(), 'zero-worker-update-'));
    const archive = join(localStage, 'bundle.tar.gz');
    execFileSync('tar', ['--no-xattrs', '-czf', archive, '-C', repo, 'dist'], { stdio: 'ignore', env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const archiveHash = digest(readFileSync(archive));
    runner.shell(`set -eu\numask 077\nmkdir ${quoted(stage)}\n`, 30000);
    runner.copy(archive, `${stage}/bundle.tar.gz`);
    runner.shell(`set -eu
cd ${quoted(stage)}
test "$(sha256sum bundle.tar.gz | cut -d' ' -f1)" = ${archiveHash}
tar -xzf bundle.tar.gz
test -f dist/0.js && test ! -L dist
test "$(sha256sum dist/0.js | cut -d' ' -f1)" = ${cliHash}
node --check dist/0.js >/dev/null
`, 60000);
    reconnectPreference(false); paused = true;
    await idle();
    // Recheck the same PID and old bundle immediately before the owned stop.
    runner.shell(`${ownership(pid)}
test "$(sha256sum dist/0.js | cut -d' ' -f1)" = ${priorHash}
${stopOwned(pid)}
trap 'if test ! -e dist && test -d ${stage}/previous-dist; then mv ${stage}/previous-dist dist; fi' EXIT
mv dist ${quoted(stage)}/previous-dist
mv ${quoted(stage)}/dist dist
trap - EXIT
`, 30000);
    swapped = true;
    await repairWorker(backendId, runner);
    // Root HTTP readiness can precede authenticated API readiness during startup.
    // Retry transport startup briefly, but never accept a changed engine identity.
    let checked;
    for (let attempt = 0; attempt < 10; attempt++) {
      checked = await registry.handshake(backendId);
      if (checked.backend.status === 'connected') break;
      if (checked.backend.status === 'incompatible') throw new Error('Updated engine identity check failed.');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (checked?.backend.status !== 'connected') throw new Error('Updated engine identity check failed.');
    const installedHash = runner.shell(`set -eu\ncd ${remote}\nsha256sum dist/0.js | cut -d' ' -f1\n`, 30000).trim();
    if (installedHash !== cliHash) throw new Error('Installed bundle digest mismatch.');
    const saved = (await json('/api/console/saved')).sessions;
    if (!Array.isArray(saved) || before.savedIds.some(id => !saved.some(item => item.id === id))) throw new Error('Saved transcript verification failed.');
    status({ updated: true, backendId, localCliSha256: cliHash, retainedBackup: `${stage}/previous-dist`, savedChatsPreserved: before.savedIds.length });
  }
} catch (error) {
  // Leave remote artifacts intact for review; never delete work or credentials.
  status({ updated: false, swapped, retainedStage: stage, message: error instanceof Error ? error.message : 'Update failed.' });
  process.exitCode = 1;
} finally {
  registry.dispose();
  if (paused) reconnectPreference(worker.autoReconnect);
  if (localStage && existsSync(localStage)) rmSync(localStage, { recursive: true, force: true });
}
