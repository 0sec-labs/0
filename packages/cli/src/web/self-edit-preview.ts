/**
 * Self-edit preview launcher (MVP, preview only).
 *
 * Creates a `self/<slug>` git worktree of the repository, installs its
 * dependencies, and runs the existing dev stack (`scripts/dev-web.mjs`: Vite
 * HMR + tsc watch + `node --watch` backend) on free loopback ports with a
 * scratch HOME seeded empty, so the preview never reads or writes the real
 * `~/.0`. Nothing here applies a change to the running dashboard.
 *
 * Isolation limits (be honest about them): the scratch HOME and the
 * allow-listed environment keep credentials and real state out of the
 * preview, but the preview backend is agent-edited code running as the same OS
 * user. It is NOT a filesystem or network sandbox.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGates, type Exec, type ExecResult, type GateResult } from "./self-edit-gates.js";
import { previewFrameAncestor } from "./dashboard-csp.js";
import { checkProtectedPaths, type ProtectedCheck } from "./self-edit-policy.js";

export class SelfEditError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

export type PreviewPhase = "idle" | "preparing" | "starting" | "running" | "stopping" | "failed";
export interface PreviewStatus {
  phase: PreviewPhase;
  branch?: string;
  slug?: string;
  worktree?: string;
  base?: string;
  /** Loopback URL of the preview dashboard (its own control token is injected by that server). */
  url?: string;
  backendPort?: number;
  frontendPort?: number;
  logTail: string[];
  error?: string;
  startedAt?: number;
  gates?: GateResult;
}
export interface PreviewDiff {
  base: string; branch: string;
  files: Array<{ path: string; status: string }>;
  untracked: string[];
  stat: string;
  patch: string;
  truncated: boolean;
  protected: ProtectedCheck;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface SelfEditDeps {
  /** Root of the repo checkout to branch from. */
  repoRoot: string;
  /** Holds worktrees, scratch homes and authoritative gate results. Outside the repo and the agent's write scope. */
  stateRoot: string;
  exec: Exec;
  spawn: SpawnFn;
  pickPort: () => Promise<number>;
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** Kill a process group. Injectable for tests. */
  killGroup: (pid: number, signal: NodeJS.Signals) => void;
}

const LOG_LINES = 200;
const MAX_PATCH = 200_000;
const ENV_ALLOW = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "SHELL", "USER", "LOGNAME", "PNPM_HOME", "COREPACK_HOME", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Only an explicit allow-list reaches the preview; provider keys, tokens and ZERO_* control variables never do. */
export function previewEnv(source: NodeJS.ProcessEnv, home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOW) if (source[key] !== undefined) env[key] = source[key];
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), ...extra };
}

export function slugFor(title: string | undefined, now: number, random = randomBytes(2).toString("hex")): string {
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const words = (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
  return `${words ? `${words}-` : ""}${stamp}-${random}`;
}

/** Loopback hosts only: the preview binds 127.0.0.1, so a non-loopback parent could not reach it anyway. */
export function frameAncestorFor(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    const url = new URL(`http://${hostHeader}`);
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? url.origin : undefined;
  } catch { return undefined; }
}

/** Frame-protection headers for dashboard responses. DENY unless a self-edit parent was named by its launcher. */
export function frameProtectionHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const ancestor = previewFrameAncestor(env);
  if (ancestor) {
    return { "Content-Security-Policy": `frame-ancestors ${ancestor}` };
  }
  return { "X-Frame-Options": "DENY" };
}

export const defaultExec: Exec = (command, args, options) => new Promise<ExecResult>(resolveExec => {
  let output = "";
  let timedOut = false;
  const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const add = (data: Buffer) => { output = (output + data.toString()).slice(-65536); };
  child.stdout?.on("data", add); child.stderr?.on("data", add);
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
  child.once("error", error => { clearTimeout(timer); resolveExec({ code: null, output: `${output}${error.message}`, timedOut }); });
  child.once("close", code => { clearTimeout(timer); resolveExec({ code, output, timedOut }); });
});

