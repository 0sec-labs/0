import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const host = '127.0.0.1';

function port(value, name) {
  if (!/^\d+$/.test(String(value)) || Number(value) > 65535) throw new Error(`${name} must be an integer from 0 to 65535`);
  return Number(value);
}
export function options(argv = [], env = process.env) {
  const result = { backend: env.ZERO_DEV_PORT, frontend: env.ZERO_DEV_FRONTEND_PORT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') result.backend = argv[++i];
    else if (argv[i] === '--frontend-port') result.frontend = argv[++i];
    else throw new Error(`Unknown development option: ${argv[i]}`);
    if (argv[i] === undefined) throw new Error('A port value is required');
  }
  return {
    backend: result.backend === undefined ? undefined : port(result.backend, 'Backend port'),
    frontend: result.frontend === undefined ? undefined : port(result.frontend, 'Frontend port'),
  };
}
function available(requested) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host, port: requested }, () => {
      const selected = server.address().port;
      server.close(error => error ? reject(error) : resolvePort(selected));
    });
  });
}
/** Explicit ports are strict. Defaults prefer familiar ports without claiming another server. */
export async function selectPort(requested, preferred) {
  if (requested !== undefined) return available(requested);
  try { return await available(preferred); }
  catch (error) { if (error.code !== 'EADDRINUSE') throw error; return available(0); }
}

export function supervise({ cwd = root, env = process.env, graceMs = 5000 } = {}) {
  const children = new Set();
  let stopping;
  let failure;
  let stoppedResolve;
  const stopped = new Promise(resolveStopped => { stoppedResolve = resolveStopped; });
  let fail;
  const failed = new Promise((_, reject) => { fail = reject; });
  // A process can exit between stages. Keep its failure observed until the next race.
  failed.catch(() => {});
  function launch(command, args, label, persistent = false, onOutput) {
    if (stopping || failure) throw failure ?? new Error('Development runner is stopping');
    const child = spawn(command, args, { cwd, env, stdio: onOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit', detached: process.platform !== 'win32' });
    if (onOutput) {
      child.stdout.on('data', data => { process.stdout.write(data); onOutput(data.toString()); });
      child.stderr.on('data', data => { process.stderr.write(data); onOutput(data.toString()); });
    }
    let close;
    const closed = new Promise(resolveClose => { close = resolveClose; });
    const entry = { child, closed };
    children.add(entry);
    function fatal(error) { if (!failure && !stopping) { failure = error; fail(error); } }
    child.once('error', error => fatal(new Error(`${label}: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (!persistent || stopping) children.delete(entry);
      close({ code, signal });
      if (!stopping && (persistent || code !== 0)) fatal(new Error(`${label} exited (${signal ?? code})`));
    });
    return entry;
  }
  async function completed(entry) {
    const result = await Promise.race([entry.closed, failed]);
    if (result.code !== 0) throw new Error(`Development process exited (${result.signal ?? result.code})`);
  }
  function signal(entry, name) {
    try {
      if (process.platform !== 'win32' && entry.child.pid) process.kill(-entry.child.pid, name);
      else entry.child.kill(name);
    } catch (error) { if (error.code !== 'ESRCH') console.error(`Development cleanup: ${error.message}`); }
  }
  function stop() {
    if (stopping) return stopping;
    const owned = [...children];
    stopping = (async () => {
      for (const entry of owned) signal(entry, 'SIGTERM');
      const timer = setTimeout(() => { for (const entry of owned) signal(entry, 'SIGKILL'); }, graceMs);
      try {
        await Promise.all(owned.map(async entry => {
          await entry.closed;
          if (process.platform === 'win32' || !entry.child.pid) return;
          const deadline = Date.now() + graceMs + 2000;
          while (true) {
            try { process.kill(-entry.child.pid, 0); }
            catch (error) { if (error.code === 'ESRCH') return; throw error; }
            if (Date.now() >= deadline) throw new Error(`Development process group ${entry.child.pid} did not drain`);
            await new Promise(resolvePause => setTimeout(resolvePause, 25));
          }
        }));
      } finally { clearTimeout(timer); stoppedResolve(); }
    })();
    return stopping;
  }
  return { launch, completed, stop, failed, stopped, race: task => Promise.race([task, failed]) };
}

export async function run(argv = process.argv.slice(2)) {
  const config = options(argv);
  const backendPort = await selectPort(config.backend, 48123);
  let frontendPort = await selectPort(config.frontend, 5173);
  if (frontendPort === backendPort) {
    if (config.frontend !== undefined && config.frontend !== 0) throw new Error('Backend and frontend ports must differ');
    frontendPort = await selectPort(0, 5173);
  }
  const backendUrl = `http://${host}:${backendPort}`;
  const frontendUrl = `http://${host}:${frontendPort}`;
  const env = { ...process.env, ZERO_DEV_FRONTEND_PORT: String(frontendPort),
    ZERO_ALLOWED_LOCAL_ORIGINS: process.env.ZERO_ALLOWED_LOCAL_ORIGINS ?? backendUrl };
  const processes = supervise({ env });
  let interrupted = false;
  const onSignal = () => { interrupted = true; void processes.stop().catch(error => { console.error(error.message); process.exitCode = 1; }); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const launch = (args, label, persistent = false) => processes.launch('pnpm', args, label, persistent);
  try {
    console.log(`Development checkout: ${root}\nBackend: ${backendUrl}\nFrontend: ${frontendUrl}`);
    await processes.completed(launch(['--filter', '@0/cli...', 'build'], 'Backend build'));
    if (interrupted) return;
    launch(['--filter', '@0/engine', '--filter', '@0/cli', '--parallel', 'dev', '--preserveWatchOutput'], 'Backend compilers', true);
    launch(['--filter', '@0/web', 'dev', '--host', host, '--port', String(frontendPort), '--strictPort'], 'Frontend', true);
    await processes.race((async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (interrupted) return;
        try { const response = await fetch(frontendUrl, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch {}
        await new Promise(resolvePause => setTimeout(resolvePause, 200));
      }
      throw new Error('Frontend development server did not become ready.');
    })());
    if (interrupted) return;
    let readyResolve;
    const ready = new Promise(resolveReady => { readyResolve = resolveReady; });
    let output = '';
    processes.launch(process.execPath, ['--watch', '--watch-preserve-output', 'packages/cli/dist/index.js', 'web', '--host', host, '--no-open', '--dev-url', frontendUrl, '--asset-dir', 'packages/web', '--port', String(backendPort), '--ready-json'], 'Backend watcher', true, data => {
      output = (output + data).slice(-65536);
      if (output.includes(`ZERO_DASHBOARD_READY {"url":"${backendUrl}"}`)) readyResolve();
    });
    let timeout;
    try {
      await processes.race(Promise.race([ready, processes.stopped, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Backend development server did not become ready.')), 30000); })]));
    } finally { clearTimeout(timeout); }
    if (interrupted) return;
    console.log(`ZERO_DEV_READY ${JSON.stringify({ checkout: root, backendUrl, frontendUrl })}`);
    await Promise.race([processes.failed, processes.stopped]);
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    await processes.stop();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
