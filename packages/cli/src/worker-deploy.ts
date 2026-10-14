import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { homeStateDir } from "@0/shared";

export interface WorkerDeployOptions {
  /** SSH target, e.g. "user@host". Mutually exclusive with lima. */
  ssh?: string;
  /** Lima instance name (default zero-worker). */
  lima?: string;
  /** Worker clones this repository into the engine workspace instead of staging the bundled demo target. */
  targetGit?: string;
  enginePort?: number;
  /** Repo root containing dist/ and vendor/. */
  repoRoot?: string;
  /** Forward this machine's OPENAI_API_KEY to the worker engine (user-owned hosts only). */
  forwardProviderKey?: boolean;
  /** OpenSSH config file for the SSH target (e.g. a Lima instance's ssh.config). */
  sshConfig?: string;
  backendsConfig?: string;
}

export interface WorkerDeployResult {
  backendId: string;
  engine: string;
  target: string;
  backendsConfig: string;
  tokenEnv: string;
}

export interface WorkerRunner {
  shell(command: string, timeout?: number): string;
  copy(local: string, remote: string): void;
  tunnel(port: number): number | void;
  readonly label: string;
}

const REMOTE_DIR = "/tmp/zero-engine";

const REMOTE_DEPS = {
  "drizzle-orm": "^0.45.2",
  "node-sqlite3-wasm": "^0.8.55",
  "pdfkit": "^0.15.2",
  "playwright": "1.60.0",
  "react": "^19.2.4",
  "react-dom": "^19.2.4",
  "tree-sitter": `file:${REMOTE_DIR}/vendor/tree-sitter-0.21.1-node24.tgz`,
  "tree-sitter-c": "0.21.4",
  "@opentui/core": "0.5.4",
  "@opentui/react": "0.5.4",
};

