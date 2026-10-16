import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = new Set();
let stopping = false;
function launch(args) {
  const child = spawn('pnpm', args, { cwd: root, stdio: 'inherit', env: process.env });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
function completed(child) {
  const { promise, resolve, reject } = Promise.withResolvers();
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Development process exited ${code}`)));
  return promise;
}
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  await completed(launch(['--filter', '@0/cli...', 'build']));
  const frontend = launch(['--filter', '@0/dashboard', 'dev', '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (stopping) break;
    try { const response = await fetch('http://127.0.0.1:5173/'); if (response.ok) break; } catch {}
    if (attempt === 99) throw new Error('Frontend development server did not become ready.');
    const pause = Promise.withResolvers();
    setTimeout(pause.resolve, 200);
    await pause.promise;
  }
  if (!stopping) {
    const engine = spawn(process.execPath, ['packages/cli/dist/index.js', 'web', '--dev-url', 'http://127.0.0.1:5173', '--port', '48123', '--ready-json'], { cwd: root, stdio: 'inherit', env: process.env });
    children.add(engine);
    engine.once('exit', () => { children.delete(engine); stop(); });
    frontend.once('exit', stop);
    await completed(engine);
  }
} catch (error) {
  console.error(error.message);
  stop();
  process.exitCode = 1;
}