const freePort = () => new Promise<number>((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    const port = (server.address() as { port: number }).port;
    server.close(error => error ? reject(error) : resolvePort(port));
  });
});

export function defaultSelfEditDeps(env: NodeJS.ProcessEnv = process.env): SelfEditDeps {
  return {
    repoRoot: resolve(env["ZERO_SELF_EDIT_REPO"] ?? env["ZERO_DEV_SOURCE_ROOT"] ?? process.cwd()),
    stateRoot: resolve(env["ZERO_SELF_EDIT_DIR"] ?? join(tmpdir(), "0-self-edit")),
    exec: defaultExec,
    spawn: (command, args, options) => spawn(command, args, options),
    pickPort: freePort,
    env,
    now: Date.now,
    killGroup: (pid, signal) => { try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } },
  };
}

export class SelfEditPreview {
  private phase: PreviewPhase = "idle";
  private slug?: string;
  private worktree?: string;
  private base?: string;
  private url?: string;
  private ports?: { backend: number; frontend: number };
  private error?: string;
  private startedAt?: number;
  private child?: ChildProcess;
  private log: string[] = [];
  private gates?: GateResult;
  private gatesRunning = false;
  private exitHook?: () => void;

  constructor(private readonly deps: SelfEditDeps) {}

  private get branch() { return this.slug ? `self/${this.slug}` : undefined; }

