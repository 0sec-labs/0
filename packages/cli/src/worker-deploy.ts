import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  tunnel(port: number): void;
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

export function validateWorkerOptions(options: WorkerDeployOptions): void {
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
        spawnSync("pkill", ["-f", `ssh.*-N.*-L.*${port}:127.0.0.1:${port}.*${host}`], { stdio: "ignore" });
        spawn("ssh", ["-o", "BatchMode=yes", ...configArgs, "-N", "-L", `${port}:127.0.0.1:${port}`, "--", host], { stdio: "ignore", detached: true }).unref();
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
      spawnSync("pkill", ["-f", `zero-worker-ssh.conf.*${port}`], { stdio: "ignore" });
      spawn("ssh", ["-F", configPath, "-N", "-L", `${port}:127.0.0.1:${port}`, `lima-${vm}`], { stdio: "ignore", detached: true }).unref();
    },
  };
}

/** Deploy a Zero engine onto a remote worker and register it as a backend. Idempotent. */
export async function deployWorker(options: WorkerDeployOptions, runner: WorkerRunner = createRunner(options)): Promise<WorkerDeployResult> {
  validateWorkerOptions(options);
  const repoRoot = options.repoRoot ?? new URL("../../", import.meta.url).pathname;
  const port = options.enginePort ?? 8100;
  const token = createHash("sha256").update(randomBytes(32)).digest("hex");
  const backendId = options.ssh ? "ssh-worker" : "lima-worker";
  const tokenEnv = options.ssh ? "ZERO_SSH_WORKER_TOKEN" : "ZERO_LIMA_WORKER_TOKEN";
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

  execFileSync("tar", ["-czf", "/tmp/zero-engine-bundle.tar.gz", "-C", repoRoot, "dist"], { stdio: "inherit" });
  execFileSync("tar", ["-czf", "/tmp/zero-demo-target.tar.gz", "-C", join(repoRoot, "research/counterexample-decoder"), "demo-target"], { stdio: "inherit" });
  shell(`rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR}/vendor`);
  runner.copy("/tmp/zero-engine-bundle.tar.gz", `${REMOTE_DIR}/bundle.tar.gz`);
  runner.copy("/tmp/zero-demo-target.tar.gz", `${REMOTE_DIR}/demo-target.tar.gz`);
  runner.copy(join(repoRoot, "vendor/tree-sitter-0.21.1-node24.tgz"), `${REMOTE_DIR}/vendor/tree-sitter-0.21.1-node24.tgz`);
  shell(`cd ${REMOTE_DIR} && tar -xzf bundle.tar.gz && tar -xzf demo-target.tar.gz && ls dist/0.js demo-target/src/decoder.c`);

  writeFileSync("/tmp/zero-engine-package.json", JSON.stringify({ name: "zero-engine-remote", private: true, dependencies: REMOTE_DEPS }, null, 2));
  runner.copy("/tmp/zero-engine-package.json", `${REMOTE_DIR}/package.json`);
  shell(`cd ${REMOTE_DIR} && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --no-audit --no-fund 2>&1 | tail -2`, 900_000);
  let targetPath: string;
  if (options.targetGit) {
    shell(`rm -rf ${REMOTE_DIR}/work && mkdir -p ${REMOTE_DIR}/work && git clone --depth 1 ${sq(options.targetGit!)} ${REMOTE_DIR}/work/target`, 900_000);
    targetPath = `${REMOTE_DIR}/work/target`;
  } else {
    shell(`rm -rf ${REMOTE_DIR}/work && mkdir -p ${REMOTE_DIR}/work && cp -R ${REMOTE_DIR}/demo-target ${REMOTE_DIR}/work/demo-target`);
    targetPath = `${REMOTE_DIR}/work/demo-target`;
  }

  // Bracket pattern avoids pkill matching the shell's own command line.
  shell(`pkill -f 'dist/0[.]js dashboard' || true`);
  const providerEnv = options.forwardProviderKey && process.env.OPENAI_API_KEY ? `OPENAI_API_KEY=${process.env.OPENAI_API_KEY} ` : "";
  try {
    // The ssh shell is reaped on teardown; the setsid'd engine survives detached.
    shell(`cd ${REMOTE_DIR} && ${providerEnv}ZERO_WORKER_TOKEN=${token} setsid nohup node dist/0.js dashboard --host 127.0.0.1 --port ${port} --no-open --ready-json --engine-token-env ZERO_WORKER_TOKEN --engine-workspace ${REMOTE_DIR}/work > engine.log 2>&1 < /dev/null & echo started`, 30_000);
  } catch { /* shell reaped; engine detached */ }
  const ready = shell(`for i in $(seq 1 30); do grep -q ZERO_DASHBOARD_READY ${REMOTE_DIR}/engine.log 2>/dev/null && echo ready && break; sleep 1; done; tail -2 ${REMOTE_DIR}/engine.log`, 60_000);
  if (!ready.includes("ready")) throw new Error(`engine did not become ready: ${ready.trim()}`);

  runner.tunnel(port);
  const tunnelReady = Promise.withResolvers<void>();
  setTimeout(tunnelReady.resolve, 2000);
  await tunnelReady.promise;
  execFileSync("curl", ["-sf", `http://127.0.0.1:${port}/`], { stdio: "ignore" });

  const stateDir = join(homeStateDir(), "workers");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const backendsConfig = join(homeStateDir(), "backends.json");
  let registry: { schemaVersion: 1; backends: Array<Record<string, unknown>> } = { schemaVersion: 1, backends: [] };
  try { registry = JSON.parse(await (await import("node:fs/promises")).readFile(backendsConfig, "utf8")); } catch { /* first registration */ }
  registry.backends = [...registry.backends.filter(row => row.id !== backendId), { id: backendId, name: `${runner.label} worker`, url: `http://127.0.0.1:${port}/`, bearerTokenEnv: tokenEnv }];
  writeFileSync(backendsConfig, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(stateDir, `${backendId}.env`), `${tokenEnv}=${token}\n`, { mode: 0o600 });

  return { backendId, engine: `http://127.0.0.1:${port}/`, target: targetPath, backendsConfig, tokenEnv };
}
