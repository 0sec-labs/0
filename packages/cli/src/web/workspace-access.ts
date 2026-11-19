import { execFileSync } from "node:child_process";
import { opendir } from "node:fs/promises";
import { homedir, platform as osPlatform, userInfo } from "node:os";
import { basename } from "node:path";

/** True when a desktop session can show the chooser. SSH, launchd daemons and tmux started over SSH cannot. */
export function hasDesktopSession(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const manager = execFileSync("/bin/launchctl", ["managername"], { encoding: "utf8", timeout: 1_500, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return manager === "Aqua";
  } catch { return !env.SSH_CONNECTION; }
}

/** What went wrong when the host touched a folder. EPERM/EACCES are the signature of macOS privacy protection (TCC). */
export type FolderFailure = "permission" | "missing" | "timeout" | "other";

export function classifyFolderError(error: unknown): FolderFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EPERM" || code === "EACCES") return "permission";
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  if (code === "ETIMEDOUT" || code === "EAGAIN" || code === "EBUSY") return "timeout";
  return "other";
}

const PROTECTED_HOME_FOLDERS: ReadonlyArray<readonly [string, string]> = [
  ["Desktop", "Desktop"],
  ["Documents", "Documents"],
  ["Downloads", "Downloads"],
  ["Library/Mobile Documents", "iCloud Drive"],
  ["Library/CloudStorage", "cloud storage"],
];

function homes(home: string): string[] {
  const list = new Set([home]);
  try { list.add(userInfo().homedir); } catch { /* no passwd entry */ }
  return [...list];
}

/** Test-only switches (fake protected root, simulated slow or denied probes). Both conditions are required, so a production server ignores them. */
export function testHooksEnabled(): boolean {
  return process.env.NODE_ENV === "test" && process.env.ZERO_TEST_HOOKS === "1";
}

/** The macOS-protected location a path lives in (for the message), or null. Callers pass a realpath. */
export function protectedFolderName(path: string, options: { platform?: NodeJS.Platform; home?: string } = {}): string | null {
  if ((options.platform ?? osPlatform()) !== "darwin") return null;
  const lower = path.toLowerCase();
  const testRoot = testHooksEnabled() ? process.env.ZERO_TEST_PROTECTED_ROOT?.toLowerCase().replace(/\/+$/, "") : undefined;
  if (testRoot && (lower === testRoot || lower.startsWith(testRoot + "/"))) return "Documents";
  for (const home of homes(options.home ?? homedir())) {
    const root = home.replace(/\/+$/, "").toLowerCase() + "/";
    for (const [relative, name] of PROTECTED_HOME_FOLDERS) {
      const folder = root + relative.toLowerCase();
      if (lower === folder || lower.startsWith(folder + "/")) return name;
    }
  }
  if (/^\/volumes\/[^/]+/i.test(path)) return "an external or network drive";
  return null;
}

export interface PrivacySubject { name: string; kind: "app" | "ssh" | "service" | "unknown" }

const KNOWN_TERMINALS = /(Terminal|iTerm2?|Warp|Ghostty|kitty|Alacritty|WezTerm|Hyper|Tabby|Visual Studio Code|Cursor|Claude|Zed|Xcode|Windsurf)/i;

/** Pure part of subject detection so it is testable: pick the app that macOS will hold responsible from a process chain (child first). */
export function subjectFromAncestry(chain: readonly string[]): PrivacySubject {
  for (const command of chain) {
    const app = /\/([^/]+)\.app\//.exec(command)?.[1];
    if (app && !/^(Code Helper|.*Helper)/.test(app) ) return { name: app, kind: "app" };
    if (app) continue;
    const name = basename(command);
    if (/^sshd(-session)?$/.test(name)) return { name: "sshd-keygen-wrapper", kind: "ssh" };
    if (KNOWN_TERMINALS.test(name)) return { name, kind: "app" };
  }
  if (chain.some((command) => basename(command) === "launchd")) return { name: basename(process.execPath), kind: "service" };
  return { name: basename(process.execPath), kind: "unknown" };
}

