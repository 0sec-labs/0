import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { classifyFolderError, hasDesktopSession, permissionMessageFor, privacyMessage, privacySubject, type PrivacySubject } from "./workspace-access.js";
import { folderChecks } from "./workspace-folder-check.js";

export { hasDesktopSession };
import { normalizeWorkspaceInput } from "./workspace-input.js";

const PICKER_SCRIPT = `on run argv
  activate
  try
    if (count of argv) > 0 then
      set chosen to choose folder with prompt "Choose the folder where Zero works" default location (POSIX file (item 1 of argv))
    else
      set chosen to choose folder with prompt "Choose the folder where Zero works"
    end if
    return POSIX path of chosen
  on error number -128
    return ""
  end try
end run`;

export interface PickerResult {
  supported: boolean;
  path: string | null;
  /** Plain-words explanation for the operator: why there is no native chooser, or why the choice could not be used. */
  message?: string;
  /** True when the failure is macOS privacy protection, so the UI can offer to open System Settings. */
  privacy?: boolean;
}

export interface PickerProcess { stdout: string; stderr: string; code: number | null; timedOut: boolean; aborted: boolean }
interface PickerDependencies {
  platform?: NodeJS.Platform;
  /** Whether the browser is on the computer that runs the server. Defaults to true for direct callers. */
  local?: boolean;
  /** Whether this server can show windows (a logged-in desktop session). */
  interactive?: () => boolean;
  subject?: PrivacySubject;
  /** Aborting (the operator closed the popover) kills the dialog. */
  signal?: AbortSignal;
  timeoutMs?: number;
  command?: string;
  run?: (command: string, args: string[], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<PickerProcess>;
}
let pickerActive = false;

function runOsascript(command: string, args: string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<PickerProcess> {
  return new Promise((done) => {
    let stdout = "", stderr = "", timedOut = false, aborted = false, settled = false;
    let child: ChildProcess;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort);
      done({ stdout, stderr, code, timedOut, aborted });
    };
    const stop = () => { if (child.exitCode === null) child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2_000).unref(); };
    const onAbort = () => { aborted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    try { child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch (error) { stderr = String((error as Error).message); clearTimeout(timer); return done({ stdout, stderr, code: 127, timedOut, aborted }); }
    child.stdout!.on("data", (chunk: Buffer) => { if (stdout.length < 16_384) stdout += chunk.toString("utf8"); });
    child.stderr!.on("data", (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { stderr += String(error.message); finish(127); });
    child.on("close", (code) => finish(code));
    // A grandchild holding the pipe open must not keep the request waiting once the dialog process itself is gone.
    child.on("exit", (code) => { setTimeout(() => finish(code), 250).unref(); });
    if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const unsupported = (message: string): PickerResult => ({ supported: false, path: null, message });
const failed = (message: string, privacy = false): PickerResult => ({ supported: true, path: null, message, ...(privacy ? { privacy: true } : {}) });

/** Owner-authorized native UI only: choosing a folder does not grant session scope. */
export async function chooseWorkspaceFolder(input?: unknown, dependencies: PickerDependencies = {}): Promise<PickerResult> {
  if (input !== undefined && (typeof input !== "string" || input.length > 4096 || input.includes("\0"))) throw new Error("Enter a valid folder path.");
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin") return { supported: false, path: null };
  if (dependencies.local === false) return unsupported("The folder chooser opens on the computer that runs 0, not on this one. Browse the folders below or enter a path.");
  if (!(dependencies.interactive ?? hasDesktopSession)()) return unsupported("0 is running without a desktop session (for example, started over SSH), so it can't open a folder chooser. Browse the folders below or enter a path.");
  if (pickerActive) return failed("A folder chooser is already open on this Mac. Finish or close it first.");
  pickerActive = true;
  try {
    const args = ["-e", PICKER_SCRIPT];
    if (typeof input === "string" && input.trim()) {
      // A stale or mistyped starting point must not block the chooser; it just opens at its default place.
      const initial = await realpath(resolve(normalizeWorkspaceInput(input))).catch(() => null);
      if (initial && (await stat(initial).catch(() => null))?.isDirectory()) args.push(initial);
    }
    const run = dependencies.run ?? runOsascript;
    const outcome = await run(dependencies.command ?? process.env.ZERO_OSASCRIPT ?? "/usr/bin/osascript", args, { timeoutMs: dependencies.timeoutMs ?? 120_000, ...(dependencies.signal ? { signal: dependencies.signal } : {}) });
    if (outcome.aborted) return { supported: true, path: null };
    const subject = dependencies.subject ?? privacySubject();
    if (outcome.timedOut) return failed("The folder chooser was closed after two minutes without an answer. Try again or enter a folder path.");
    if (outcome.code !== 0) {
      const text = outcome.stderr;
      if (/\(-128\)|User canceled/i.test(text)) return { supported: true, path: null }; // the only silent outcome: the operator cancelled
      if (/\(-174[34]\)|Not authori[sz]ed to send Apple events/i.test(text)) return failed(`macOS didn't let 0 open the folder chooser. Allow ${subject.kind === "app" ? subject.name : `the app that runs 0 (${subject.name})`} under System Settings > Privacy & Security > Automation, then try again. You can also enter a folder path.`, true);
      if (/Operation not permitted|EPERM/i.test(text)) return failed(privacyMessage(null, subject), true);
      return failed("The folder chooser could not complete on this host. Try again or enter a folder path.");
    }
    // osascript appends one record terminator; spaces/newlines in names are data.
    const selected = outcome.stdout.replace(/\r?\n$/, "");
    if (!selected) return { supported: true, path: null };
    if (selected.length > 4096 || selected.includes("\0")) return failed("The folder chooser returned an invalid path.");
    let path: string;
    try {
      path = await realpath(selected);
      if (!(await stat(path)).isDirectory()) return failed("The folder chooser did not return an existing folder.");
    } catch (error) {
      if (classifyFolderError(error) === "permission") return failed(permissionMessageFor(resolve(selected), { subject, error }), (error as NodeJS.ErrnoException).code === "EPERM");
      return failed("The folder chooser did not return an existing folder.");
    }
    // The chooser can pick a folder this server may not read (it runs under the dialog's permissions); check like the engine does.
    // Starts the same non-blocking check the picker polls, so a macOS prompt for this folder appears now and not mid-thread.
    const check = await folderChecks.settled(path, { maxMs: 3_000, subject, canPrompt: dependencies.interactive?.() });
    if (check.state === "blocked" || check.state === "error") return failed(check.message ?? "0 couldn't read that folder. Check that it is available, or choose another folder.", check.privacy);
    return { supported: true, path };
  } finally { pickerActive = false; }
}

