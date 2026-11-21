import { spawn } from "node:child_process";
import { opendir } from "node:fs/promises";
import { basename } from "node:path";
import { closeQuietly, classifyFolderError, hasDesktopSession, permissionMessageFor, privacySubject, protectedFolderName, testHooksEnabled, PRIVACY_MESSAGE_PREFIX, type PrivacySubject } from "./workspace-access.js";

/**
 * Non-blocking "can this server read that folder" check.
 *
 * macOS shows its own prompt the first time a process touches Desktop, Documents, Downloads, iCloud Drive or a removable
 * volume, and the call blocks until the owner answers. That is not "a slow folder": accepting it after a timeout tells the
 * owner it worked while the prompt is still open. So a protected location gets its own states (waiting, then a 60 s limit)
 * while an ordinary slow folder (network mount) keeps the accept-after-timeout behaviour.
 *
 * The probe runs in a child process: a read blocked on a pending prompt cannot stall this server, and cancelling kills it.
 */
export type FolderCheckState = "checking" | "waiting" | "allowed" | "blocked" | "timeout" | "error";

export interface FolderCheck {
  state: FolderCheckState;
  path: string;
  /** The protected macOS location the folder lives in (Documents, iCloud Drive, ...), or null. */
  folder: string | null;
  /** Plain-words text for the owner. Absent when the folder is allowed. */
  message?: string;
  /** True when System Settings is the way out, so the UI offers Open Privacy settings. */
  privacy?: boolean;
  /** The app macOS holds responsible; the one to allow in System Settings. */
  app?: string;
  /** False when this server cannot show a macOS prompt (ssh, launchd without a desktop session). */
  canPrompt: boolean;
  elapsedMs: number;
}

export type ProbeResult = { ok: true } | { ok: false; code: string };
export interface ProbeHandle { done: Promise<ProbeResult>; kill(): void }
export type ProbeWorker = (directory: string) => ProbeHandle;

export const PROMPT_AFTER_MS = 1_000;
export const SLOW_ACCEPT_MS = 3_000;
export const GIVE_UP_MS = 60_000;
const ALLOWED_CACHE_MS = 5 * 60_000;
const MAX_ENTRIES = 64;

export const WORKER_SCRIPT = `const fs=require("fs");try{const d=fs.opendirSync(process.argv[1]);try{d.readSync()}finally{d.closeSync()}process.stdout.write("ok")}catch(e){process.stdout.write("err:"+(e&&e.code||"EIO"))}`;

function resultFromOutput(output: string): ProbeResult {
  return output.startsWith("ok") ? { ok: true } : { ok: false, code: output.startsWith("err:") ? output.slice(4) : "EIO" };
}

/** Simulated probe for tests and the dev server. Needs NODE_ENV=test and ZERO_TEST_HOOKS=1, so production ignores it. */
function simulatedProbe(): ProbeWorker | null {
  if (!testHooksEnabled() || process.env.ZERO_TEST_PROBE_DELAY_MS === undefined) return null;
  const delay = Math.max(0, Number(process.env.ZERO_TEST_PROBE_DELAY_MS) || 0);
  return (directory) => {
    let timer: NodeJS.Timeout | undefined;
    const done = new Promise<ProbeResult>((resolve) => {
      timer = setTimeout(() => resolve(process.env.ZERO_TEST_PROBE_RESULT === "deny" || basename(directory).startsWith("denied") ? { ok: false, code: "EPERM" } : { ok: true }), delay);
    });
    return { done, kill: () => clearTimeout(timer) };
  };
}

/** Real probe: opendir plus the first entry, the way the engine's tools open a folder, in a child process. */
export const childProcessProbe: ProbeWorker = (directory) => {
  const simulated = simulatedProbe();
  if (simulated) return simulated(directory);
  let killed = false;
  let child: ReturnType<typeof spawn> | undefined;
  const done = new Promise<ProbeResult>((resolve) => {
    const inProcess = () => {
      void (async () => {
        try { const handle = await opendir(directory); try { await handle.read(); } finally { await closeQuietly(handle); } resolve({ ok: true }); }
        catch (error) { resolve({ ok: false, code: (error as NodeJS.ErrnoException).code ?? "EIO" }); }
      })();
    };
    try {
      child = spawn(process.execPath, ["-e", WORKER_SCRIPT, directory], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    } catch { inProcess(); return; }
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { output += chunk; });
    child.once("error", () => { if (!killed) inProcess(); });
    child.once("close", () => {
      if (killed || child?.exitCode === null) return;
      // No output means the child never ran the probe. A compiled `0` is its own program and has no `-e`
      // (it prints "unknown option '-e'" and exits), and a failed exec looks the same. That says nothing
      // about the folder, so look at it from this process rather than call it unreadable.
      if (!output) { inProcess(); return; }
      resolve(resultFromOutput(output));
    });
  });
  return { done, kill: () => { killed = true; try { child?.kill("SIGKILL"); } catch { /* already gone */ } } };
};