function processChain(pid: number): string[] {
  const chain: string[] = [];
  let current = pid;
  for (let depth = 0; depth < 16 && current > 1; depth++) {
    try {
      const line = execFileSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(current)], { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      const match = /^(\d+)\s+(.+)$/.exec(line);
      if (!match) break;
      chain.push(match[2]!);
      current = Number(match[1]);
    } catch { break; }
  }
  if (current === 1) chain.push("launchd");
  return chain;
}

let cachedSubject: PrivacySubject | undefined;
/** The app macOS attributes this server's file access to. Cached: the ancestry does not change while we run. */
export function privacySubject(chain?: () => string[]): PrivacySubject {
  if (chain) return subjectFromAncestry(chain());
  try { return (cachedSubject ??= subjectFromAncestry(processChain(process.pid))); } catch { return { name: basename(process.execPath), kind: "unknown" }; }
}

export const PRIVACY_MESSAGE_PREFIX = "macOS is blocking access to";

/** Plain-words guidance for a folder macOS refused to open. Same text for typed paths, the browser and the native chooser. */
export function privacyMessage(folder: string | null, subject: PrivacySubject = privacySubject()): string {
  const place = folder ?? "that folder";
  if (subject.kind === "ssh") return `${PRIVACY_MESSAGE_PREFIX} ${place} because 0 was started over SSH. Under System Settings > Privacy & Security > Full Disk Access, allow ${subject.name}, or start 0 from Terminal on the Mac, then try again.`;
  if (subject.kind === "service") return `${PRIVACY_MESSAGE_PREFIX} ${place} because 0 runs as a background service. Under System Settings > Privacy & Security > Full Disk Access, allow ${subject.name}, then try again.`;
  const who = subject.kind === "app" ? subject.name : `the app that runs 0 (${subject.name})`;
  return `${PRIVACY_MESSAGE_PREFIX} ${place}. Allow ${who} under System Settings > Privacy & Security > Files & Folders (or Full Disk Access), then try again.`;
}

/**
 * macOS privacy protection answers EPERM (and only for its protected places); ordinary file permissions answer EACCES.
 * Only the first gets the Privacy & Security guidance.
 */
export function permissionMessageFor(path: string | null, options: { platform?: NodeJS.Platform; home?: string; subject?: PrivacySubject; error?: unknown } = {}): string {
  const code = (options.error as NodeJS.ErrnoException | undefined)?.code;
  const protectedName = path ? protectedFolderName(path, options) : null;
  if ((options.platform ?? osPlatform()) === "darwin" && (protectedName || code === "EPERM" || code === undefined)) {
    return privacyMessage(protectedName, options.subject);
  }
  return "Zero doesn't have permission to open that folder. Check its permissions or choose another folder.";
}

const PROBE_TIMEOUT_MS = 3_000;

/** `Dir.close()` returns a promise under Node and nothing under Bun (the compiled `0`), so never chain `.catch` on it. */
export async function closeQuietly(handle: { close(): unknown }): Promise<void> {
  try { await handle.close(); } catch { /* already closed */ }
}

/**
 * Opens the folder the way the engine will (opendir plus the first entry) without waiting forever: a slow iCloud or
 * network folder that is merely slow is accepted. Rejects only on a definite permission or existence error.
 */
export async function probeFolderReadable(directory: string, options: { timeoutMs?: number; open?: typeof opendir } = {}): Promise<"readable" | "slow"> {
  const open = options.open ?? opendir;
  let timer: NodeJS.Timeout | undefined;
  const probe = (async () => {
    const handle = await open(directory);
    try { await handle.read(); } finally { await closeQuietly(handle); }
    return "readable" as const;
  })();
  probe.catch(() => undefined);
  const slow = new Promise<"slow">((resolve) => { timer = setTimeout(() => resolve("slow"), options.timeoutMs ?? PROBE_TIMEOUT_MS); timer.unref?.(); });
  try { return await Promise.race([probe, slow]); } finally { clearTimeout(timer); }
}

