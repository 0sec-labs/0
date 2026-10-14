#!/usr/bin/env node
/**
 * Deploy a Zero engine onto a remote Linux worker and register it as a
 * backend, so workflows (counterexample lane, fuzzing, Comparator-grade
 * checking) execute there instead of this Mac.
 *
 *   node deploy.mjs                          # local Lima VM (zero-worker)
 *   node deploy.mjs --ssh user@host          # any SSH host
 *   node deploy.mjs --target-git <url>       # worker clones the target itself
 *
 * Stages: toolchain → bundle → target → engine launch → tunnel → backend
 * registration. Every stage is idempotent; re-running is safe.
 *
 * Credentials: the engine bearer token is generated per run and written
 * (0600) to worker-token.env. Provider keys belong to the remote engine —
 * for the local-lima worker this machine's OPENAI_API_KEY is forwarded
 * (user's own VM); production workers enroll their own.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = new URL("../../", import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const SSH_HOST = flag("--ssh") ?? process.env.ZERO_WORKER_SSH;
const VM = flag("--lima") ?? process.env.ZERO_WORKER_VM ?? "zero-worker";
const TARGET_GIT = flag("--target-git") ?? process.env.ZERO_WORKER_TARGET_GIT;
const REMOTE_DIR = "/tmp/zero-engine";
const ENGINE_PORT = 8100;
const TOKEN = createHash("sha256").update(randomBytes(32)).digest("hex");
const BACKENDS_CONFIG = join(REPO, "research/remote-worker/backends.json");
const TOKEN_ENV = SSH_HOST ? "ZERO_SSH_WORKER_TOKEN" : "ZERO_LIMA_WORKER_TOKEN";
const BACKEND_ID = SSH_HOST ? "ssh-worker" : "lima-worker";

function stage(name) { console.error(`\x1b[36m[deploy]\x1b[0m ${name}`); }

// ── Runner abstraction: lima VM or plain SSH ────────────────────────────────
// Commands stream over stdin (`bash -s`) so no quoting layer ever sees them.
const runner = SSH_HOST ? {
  label: SSH_HOST,
  shell: (command, timeout = 300_000) =>
    execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", SSH_HOST, "bash", "-s"], { input: command, encoding: "utf8", timeout }),
  copy: (local, remote) => execFileSync("scp", ["-q", "-o", "BatchMode=yes", local, `${SSH_HOST}:${remote}`], { stdio: "inherit", timeout: 600_000 }),
  tunnel: (port) => {
    spawnSync("pkill", ["-f", `ssh.*-N.*-L.*${port}:127.0.0.1:${port}.*${SSH_HOST}`], { stdio: "ignore" });
    const t = spawn("ssh", ["-o", "BatchMode=yes", "-N", "-L", `${port}:127.0.0.1:${port}`, SSH_HOST], { stdio: "ignore", detached: true });
    t.unref();
  },
} : {
  label: VM,
  shell: (command, timeout = 300_000) =>
    execFileSync("limactl", ["shell", VM, "--", "bash", "-s"], { input: command, encoding: "utf8", timeout }),
  copy: (local, remote) => execFileSync("limactl", ["copy", local, `${VM}:${remote}`], { stdio: "inherit", timeout: 600_000 }),
  tunnel: (port) => {
    const configPath = "/tmp/zero-worker-ssh.conf";
    writeFileSync(configPath, execFileSync("limactl", ["show-ssh", "--format", "config", VM], { encoding: "utf8" }), { mode: 0o600 });
    spawnSync("pkill", ["-f", `zero-worker-ssh.conf.*${port}`], { stdio: "ignore" });
    const t = spawn("ssh", ["-F", configPath, "-N", "-L", `${port}:127.0.0.1:${port}`, `lima-${VM}`], { stdio: "ignore", detached: true });
    t.unref();
  },
};
const shell = runner.shell;

// ── 1. Host reachable ───────────────────────────────────────────────────────
stage(`checking worker ${runner.label}`);
if (!SSH_HOST) {
  const status = execFileSync("limactl", ["list", "--format", "{{.Status}}", VM], { encoding: "utf8" }).trim();
  if (status !== "Running") throw new Error(`VM ${VM} is ${status}; start it first`);
}
console.log(shell("uname -srm").trim());

// ── 2. Node >= 24 ───────────────────────────────────────────────────────────
stage("ensuring Node >= 24 on worker");
const nodeVersion = shell("command -v node >/dev/null && node --version || echo none").trim();
if (nodeVersion.startsWith("v2") && Number(nodeVersion.slice(1).split(".")[0]) >= 24) {
  console.log(`node ${nodeVersion} present`);
} else {
  console.log(`installing node (found: ${nodeVersion})`);
  const arch = shell("uname -m").trim() === "aarch64" ? "arm64" : "x64";
  shell(`cd /tmp && curl -fsSL https://nodejs.org/dist/v24.14.0/node-v24.14.0-linux-${arch}.tar.xz -o node.tar.xz && sudo tar -xJf node.tar.xz -C /usr/local --strip-components=1 && node --version`, 600_000);
}

// ── 3. clang + native build tools ───────────────────────────────────────────
stage("ensuring clang/build tools on worker");
const clangVersion = shell("command -v clang >/dev/null && clang --version | head -1 || echo none").trim();
if (clangVersion === "none") {
  shell("sudo apt-get update -qq && sudo apt-get install -y -qq clang build-essential python3 >/dev/null && clang --version | head -1", 900_000);
} else {
  console.log(clangVersion);
}

// ── 4. Bundle + externalized deps ───────────────────────────────────────────
stage("copying engine bundle");
execFileSync("tar", ["-czf", "/tmp/zero-engine-bundle.tar.gz", "-C", REPO, "dist"], { stdio: "inherit" });
execFileSync("tar", ["-czf", "/tmp/zero-demo-target.tar.gz", "-C", join(REPO, "research/counterexample-decoder"), "demo-target"], { stdio: "inherit" });
shell(`rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR}/vendor`);
runner.copy("/tmp/zero-engine-bundle.tar.gz", `${REMOTE_DIR}/bundle.tar.gz`);
runner.copy("/tmp/zero-demo-target.tar.gz", `${REMOTE_DIR}/demo-target.tar.gz`);
runner.copy(join(REPO, "vendor/tree-sitter-0.21.1-node24.tgz"), `${REMOTE_DIR}/vendor/tree-sitter-0.21.1-node24.tgz`);
shell(`cd ${REMOTE_DIR} && tar -xzf bundle.tar.gz && tar -xzf demo-target.tar.gz && ls dist/0.js demo-target/src/decoder.c`);

stage("installing externalized runtime deps on worker");
const remoteDeps = {
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
writeFileSync("/tmp/zero-engine-package.json", JSON.stringify({ name: "zero-engine-remote", private: true, dependencies: remoteDeps }, null, 2));
runner.copy("/tmp/zero-engine-package.json", `${REMOTE_DIR}/package.json`);
shell(`cd ${REMOTE_DIR} && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --no-audit --no-fund 2>&1 | tail -2`, 900_000);

// ── 5. Target inside the engine workspace ───────────────────────────────────
stage("staging target into engine workspace");
let targetPath;
if (TARGET_GIT) {
  shell(`rm -rf ${REMOTE_DIR}/work && mkdir -p ${REMOTE_DIR}/work && git clone --depth 1 ${TARGET_GIT} ${REMOTE_DIR}/work/target`, 900_000);
  targetPath = `${REMOTE_DIR}/work/target`;
} else {
  shell(`rm -rf ${REMOTE_DIR}/work && mkdir -p ${REMOTE_DIR}/work && cp -R ${REMOTE_DIR}/demo-target ${REMOTE_DIR}/work/demo-target`);
  targetPath = `${REMOTE_DIR}/work/demo-target`;
}
console.log(`target: ${targetPath}`);

// ── 6. Engine launch ────────────────────────────────────────────────────────
stage("launching engine on worker");
// Bracket pattern avoids pkill matching this shell's own command line.
shell(`pkill -f 'dist/0[.]js dashboard' || true`);
const providerEnv = process.env.OPENAI_API_KEY ? `OPENAI_API_KEY=${process.env.OPENAI_API_KEY} ` : "";
try {
  // execFileSync reaps the ssh shell; the setsid'd engine survives detached.
  shell(`cd ${REMOTE_DIR} && ${providerEnv}ZERO_WORKER_TOKEN=${TOKEN} setsid nohup node dist/0.js dashboard --host 127.0.0.1 --port ${ENGINE_PORT} --no-open --ready-json --engine-token-env ZERO_WORKER_TOKEN --engine-workspace ${REMOTE_DIR}/work > engine.log 2>&1 < /dev/null & echo started`, 30_000);
} catch { /* shell reaped; engine detached */ }
const ready = shell(`for i in $(seq 1 30); do grep -q ZERO_DASHBOARD_READY ${REMOTE_DIR}/engine.log 2>/dev/null && echo ready && break; sleep 1; done; tail -2 ${REMOTE_DIR}/engine.log`, 60_000);
console.log(ready.trim());
if (!ready.includes("ready")) throw new Error("engine did not become ready");