/** Commands stream over stdin (`bash -s`) so no quoting layer ever sees them. */
const SSH_HOST_PATTERN = /^[A-Za-z0-9._@-]+$/;
const LIMA_NAME_PATTERN = /^[\w.-]+$/;
const TARGET_GIT_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"]+$/;
const sq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function resolveWorkerRepoRoot(moduleUrl = import.meta.url): string {
  let directory = dirname(fileURLToPath(moduleUrl));
  while (true) {
    if ((existsSync(join(directory, "dist/0.js")) || existsSync(join(directory, "0.js"))) && existsSync(join(directory, "vendor/tree-sitter-0.21.1-node24.tgz"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Worker deployment requires the built CLI dist/ and vendor/ assets. Run pnpm build first.");
    directory = parent;
  }
}

export function validateWorkerOptions(options: WorkerDeployOptions): void {
  if (options.enginePort !== undefined && (!Number.isInteger(options.enginePort) || options.enginePort < 1 || options.enginePort > 65535)) throw new Error("enginePort must be 1-65535");
  if (options.ssh && (!SSH_HOST_PATTERN.test(options.ssh) || options.ssh.startsWith("-"))) {
    throw new Error("--ssh must be an OpenSSH host name or user@host (no options or shell characters)");
  }
  if (options.lima && !LIMA_NAME_PATTERN.test(options.lima)) throw new Error("--lima must be an instance name (letters, digits, ., _, -)");
  if (options.targetGit && !TARGET_GIT_PATTERN.test(options.targetGit)) throw new Error("--target-git must be a URL without whitespace or quotes");
}

export function createRunner(options: Pick<WorkerDeployOptions, "ssh" | "lima" | "sshConfig">): WorkerRunner {
  if (options.ssh) {
    const host = options.ssh;
    const configArgs = options.sshConfig ? ["-F", options.sshConfig] : [];
    return {
      label: host,
      shell: (command, timeout = 300_000) =>
        execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ...configArgs, "--", host, "bash", "-s"], { input: command, encoding: "utf8", timeout }),
      copy: (local, remote) => execFileSync("scp", ["-q", "-o", "BatchMode=yes", ...configArgs, "--", local, `${host}:${remote}`], { stdio: "inherit", timeout: 600_000 }),
      tunnel: (port) => {
        const child = spawn("ssh", ["-o", "BatchMode=yes", ...configArgs, "-N", "-L", `${port}:127.0.0.1:${port}`, "--", host], { stdio: "ignore", detached: true });
        child.unref();
        return child.pid;
      },
    };
  }
  const vm = options.lima ?? "zero-worker";
  return {
    label: vm,
    shell: (command, timeout = 300_000) =>
      execFileSync("limactl", ["shell", vm, "--", "bash", "-s"], { input: command, encoding: "utf8", timeout }),
    copy: (local, remote) => execFileSync("limactl", ["copy", local, `${vm}:${remote}`], { stdio: "inherit", timeout: 600_000 }),
    tunnel: (port) => {
      const configPath = "/tmp/zero-worker-ssh.conf";
      writeFileSync(configPath, execFileSync("limactl", ["show-ssh", "--format", "config", vm], { encoding: "utf8" }), { mode: 0o600 });
      const child = spawn("ssh", ["-F", configPath, "-N", "-L", `${port}:127.0.0.1:${port}`, `lima-${vm}`], { stdio: "ignore", detached: true });
      child.unref();
      return child.pid;
    },
  };
}

/** Deploy a Zero engine onto a remote worker and register it as a backend. Idempotent. */
export async function deployWorker(options: WorkerDeployOptions, runner: WorkerRunner = createRunner(options)): Promise<WorkerDeployResult> {
  validateWorkerOptions(options);
  const repoRoot = options.repoRoot ?? resolveWorkerRepoRoot();
  const port = options.enginePort ?? 20000 + Number.parseInt(createHash("sha256").update(runner.label).digest("hex").slice(0, 4), 16) % 20000;
  const token = createHash("sha256").update(randomBytes(32)).digest("hex");
  const identity = createHash("sha256").update(`${options.ssh ? "ssh" : "lima"}:${runner.label}`).digest("hex").slice(0, 12);
  const backendId = `${options.ssh ? "ssh" : "lima"}-worker-${identity}`;
  const tokenEnv = `ZERO_WORKER_${identity.toUpperCase()}_TOKEN`;
  const { shell } = runner;

  if (!options.ssh) {
    const status = execFileSync("limactl", ["list", "--format", "{{.Status}}", runner.label], { encoding: "utf8" }).trim();
    if (status !== "Running") throw new Error(`VM ${runner.label} is ${status}; start it first`);
  }
  shell("uname -srm");

  const nodeVersion = shell("command -v node >/dev/null && node --version || echo none").trim();
  if (!(nodeVersion.startsWith("v2") && Number(nodeVersion.slice(1).split(".")[0]) >= 24)) {
    const arch = shell("uname -m").trim() === "aarch64" ? "arm64" : "x64";
    shell(`cd /tmp && curl -fsSL https://nodejs.org/dist/v24.14.0/node-v24.14.0-linux-${arch}.tar.xz -o node.tar.xz && sudo tar -xJf node.tar.xz -C /usr/local --strip-components=1 && node --version`, 600_000);
  }
  const clangVersion = shell("command -v clang >/dev/null && clang --version | head -1 || echo none").trim();
  if (clangVersion === "none") {
    shell("sudo apt-get update -qq && sudo apt-get install -y -qq clang build-essential python3 >/dev/null && clang --version | head -1", 900_000);
  }

  const staging = mkdtempSync(join(tmpdir(), "zero-worker-"));
  try {
  const bundleRoot = existsSync(join(repoRoot, "dist/0.js")) ? repoRoot : staging;
  if (bundleRoot === staging) {
    mkdirSync(join(staging, "dist"));
    for (const asset of ["0.js", "cli-path-traversal-fixture.js", "chunks", "attacks", "dashboard", "worker-assets"]) {
      if (existsSync(join(repoRoot, asset))) cpSync(join(repoRoot, asset), join(staging, "dist", asset), { recursive: true });
    }
  }
  execFileSync("tar", ["-czf", join(staging, "bundle.tar.gz"), "-C", bundleRoot, "dist"], { stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const demoRoot = existsSync(join(bundleRoot, "dist/worker-assets/demo-target")) ? join(bundleRoot, "dist/worker-assets") : join(repoRoot, "research/counterexample-decoder");
  if (!options.targetGit) execFileSync("tar", ["-czf", join(staging, "demo-target.tar.gz"), "-C", demoRoot, "demo-target"], { stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  // Match both the owned workspace and engine command before replacing a process.
  shell(`for entry in /proc/[0-9]*/cwd; do
    test "$(readlink "$entry" 2>/dev/null)" = "${REMOTE_DIR}" || continue
    pid=$(echo "$entry" | cut -d/ -f3)
    command=$(tr '\\000' ' ' < /proc/$pid/cmdline 2>/dev/null) || continue
    case "$command" in 'node dist/0.js dashboard '*|'node /tmp/zero-engine/dist/0.js dashboard '*) kill "$pid" || true;; esac
  done`);
  shell(`rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR}/vendor`);
  runner.copy(join(staging, "bundle.tar.gz"), `${REMOTE_DIR}/bundle.tar.gz`);
  if (!options.targetGit) runner.copy(join(staging, "demo-target.tar.gz"), `${REMOTE_DIR}/demo-target.tar.gz`);
  runner.copy(join(repoRoot, "vendor/tree-sitter-0.21.1-node24.tgz"), `${REMOTE_DIR}/vendor/tree-sitter-0.21.1-node24.tgz`);
  shell(`cd ${REMOTE_DIR} && tar -xzf bundle.tar.gz && ${options.targetGit ? "ls dist/0.js" : "tar -xzf demo-target.tar.gz && ls dist/0.js demo-target/src/decoder.c"}`);

  writeFileSync(join(staging, "package.json"), JSON.stringify({ name: "zero-engine-remote", private: true, dependencies: REMOTE_DEPS }, null, 2));
  runner.copy(join(staging, "package.json"), `${REMOTE_DIR}/package.json`);
  shell(`cd ${REMOTE_DIR} && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --no-audit --no-fund > install.log 2>&1 || { tail -20 install.log; exit 1; }`, 900_000);
  let targetPath: string;
  if (options.targetGit) {
    shell(`rm -rf ${REMOTE_DIR}/work && mkdir -p ${REMOTE_DIR}/work && git clone --depth 1 ${sq(options.targetGit!)} ${REMOTE_DIR}/work/target`, 900_000);
    targetPath = `${REMOTE_DIR}/work/target`;
  } else {
    shell(`rm -rf ${REMOTE_DIR}/work && mkdir -p ${REMOTE_DIR}/work && cp -R ${REMOTE_DIR}/demo-target ${REMOTE_DIR}/work/demo-target`);
    targetPath = `${REMOTE_DIR}/work/demo-target`;
  }

  const providerEnv = options.forwardProviderKey && process.env.OPENAI_API_KEY ? `OPENAI_API_KEY=${sq(process.env.OPENAI_API_KEY)} ` : "";
  try {
    // The ssh shell is reaped on teardown; the setsid'd engine survives detached.
    shell(`cd ${REMOTE_DIR} || exit 1; ${providerEnv}ZERO_WORKER_TOKEN=${token} setsid nohup node dist/0.js dashboard --host 127.0.0.1 --port ${port} --no-open --ready-json --engine-token-env ZERO_WORKER_TOKEN --engine-workspace ${REMOTE_DIR}/work > engine.log 2>&1 < /dev/null & echo $! > ${REMOTE_DIR}/engine.pid; echo started`, 30_000);
  } catch { /* shell reaped; engine detached */ }
  const ready = shell(`for i in $(seq 1 30); do grep -q ZERO_DASHBOARD_READY ${REMOTE_DIR}/engine.log 2>/dev/null && echo ready && break; sleep 1; done; tail -2 ${REMOTE_DIR}/engine.log`, 60_000);
  if (!ready.includes("ready")) throw new Error(`engine did not become ready: ${ready.trim()}`);

  const tunnelPid = runner.tunnel(port);
  const tunnelReady = Promise.withResolvers<void>();
  setTimeout(tunnelReady.resolve, 2000);
  await tunnelReady.promise;
  execFileSync("curl", ["-sf", `http://127.0.0.1:${port}/`], { stdio: "ignore" });

  const stateDir = join(homeStateDir(), "workers");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const backendsConfig = options.backendsConfig ?? join(homeStateDir(), "backends.json");
  let registry: { schemaVersion: 1; backends: Array<Record<string, unknown>> } = { schemaVersion: 1, backends: [] };
  try { registry = JSON.parse(await (await import("node:fs/promises")).readFile(backendsConfig, "utf8")); } catch { /* first registration */ }
  registry.backends = [...registry.backends.filter(row => row.id !== backendId), { id: backendId, name: `${runner.label} worker`, url: `http://127.0.0.1:${port}/`, bearerTokenEnv: tokenEnv }];
  writeFileSync(backendsConfig, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(stateDir, `${backendId}.env`), `${tokenEnv}=${token}\n`, { mode: 0o600 });

  writeFileSync(join(stateDir, `${backendId}.json`), JSON.stringify({ schemaVersion: 1, backendId, ssh: options.ssh, lima: options.ssh ? undefined : options.lima ?? "zero-worker", sshConfig: options.sshConfig, port, tunnelPid, remoteDir: REMOTE_DIR }, null, 2) + "\n", { mode: 0o600 });
  process.env[tokenEnv] = token;
  return { backendId, engine: `http://127.0.0.1:${port}/`, target: targetPath, backendsConfig, tokenEnv };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export interface ManagedWorker {
  schemaVersion: 1; backendId: string; ssh?: string; lima?: string; sshConfig?: string; port: number; tunnelPid?: number; remoteDir: string;
}
export function loadManagedWorker(backendId: string): ManagedWorker {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(backendId)) throw new Error("Invalid worker ID.");
  let worker: ManagedWorker;
  try { worker = JSON.parse(readFileSync(join(homeStateDir(), "workers", `${backendId}.json`), "utf8")); }
  catch { throw new Error("This connection has no managed deployment metadata. Stop its engine directly on the host."); }
  if (worker.schemaVersion !== 1 || worker.backendId !== backendId || worker.remoteDir !== REMOTE_DIR || (!!worker.ssh === !!worker.lima)) throw new Error("Invalid managed deployment metadata.");
  validateWorkerOptions({ ...worker, enginePort: worker.port });
  return worker;
}
export function stopManagedTunnel(worker: ManagedWorker): boolean {
  if (!Number.isSafeInteger(worker.tunnelPid) || worker.tunnelPid! <= 1) return false;
  const result = spawnSync("ps", ["-p", String(worker.tunnelPid), "-o", "comm=", "-o", "args="], { encoding: "utf8" });
  const command = result.stdout?.trim() ?? "";
  const destination = worker.ssh ?? `lima-${worker.lima}`;
  if (!/^\S*ssh\s/.test(command) || !command.includes(` ${worker.port}:127.0.0.1:${worker.port} `) || !command.endsWith(` ${destination}`)) return false;
  try { process.kill(worker.tunnelPid!, "SIGTERM"); return true; } catch { return false; }
}
export async function stopWorker(backendId: string, suppliedRunner?: WorkerRunner): Promise<{ stopped: true; tunnelStopped: boolean; remoteFilesRemoved: false }> {
  const worker = loadManagedWorker(backendId);
  const runner = suppliedRunner ?? createRunner(worker);
  runner.shell(`set -eu
if test ! -f ${REMOTE_DIR}/engine.pid; then echo 'Managed engine PID is unavailable; engine was not stopped.' >&2; exit 1; fi
pid=$(cat ${REMOTE_DIR}/engine.pid)
case "$pid" in ''|*[!0-9]*) echo 'Invalid engine PID' >&2; exit 1;; esac
if test "$pid" -le 1; then echo 'Invalid engine PID' >&2; exit 1; fi
if test -e /proc/$pid/cmdline; then
  if test "$(readlink /proc/$pid/cwd)" != "${REMOTE_DIR}"; then echo 'Engine working directory does not match managed Zero engine' >&2; exit 1; fi
  command=$(tr '\\000' ' ' < /proc/$pid/cmdline)
  case "$command" in 'node dist/0.js dashboard '*|'node /tmp/zero-engine/dist/0.js dashboard '*) kill "$pid";; *) echo 'Engine PID does not match managed Zero engine' >&2; exit 1;; esac
fi
rm -f ${REMOTE_DIR}/engine.pid`, 30_000);
  return { stopped: true, tunnelStopped: stopManagedTunnel(worker), remoteFilesRemoved: false };
}