  status(): PreviewStatus {
    return {
      phase: this.phase, ...(this.branch ? { branch: this.branch } : {}), ...(this.slug ? { slug: this.slug } : {}),
      ...(this.worktree ? { worktree: this.worktree } : {}), ...(this.base ? { base: this.base } : {}),
      ...(this.url ? { url: this.url } : {}), ...(this.ports ? { backendPort: this.ports.backend, frontendPort: this.ports.frontend } : {}),
      logTail: this.log.slice(-LOG_LINES), ...(this.error ? { error: this.error } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}), ...(this.gates ? { gates: this.gates } : {}),
    };
  }

  private pushLog(text: string) {
    for (const line of text.split(/\r?\n/)) if (line) this.log.push(line.slice(0, 500));
    if (this.log.length > LOG_LINES * 2) this.log = this.log.slice(-LOG_LINES);
  }

  private async git(cwd: string, ...args: string[]): Promise<string> {
    const out = await this.deps.exec("git", args, { cwd, timeoutMs: 60_000 });
    if (out.code !== 0 || out.timedOut) throw new SelfEditError(`git ${args[0]} failed: ${out.output.trim().slice(-500)}`, 500);
    return out.output;
  }

  /** Returns once the worktree exists; installation and the dev stack continue in the background. */
  async start(input: { title?: string; frameAncestor?: string } = {}): Promise<PreviewStatus> {
    if (this.phase !== "idle" && this.phase !== "failed") throw new SelfEditError("A self-edit preview is already active. Stop it first.", 409);
    const { deps } = this;
    const slug = slugFor(input.title, deps.now());
    if (!SLUG.test(slug)) throw new SelfEditError("Could not derive a safe branch name.", 400);
    this.reset();
    this.phase = "preparing"; this.slug = slug; this.startedAt = deps.now();
    try {
      const base = (await this.git(deps.repoRoot, "rev-parse", "HEAD")).trim();
      const root = join(deps.stateRoot, slug);
      const worktree = join(root, "worktree");
      const home = join(root, "home");
      mkdirSync(home, { recursive: true, mode: 0o700 });
      mkdirSync(join(home, ".0"), { recursive: true, mode: 0o700 });
      await this.git(deps.repoRoot, "worktree", "add", "-b", `self/${slug}`, worktree, base);
      this.worktree = worktree; this.base = base;
      await this.excludeMirror(worktree);
      void this.launch(worktree, home, input.frameAncestor);
    } catch (error) {
      this.fail(error);
      if (error instanceof SelfEditError) throw error;
      throw new SelfEditError(error instanceof Error ? error.message : String(error), 500);
    }
    return this.status();
  }

  private async excludeMirror(worktree: string) {
    const exclude = (await this.git(worktree, "rev-parse", "--git-path", "info/exclude")).trim();
    const file = resolve(worktree, exclude);
    mkdirSync(join(file, ".."), { recursive: true });
    appendFileSync(file, "\n/.0-self-edit/\n");
  }

  private async launch(worktree: string, home: string, frameAncestor: string | undefined) {
    const { deps } = this;
    try {
      this.pushLog("Installing dependencies in the worktree (frozen lockfile)...");
      const install = await deps.exec("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: worktree, timeoutMs: 900_000 });
      this.pushLog(install.output.split("\n").slice(-20).join("\n"));
      if (install.code !== 0 || install.timedOut) throw new SelfEditError("Dependency install failed in the worktree.", 500);
      if (this.phase !== "preparing") return;
      const backend = await deps.pickPort();
      let frontend = await deps.pickPort();
      while (frontend === backend) frontend = await deps.pickPort();
      this.ports = { backend, frontend };
      this.phase = "starting";
      const env = previewEnv(deps.env, home, {
        ZERO_DEV_PORT: String(backend), ZERO_DEV_FRONTEND_PORT: String(frontend),
        ...(frameAncestor ? { ZERO_PREVIEW_FRAME_ANCESTORS: frameAncestor } : {}),
      });
      const child = deps.spawn(process.execPath, [join(worktree, "scripts", "dev-web.mjs"), "--port", String(backend), "--frontend-port", String(frontend)], {
        cwd: worktree, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      });
      this.child = child;
      this.exitHook = () => { if (child.pid) try { deps.killGroup(child.pid, "SIGKILL"); } catch { /* best effort at exit */ } };
      process.once("exit", this.exitHook);
      const onData = (data: Buffer | string) => {
        const text = data.toString();
        this.pushLog(text);
        const ready = /ZERO_DEV_READY (\{.*\})/.exec(text);
        if (ready && this.phase === "starting") {
          try { this.url = (JSON.parse(ready[1]!) as { backendUrl?: string }).backendUrl ?? `http://127.0.0.1:${backend}`; }
          catch { this.url = `http://127.0.0.1:${backend}`; }
          this.phase = "running";
        }
      };
      child.stdout?.on("data", onData); child.stderr?.on("data", onData);
      child.once("error", error => this.fail(error));
      child.once("close", (code, signal) => {
        if (this.child !== child) return;
        this.child = undefined;
        if (this.phase === "stopping") return;
        this.fail(new Error(`Preview stack exited (${signal ?? code}).`));
      });
    } catch (error) { this.fail(error); }
  }

  private fail(error: unknown) {
    this.phase = "failed";
    this.error = error instanceof Error ? error.message : String(error);
    this.url = undefined;
    this.pushLog(`ERROR ${this.error}`);
    this.killChild();
  }

  private killChild() {
    const child = this.child;
    if (this.exitHook) { process.removeListener("exit", this.exitHook); this.exitHook = undefined; }
    this.child = undefined;
    if (child?.pid) try { this.deps.killGroup(child.pid, "SIGTERM"); } catch { /* already gone */ }
  }

  private reset() {
    this.slug = this.worktree = this.base = this.url = this.ports = this.error = this.startedAt = this.gates = undefined;
    this.log = []; this.gatesRunning = false;
  }

  /**
   * Stops the dev stack. The worktree and branch are kept unless `discard` is
   * explicit, because discarding drops uncommitted edits and unpushed commits.
   */
  async stop(input: { discard?: boolean } = {}): Promise<PreviewStatus> {
    if (this.phase === "idle") return this.status();
    const { worktree, slug } = this;
    this.phase = "stopping";
    const child = this.child;
    this.killChild();
    if (child?.pid) {
      await new Promise<void>(done => {
        const timer = setTimeout(() => { try { this.deps.killGroup(child.pid!, "SIGKILL"); } catch { /* gone */ } done(); }, 5000);
        timer.unref?.();
        child.once("close", () => { clearTimeout(timer); done(); });
        if (child.exitCode !== null || child.killed && child.signalCode) { clearTimeout(timer); done(); }
      });
    }
    if (input.discard && worktree && slug) {
      await this.deps.exec("git", ["worktree", "remove", "--force", worktree], { cwd: this.deps.repoRoot, timeoutMs: 60_000 });
      await this.deps.exec("git", ["branch", "-D", `self/${slug}`], { cwd: this.deps.repoRoot, timeoutMs: 30_000 });
      rmSync(join(this.deps.stateRoot, slug), { recursive: true, force: true });
    }
    const kept = input.discard ? undefined : { worktree, slug };
    this.reset();
    this.phase = "idle";
    if (kept?.worktree) { this.worktree = kept.worktree; this.slug = kept.slug; }
    return this.status();
  }

  private requireWorktree(): { worktree: string; base: string; branch: string } {
    if (!this.worktree || !this.base || !this.branch) throw new SelfEditError("No self-edit worktree exists. Start a preview first.", 409);
    return { worktree: this.worktree, base: this.base, branch: this.branch };
  }

  async diff(): Promise<PreviewDiff> {
    const { worktree, base, branch } = this.requireWorktree();
    const names = await this.git(worktree, "diff", "--name-status", "--no-renames", "-z", base);
    const parts = names.split("\0").filter(Boolean);
    const files: PreviewDiff["files"] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i]!, path: parts[i + 1]! });
    const untracked = (await this.git(worktree, "ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
    const stat = (await this.git(worktree, "diff", "--stat", "--no-renames", base)).trim();
    const patch = await this.git(worktree, "diff", "--no-renames", "--no-color", base);
    return {
      base, branch, files, untracked, stat, truncated: patch.length > MAX_PATCH,
      patch: patch.length > MAX_PATCH ? `${patch.slice(0, MAX_PATCH)}\n... diff truncated ...` : patch,
      protected: checkProtectedPaths([...files.map(file => file.path), ...untracked]),
    };
  }

  /** Starts the gate run in the background; poll `status().gates`. The agent cannot influence the verdict. */
  async runGates(): Promise<PreviewStatus> {
    const { worktree, base, slug } = { ...this.requireWorktree(), slug: this.slug! };
    if (this.gatesRunning) throw new SelfEditError("Gates are already running.", 409);
    this.gatesRunning = true;
    const resultFile = join(this.deps.stateRoot, slug, "gates.json");
    const mirror = join(worktree, ".0-self-edit", "gate-result.json");
    const persist = (result: GateResult) => {
      this.gates = result;
      try {
        writeFileSync(resultFile, JSON.stringify(result, null, 2));
        mkdirSync(join(worktree, ".0-self-edit"), { recursive: true });
        // Read-only convenience copy for the agent. The verdict lives in this process and in `resultFile`.
        writeFileSync(mirror, JSON.stringify({ note: "Non-authoritative copy. Only the dashboard gate runner decides.", ...result }, null, 2));
      } catch { /* the in-memory verdict stays authoritative */ }
    };
    void runGates({ worktree, base, exec: this.deps.exec, now: this.deps.now, onUpdate: persist })
      .then(persist)
      .catch(error => persist({
        status: "failed", startedAt: this.deps.now(), finishedAt: this.deps.now(), steps: [{ id: "runner", label: "Gate runner", status: "failed", detail: error instanceof Error ? error.message : String(error) }],
        protected: { ok: false, files: [], hits: [], error: "gate runner crashed" },
      }))
      .finally(() => { if (this.slug === slug) this.gatesRunning = false; });
    return this.status();
  }

  /** Test/diagnostic helper: read a persisted gate result. */
  readPersistedGates(): GateResult | undefined {
    if (!this.slug) return undefined;
    const file = join(this.deps.stateRoot, this.slug, "gates.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as GateResult : undefined;
  }
}

let shared: SelfEditPreview | undefined;
export function sharedSelfEditPreview(): SelfEditPreview { return shared ??= new SelfEditPreview(defaultSelfEditDeps()); }