// ── 7. Tunnel + backend registration ────────────────────────────────────────
stage(`tunnel 127.0.0.1:${ENGINE_PORT} → ${runner.label}:${ENGINE_PORT}`);
runner.tunnel(ENGINE_PORT);
await new Promise(resolve => setTimeout(resolve, 2000));
execFileSync("curl", ["-sf", `http://127.0.0.1:${ENGINE_PORT}/`], { stdio: "ignore" });
console.log("tunnel healthy");

stage("registering backend");
const registry = { schemaVersion: 1, backends: [{ id: BACKEND_ID, name: `${runner.label} worker`, url: `http://127.0.0.1:${ENGINE_PORT}/`, bearerTokenEnv: TOKEN_ENV }] };
writeFileSync(BACKENDS_CONFIG, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
writeFileSync(join(REPO, "research/remote-worker/worker-token.env"), `${TOKEN_ENV}=${TOKEN}\n`, { mode: 0o600 });
console.log(`backend registry: ${BACKENDS_CONFIG}`);

console.error("\x1b[32m[deploy] worker ready\x1b[0m");
console.log(JSON.stringify({ worker: runner.label, engine: `http://127.0.0.1:${ENGINE_PORT}/`, backendId: BACKEND_ID, target: targetPath, backendsConfig: BACKENDS_CONFIG, tokenEnv: TOKEN_ENV }, null, 2));
