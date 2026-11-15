import { audit } from "./audit.js";
import {
  fetchLatestTag, isStableNewer, performAutoUpdate, readCheckCache, updatesDisabledByEnvironment, writeCheckCache,
  type AutoUpdateResult, type UpdatePolicy,
} from "../utils/update-check.js";
import { detectInstallKind, type InstallInfo } from "../utils/install-origin.js";
import { readUpdateStatus, type UpdatePhase, type UpdateStatus } from "./update-status.js";

const HOUR_MS = 60 * 60 * 1000;
export const CHECK_INTERVAL_MS = 6 * HOUR_MS;
export const IDLE_RESTART_MS = 10 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 45_000;
const WATCH_INTERVAL_MS = 30_000;

/** Same release is not retried more often than this after a failed install. */
const RETRY_AFTER_FAILURE_MS = CHECK_INTERVAL_MS;

/** An error with a stable code and HTTP status, carried to the route handler. */
export class UpdateError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

/**
 * True when a supervisor (launchd, systemd, pm2) owns this process: it restarts the process after it exits,
 * so the console must exit instead of starting a second copy. ZERO_SUPERVISED=1 or 0 overrides detection.
 */
export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env["ZERO_SUPERVISED"];
  if (explicit === "1" || explicit === "true") return true;
  if (explicit === "0" || explicit === "false") return false;
  if (env["INVOCATION_ID"] || env["pm_id"] !== undefined) return true;
  const service = env["XPC_SERVICE_NAME"];
  return Boolean(service && service !== "0" && !service.startsWith("application."));
}

export interface UpdateManagerOptions {
  current: string;
  serverMode: boolean;
  /** Running threads and automations. Read at the moment of every decision. */
  threadCount: () => number;
  /** Ask the host to shut down gracefully and start the new binary (or exit 0 under a supervisor). Called once. */
  restart: (info: { version: string; supervised: boolean }) => void;
  policy: () => UpdatePolicy;
  install?: InstallInfo;
  supervised?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  fetchLatest?: () => Promise<string | null>;
  installer?: typeof performAutoUpdate;
  intervalMs?: number;
  idleRestartMs?: number;
  /** Idle-watch cadence (tests). */
  watchIntervalMs?: number;
  /** Delay between the answer to the browser and the restart, so the answer is delivered. */
  restartDelayMs?: number;
  random?: () => number;
}

export interface ApplyResult { restarting: true; version: string; supervised: boolean }

/**
 * Keeps a long-running `0 web` current. It checks every six hours (jittered, offline-safe, never blocking),
 * installs a verified release in the background when nothing is running (policy automatic), and restarts on
 * request, or on its own after ten idle minutes when the policy is automatic and server mode is off.
 * The installer is the same one `0 doctor upgrade` uses: checksum verification and an atomic swap in the folder
 * of the running binary.
 */
export class UpdateManager {
  readonly #o: UpdateManagerOptions;
  readonly #install: InstallInfo;
  readonly #supervised: boolean;
  readonly #now: () => number;
  #staged: string | null = null;
  #phase: UpdatePhase = "idle";
  #error: string | undefined;
  #installing: Promise<AutoUpdateResult> | null = null;
  #applying = false;
  #restarted = false;
  #watching = false;
  #failed: { tag: string; at: number } | null = null;
  #lastBusyAt: number;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #stopped = true;

  constructor(options: UpdateManagerOptions) {
    this.#o = options;
    this.#install = options.install ?? detectInstallKind();
    this.#supervised = options.supervised ?? isSupervised(options.env);
    this.#now = options.now ?? Date.now;
    this.#lastBusyAt = this.#now();
  }

