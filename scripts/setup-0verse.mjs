#!/usr/bin/env node
// Additive installation: never sync away locally installed analysis engines.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.env.ZERO_0VERSE_ROOT || join(root, '0verse'));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: source, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function children(path) { try { return readdirSync(path).map(name => join(path, name)); } catch { return []; } }
const candidates = [process.env.GHIDRA_INSTALL_DIR, process.env.GHIDRA_HOME,
  ...children(join(homedir(), 'tools')), ...children('/opt'), ...children('/Applications'),
  ...children('/opt/homebrew/Caskroom/ghidra').flatMap(children)].filter(Boolean).map(path => resolve(path));
const ghidraInstallDir = candidates.find(path => existsSync(join(path, 'Ghidra', 'application.properties')) && existsSync(join(path, 'support', 'analyzeHeadless')));
if (!ghidraInstallDir) throw new Error('Install an official Ghidra release from https://github.com/NationalSecurityAgency/ghidra/releases and set GHIDRA_INSTALL_DIR, then rerun npm run setup:0verse.');
let javaHome = process.env.JAVA_HOME;
if (!javaHome && process.platform === 'darwin') javaHome = run('/usr/libexec/java_home', ['-v', '21+']);
if (!javaHome && process.env.JDK_HOME) javaHome = process.env.JDK_HOME;
const env = { ...process.env, GHIDRA_INSTALL_DIR: ghidraInstallDir, ...(javaHome ? { JAVA_HOME: javaHome } : {}) };
const java = javaHome ? join(javaHome, 'bin', 'java') : 'java';
run(java, ['-version'], { env });
const pythonPath = join(source, '.venv', 'bin', 'python');
if (!existsSync(pythonPath)) run('uv', ['venv', '--python', '3.11', join(source, '.venv')], { env });
const temp = mkdtempSync(join(tmpdir(), 'zeroverse-setup-'));
try {
  const requirements = join(temp, 'requirements.txt');
  run('uv', ['export', '--frozen', '--extra', 'analyze', '--extra', 'mcp', '--no-dev', '--no-emit-project', '--output-file', requirements], { env });
  run('uv', ['pip', 'install', '--python', pythonPath, '--requirement', requirements], { env });
  run('uv', ['pip', 'install', '--python', pythonPath, '--no-deps', '--editable', source], { env });
  const wheels = join(ghidraInstallDir, 'Ghidra', 'Features', 'PyGhidra', 'pypkg', 'dist');
  const bridge = children(wheels).find(path => /pyghidra-.*\.whl$/.test(path));
  if (!bridge) throw new Error(`Ghidra's bundled PyGhidra wheel is missing under ${wheels}`);
  run('uv', ['pip', 'install', '--python', pythonPath, bridge], { env });
  run(pythonPath, ['-m', 'zeroverse.cli', 'triage', pythonPath, '--json'], { env });
  console.log(run(pythonPath, ['-c', 'import pyghidra; from zeroverse.backends import contract; pyghidra.start(); backends=contract.available_backends(); assert "ghidra" in backends, backends; print("Decompiler ready:", backends)'], { env }));
  const config = resolve(process.env.ZERO_0VERSE_RUNTIME_CONFIG || join(homedir(), '.0', 'zeroverse-runtime.json'));
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ version: 1, pythonPath, ghidraInstallDir, ...(javaHome ? { javaHome } : {}) }, null, 2) + '\n', { mode: 0o600 });
  console.log(`0verse configured: ${config}\nPython: ${pythonPath}\nGhidra: ${ghidraInstallDir}`);
} finally { rmSync(temp, { recursive: true, force: true }); }