export interface FolderCheckDependencies {
  worker?: ProbeWorker;
  now?: () => number;
  canPrompt?: () => boolean;
  subject?: () => PrivacySubject;
  platform?: NodeJS.Platform;
  home?: string;
}

interface Entry {
  path: string;
  folder: string | null;
  startedAt: number;
  handle?: ProbeHandle;
  terminal?: FolderCheck;
  finishedAt?: number;
  timer?: NodeJS.Timeout;
  waiters: Array<(check: FolderCheck) => void>;
  canPrompt: boolean;
  subject: PrivacySubject;
}

export class FolderCheckRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #deps: FolderCheckDependencies;
  constructor(deps: FolderCheckDependencies = {}) { this.#deps = deps; }

  #now() { return (this.#deps.now ?? Date.now)(); }

  #snapshot(entry: Entry, local = true): FolderCheck {
    if (entry.terminal) return { ...entry.terminal, elapsedMs: (entry.finishedAt ?? this.#now()) - entry.startedAt };
    const elapsedMs = this.#now() - entry.startedAt;
    const base = { path: entry.path, folder: entry.folder, canPrompt: entry.canPrompt, app: entry.subject.name, elapsedMs };
    if (entry.folder && elapsedMs >= PROMPT_AFTER_MS) {
      if (!entry.canPrompt) return { ...base, state: "waiting", privacy: true, message: noPromptMessage(entry.folder, entry.subject) };
      const where = local ? "the dialog that appeared" : "the dialog on the Mac that runs 0";
      return { ...base, state: "waiting", message: `Waiting for macOS: click Allow in ${where} (${entry.folder}).` };
    }
    return { ...base, state: "checking", message: "Checking the folder…" };
  }

  #finish(entry: Entry, check: Omit<FolderCheck, "elapsedMs" | "path" | "folder" | "canPrompt">) {
    if (entry.terminal) return;
    clearTimeout(entry.timer);
    entry.finishedAt = this.#now();
    entry.terminal = { path: entry.path, folder: entry.folder, canPrompt: entry.canPrompt, app: entry.subject.name, elapsedMs: entry.finishedAt - entry.startedAt, ...check };
    for (const waiter of entry.waiters.splice(0)) waiter(this.#snapshot(entry));
  }

  #classify(entry: Entry, result: ProbeResult) {
    if (result.ok) return this.#finish(entry, { state: "allowed" });
    const error = { code: result.code };
    const failure = classifyFolderError(error);
    if (failure === "permission") {
      const message = entry.folder && !entry.canPrompt ? noPromptMessage(entry.folder, entry.subject) : permissionMessageFor(entry.path, { error, subject: entry.subject, ...(this.#deps.platform ? { platform: this.#deps.platform } : {}), ...(this.#deps.home ? { home: this.#deps.home } : {}) });
      return this.#finish(entry, { state: "blocked", message, privacy: message.startsWith(PRIVACY_MESSAGE_PREFIX) || message.startsWith("macOS can only ask") });
    }
    if (failure === "missing") return this.#finish(entry, { state: "error", message: "That folder doesn't exist. Check the path, or choose a folder from the list." });
    // A timeout-like errno is a slow folder, not a refusal.
    if (failure === "timeout") return this.#finish(entry, { state: "allowed" });
    return this.#finish(entry, { state: "error", message: "Zero couldn't read that folder. Check that it is available, or choose another folder." });
  }

  /** Starts a check (or joins the one running) and returns its current state without waiting. `retry` re-probes a finished refusal. */
  check(directory: string, options: { retry?: boolean; local?: boolean; canPrompt?: boolean; subject?: PrivacySubject } = {}): FolderCheck {
    const existing = this.#entries.get(directory);
    if (existing) {
      const fresh = existing.terminal && existing.terminal.state !== "allowed" && options.retry;
      const stale = existing.terminal?.state === "allowed" && this.#now() - (existing.finishedAt ?? 0) > ALLOWED_CACHE_MS;
      if (!fresh && !stale) return this.#snapshot(existing, options.local);
      this.cancel(directory);
    }
    const folder = protectedFolderName(directory, { ...(this.#deps.platform ? { platform: this.#deps.platform } : {}), ...(this.#deps.home ? { home: this.#deps.home } : {}) });
    const entry: Entry = {
      path: directory, folder, startedAt: this.#now(), waiters: [],
      canPrompt: options.canPrompt ?? (this.#deps.canPrompt ?? hasDesktopSession)(),
      subject: options.subject ?? (this.#deps.subject ?? privacySubject)(),
    };
    this.#prune();
    this.#entries.set(directory, entry);
    entry.handle = (this.#deps.worker ?? childProcessProbe)(directory);
    void entry.handle.done.then((result) => this.#classify(entry, result), () => this.#finish(entry, { state: "error", message: "Zero couldn't read that folder. Check that it is available, or choose another folder." }));
    // Protected: stop waiting after a minute. Ordinary: a slow mount is accepted after a few seconds.
    entry.timer = setTimeout(() => {
      entry.handle?.kill();
      if (entry.folder) this.#finish(entry, { state: "timeout", message: `macOS is still waiting for your answer about ${entry.folder}. Click Allow in the dialog on the Mac, or choose Retry.` });
      else this.#finish(entry, { state: "allowed" });
    }, entry.folder ? GIVE_UP_MS : SLOW_ACCEPT_MS);
    entry.timer.unref?.();
    return this.#snapshot(entry, options.local);
  }

  /** Resolves when the check reaches a final state, or with the in-progress state after `maxMs`. */
  settled(directory: string, options: { maxMs?: number; retry?: boolean; canPrompt?: boolean; subject?: PrivacySubject } = {}): Promise<FolderCheck> {
    const first = this.check(directory, options);
    const entry = this.#entries.get(directory);
    if (!entry || entry.terminal) return Promise.resolve(first);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter = (check: FolderCheck) => { clearTimeout(timer); resolve(check); };
      entry.waiters.push(waiter);
      if (options.maxMs !== undefined) {
        timer = setTimeout(() => {
          const index = entry.waiters.indexOf(waiter);
          if (index >= 0) entry.waiters.splice(index, 1);
          resolve(this.#snapshot(entry));
        }, options.maxMs);
        timer.unref?.();
      }
    });
  }

  /** The owner left the picker: stop probing so no prompt is left dangling for a folder nobody is choosing. */
  cancel(directory: string): void {
    const entry = this.#entries.get(directory);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (!entry.terminal) entry.handle?.kill();
    this.#entries.delete(directory);
    for (const waiter of entry.waiters.splice(0)) waiter({ path: entry.path, folder: entry.folder, canPrompt: entry.canPrompt, state: "error", message: "The check was cancelled.", elapsedMs: this.#now() - entry.startedAt });
  }

  /** Forget every finished result (tests, and a changed privacy setting). */
  clearFinished(): void {
    for (const [path, entry] of this.#entries) if (entry.terminal) this.#entries.delete(path);
  }

  #prune() {
    if (this.#entries.size < MAX_ENTRIES) return;
    for (const [path, entry] of this.#entries) { if (entry.terminal) { this.#entries.delete(path); if (this.#entries.size < MAX_ENTRIES) return; } }
  }
}

/** Plain words for a host that cannot show a macOS prompt. */
export function noPromptMessage(folder: string, subject: PrivacySubject): string {
  const who = subject.name;
  return `macOS can only ask on the Mac's screen, and 0 wasn't started from a desktop session, so no dialog can appear for ${folder}. Sit at that Mac and start 0 from Terminal, or grant Full Disk Access to ${who} under System Settings > Privacy & Security.`;
}

/** The text the first thread shows when the working folder is blocked. */
export function blockedAtThreadStart(check: FolderCheck): string {
  const message = check.message ?? "";
  const named = basename(check.path) || check.path;
  const rest = message.indexOf(". ");
  return message.startsWith(PRIVACY_MESSAGE_PREFIX) && rest > 0 ? `macOS blocked access to ${named}. ${message.slice(rest + 2)}` : message;
}

export const folderChecks = new FolderCheckRegistry();