  get managed(): boolean { return this.#install.managed; }
  get stagedVersion(): string | null { return this.#staged; }

  status(): UpdateStatus {
    return readUpdateStatus({
      current: this.#o.current, policy: this.#o.policy(), env: this.#o.env, install: this.#install, staged: this.#staged,
      phase: this.#phase, threadsRunning: this.#o.threadCount(), supervised: this.#supervised, serverMode: this.#o.serverMode,
      restartable: true, error: this.#error,
    });
  }

  /** Starts the background check. Timers are unref'd: they never keep the process alive. */
  start(): void {
    if (!this.#stopped || !this.#install.managed) return;
    this.#stopped = false;
    this.#schedule(() => void this.#tick(), FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    this.#stopped = true;
    this.#watching = false;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  #schedule(run: () => void, delayMs: number): void {
    const timer = setTimeout(() => { this.#timers.delete(timer); if (!this.#stopped) run(); }, delayMs);
    timer.unref?.();
    this.#timers.add(timer);
  }

  #nextCheckDelay(): number {
    const base = this.#o.intervalMs ?? CHECK_INTERVAL_MS;
    return Math.round(base * (0.9 + 0.2 * (this.#o.random ?? Math.random)()));
  }

  /** One background pass. Never throws, never blocks a request. */
  async tick(): Promise<void> { await this.#tick(true); }

  async #tick(single = false): Promise<void> {
    try {
      await this.#check();
    } catch { /* A failed background check must never surface. */ }
    if (!single && !this.#stopped) this.#schedule(() => void this.#tick(), this.#nextCheckDelay());
  }

  async #check(): Promise<void> {
    if (!this.#install.managed || updatesDisabledByEnvironment(this.#o.env) || this.#o.policy() === "off") return;
    const now = this.#now();
    let cache = readCheckCache();
    const interval = this.#o.intervalMs ?? CHECK_INTERVAL_MS;
    // Another process (a CLI start) may have checked recently: reuse its answer instead of asking again.
    if (!cache || now - Date.parse(cache.lastCheckedAt) >= interval * 0.9 || !Number.isFinite(Date.parse(cache.lastCheckedAt))) {
      const tag = await (this.#o.fetchLatest ?? fetchLatestTag)();
      cache = { ...cache, lastCheckedAt: new Date(now).toISOString(), latestVersion: tag ?? cache?.latestVersion };
      writeCheckCache(cache);
    }
    const tag = cache.latestVersion;
    if (!isStableNewer(tag, this.#o.current) || this.#staged === tag) { this.#watchIdle(); return; }
    if (this.#o.policy() !== "automatic") return;
    if (this.#failed?.tag === tag && now - this.#failed.at < RETRY_AFTER_FAILURE_MS) return;
    // Install only while nothing is running; otherwise try again at the next pass or when work finishes.
    if (this.#o.threadCount() > 0) { this.#schedule(() => void this.#tick(true), WATCH_INTERVAL_MS * 4); return; }
    const result = await this.#ensureInstalled(tag, "automatic");
    if (result.success) this.#watchIdle();
  }

  #ensureInstalled(tag: string, source: "browser" | "automatic"): Promise<AutoUpdateResult> {
    if (this.#staged === tag) return Promise.resolve({ success: true, installed: false, installedVersion: tag });
    if (this.#installing) return this.#installing;
    this.#phase = "installing";
    this.#error = undefined;
    const run = (this.#o.installer ?? performAutoUpdate)({ version: tag, installDir: this.#install.dir, quiet: true });
    const done = run.then(result => {
      if (result.success) { this.#staged = tag; this.#phase = "staged"; this.#failed = null; }
      else {
        this.#phase = "idle"; this.#failed = { tag, at: this.#now() };
        this.#error = result.error ?? "The update could not be installed.";
      }
      audit({ actor: source === "browser" ? "operator (browser)" : "system (automatic updates)", action: "update.install", subject: tag, outcome: result.success ? "ok" : "error", detail: { version: tag.replace(/^v/, ""), source, ...(result.success ? {} : { reason: result.error }) } });
      return result;
    }).finally(() => { this.#installing = null; });
    this.#installing = done;
    return done;
  }

  /** After a release is installed: restart by ourselves once nothing has run for the idle window. Not in server mode, not under a supervisor. */
  #watchIdle(): void {
    if (this.#watching) return;
    this.#watching = true;
    this.#watchStep();
  }

  #watchStep(): void {
    if (!this.#staged || this.#restarted || this.#stopped || this.#o.policy() !== "automatic" || this.#o.serverMode || this.#supervised) { this.#watching = false; return; }
    const now = this.#now();
    if (this.#o.threadCount() > 0) this.#lastBusyAt = now;
    else if (now - this.#lastBusyAt >= (this.#o.idleRestartMs ?? IDLE_RESTART_MS)) {
      this.#watching = false;
      void this.#restartNow("automatic").catch(() => undefined);
      return;
    }
    this.#schedule(() => this.#watchStep(), this.#o.watchIntervalMs ?? WATCH_INTERVAL_MS);
  }

  async #restartNow(source: "browser" | "automatic"): Promise<ApplyResult> {
    const version = this.#staged!.replace(/^v/, "");
    this.#phase = "restarting";
    this.#restarted = true;
    audit({ actor: source === "browser" ? "operator (browser)" : "system (automatic updates)", action: "update.apply", subject: version, detail: { version, source, kind: this.#supervised ? "supervised-exit" : "restart", ...(source === "browser" ? {} : { reason: "idle" }) } });
    // Not through #schedule: stop() (called as the server shuts down) must not cancel the restart that caused it.
    setTimeout(() => this.#o.restart({ version, supervised: this.#supervised }), source === "browser" ? (this.#o.restartDelayMs ?? 500) : 0);
    return { restarting: true, version, supervised: this.#supervised };
  }

  /**
   * Browser-confirmed update: install if needed, then restart. Refuses installs this console cannot replace,
   * a second concurrent request, and running threads unless the person confirmed interrupting them.
   */
  async apply(options: { confirm?: boolean } = {}): Promise<ApplyResult> {
    if (!this.#install.managed) {
      throw new UpdateError(409, "not_managed", this.#install.instruction ?? "This install cannot update itself.", { install: this.#install.kind, instruction: this.#install.instruction });
    }
    if (updatesDisabledByEnvironment(this.#o.env)) throw new UpdateError(409, "updates_disabled", "Updates are disabled by ZERO_OFFLINE or ZERO_NO_UPDATE_CHECK.");
    if (this.#applying || this.#restarted) throw new UpdateError(409, "update_in_progress", "An update is already in progress.");
    const tag = this.#staged ?? readCheckCache()?.latestVersion;
    if (!isStableNewer(tag, this.#o.current)) throw new UpdateError(409, "up_to_date", "0 is already up to date.");
    const threads = this.#o.threadCount();
    if (threads > 0 && options.confirm !== true) {
      throw new UpdateError(409, "threads_running", `${threads} ${threads === 1 ? "thread is" : "threads are"} running. Update after they finish, or update anyway.`, { threads });
    }
    this.#applying = true;
    try {
      const result = await this.#ensureInstalled(tag, "browser");
      if (!result.success) throw new UpdateError(502, "install_failed", result.error ?? "The update could not be installed.");
      return await this.#restartNow("browser");
    } finally { this.#applying = false; }
  }
}
