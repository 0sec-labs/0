import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { homeStateDir } from "@0/engine/shared";
import { parseFlag, type FlagParseOptions } from "@0/engine";
import { loadLayeredSettings } from "../state/settings.js";
import { terminalProgress } from "./terminal-progress.js";

import { defaultInstallDir, isNpmStyleInstall, NPM_MIGRATION_HINT } from "./install-origin.js";

const REPO = "0sec-labs/0security";
/** The slug before the rename. GitHub redirects it today; it is only a fallback if that ever stops. */
const LEGACY_REPO = "0sec-labs/0";
/** Numeric repository id: survives any future rename. */
const REPO_ID = 1339271188;
const INSTALL_URLS = [REPO, LEGACY_REPO].map(slug => `https://raw.githubusercontent.com/${slug}/main/install.sh`);
/**
 * Test and mirror override: one origin that serves `/latest` (release JSON), `/install.sh` and
 * `/releases/download/<tag>/<asset>`. Unset in normal use. It can only redirect where this user's own
 * updates come from, which anyone who controls this process environment could already do.
 */
function updateOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env["ZERO_UPDATE_ORIGIN"]?.trim().replace(/\/+$/, "");
  return value && /^https?:\/\//.test(value) ? value : undefined;
}
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_000;
const INSTALL_TIMEOUT_MS = 120_000;

export type UpdatePolicy = "off" | "notify" | "automatic";
interface NotifyOptions { policy?: UpdatePolicy }
interface AutoUpdateOptions {
  version?: string;
  installDir?: string;
  /** Overall installer deadline, bounded by the normal two-minute limit. */
  timeoutMs?: number;
  /** No terminal output and no inherited stdio: for the web console and other background callers. */
  quiet?: boolean;
}
export interface AutoUpdateResult {
  success: boolean;
  installed: boolean;
  installedVersion?: string;
  error?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
}
export interface CheckCache {
  lastCheckedAt: string;
  latestVersion?: string;
  lastInstallAttemptAt?: string;
  lastInstallTag?: string;
}
interface Version {
  parts: number[];
  prerelease: string[];
  complete: boolean;
}

function parseVersion(value: string): Version | null {
  if (value.length > 128) return null;
  const match = /^v?(0|[1-9]\d*)(?:\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?)?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  if (!parts.every(Number.isSafeInteger)) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return { parts, prerelease, complete: match[3] !== undefined };
}

/** Invalid versions never qualify as a newer release. Build metadata is ignored. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length ? -1 : right.prerelease.length ? 1 : 0;
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln !== rn) return ln ? -1 : 1;
    if (ln && l.length !== r.length) return l.length < r.length ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

const LEGACY_DISABLE_FLAG: FlagParseOptions = { falsy: ["", "0", "false"], unknown: true, ignoreCase: true };

function disabled(value: string | undefined): boolean {
  return value !== undefined && parseFlag(value, LEGACY_DISABLE_FLAG);
}

export function shouldRunCheck(
  env: NodeJS.ProcessEnv = process.env,
  isTty = Boolean(process.stdout.isTTY),
  policy?: UpdatePolicy,
): boolean {
  if (!isTty || disabled(env.CI) || disabled(env["ZERO_OFFLINE"]) || disabled(env["ZERO_NO_UPDATE_CHECK"])) return false;
  if (policy !== undefined) return policy !== "off";
  return env["ZERO_UPDATE_CHECK"] === "1";
}

function recent(timestamp: string | undefined, now: number): boolean {
  const age = now - Date.parse(timestamp ?? "");
  return Number.isFinite(age) && age >= 0 && age < CHECK_INTERVAL_MS;
}

export function readCheckCache(): CheckCache | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(homeStateDir(), "last-update-check"), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (typeof value.lastCheckedAt !== "string") return null;
    return {
      lastCheckedAt: value.lastCheckedAt,
      latestVersion: typeof value.latestVersion === "string" ? value.latestVersion : undefined,
      lastInstallAttemptAt: typeof value.lastInstallAttemptAt === "string" ? value.lastInstallAttemptAt : undefined,
      lastInstallTag: typeof value.lastInstallTag === "string" ? value.lastInstallTag : undefined,
    };
  } catch { return null; }
}

export function writeCheckCache(cache: CheckCache): void {
  try {
    mkdirSync(homeStateDir(), { recursive: true });
    writeFileSync(join(homeStateDir(), "last-update-check"), JSON.stringify(cache));
  } catch { /* An unwritable cache must not prevent the requested command. */ }
}

interface LatestSource { url: string; kind: "api" | "redirect" }

/**
 * Newest first. The web redirect needs no API quota (unauthenticated API calls are limited to 60 an hour per
 * address), the id URL keeps working after a rename.
 */
const DEFAULT_LATEST_SOURCES: readonly LatestSource[] = [
  { url: `https://api.github.com/repos/${REPO}/releases/latest`, kind: "api" },
  { url: `https://github.com/${REPO}/releases/latest`, kind: "redirect" },
  { url: `https://api.github.com/repositories/${REPO_ID}/releases/latest`, kind: "api" },
  { url: `https://api.github.com/repos/${LEGACY_REPO}/releases/latest`, kind: "api" },
];

function latestSources(): readonly LatestSource[] {
  const origin = updateOrigin();
  return origin ? [{ url: `${origin}/latest`, kind: "api" }] : DEFAULT_LATEST_SOURCES;
}

function stableTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const version = parseVersion(value);
  return version?.complete && version.prerelease.length === 0 ? value : null;
}

async function fetchTagFrom(source: LatestSource, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(source.url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "@0/cli/update-check" },
      redirect: source.kind === "redirect" ? "manual" : "follow",
      signal: controller.signal,
    });
    if (source.kind === "redirect") {
      const location = response.headers.get("location") ?? "";
      return stableTag(/\/releases\/tag\/([^/?#]+)$/.exec(location)?.[1]);
    }
    if (!response.ok) return null;
    const data = await response.json() as { tag_name?: unknown; prerelease?: unknown; draft?: unknown };
    return data.prerelease === true || data.draft === true ? null : stableTag(data.tag_name);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/** The newest stable release tag, or null when every source fails (offline, rate limited, outage). Never throws. */
export async function fetchLatestTag(sources: readonly LatestSource[] = latestSources(), timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  for (const source of sources) {
    const tag = await fetchTagFrom(source, timeoutMs);
    if (tag) return tag;
  }
  return null;
}

let installInProgress = false;
const attemptedAutomaticTags = new Set<string>();

/** One canonical installer, shared by explicit upgrade and startup auto-update. */
export async function performAutoUpdate(options: AutoUpdateOptions = {}): Promise<AutoUpdateResult> {
  if (process.platform === "win32") return { success: false, installed: false, error: "Automatic installation is unavailable on Windows; download a release from https://github.com/0sec-labs/0security/releases/latest." };
  if (disabled(process.env["ZERO_OFFLINE"]) || disabled(process.env["ZERO_NO_UPDATE_CHECK"])) {
    return { success: false, installed: false, error: "Updates are disabled by the current offline/update policy." };
  }
  if (installInProgress) return { success: false, installed: false, error: "An update is already in progress." };
  installInProgress = true;
  try {
    const tag = options.version ?? await fetchLatestTag();
    const version = tag ? parseVersion(tag) : null;
    if (!tag || !version?.complete) return { success: false, installed: false, error: "Could not resolve a valid release tag." };
    const normalizedTag = tag.startsWith("v") ? tag : `v${tag}`;
    const origin = updateOrigin();
    const installerUrls = origin ? [`${origin}/install.sh`, `${origin}/install.sh`] : INSTALL_URLS;
    const env: NodeJS.ProcessEnv = { ...process.env, RELEASE_BASE_URL: origin ? `${origin}/releases/download/${normalizedTag}` : `https://github.com/${REPO}/releases/download/${normalizedTag}` };
    const installDir = options.installDir ?? process.env["ZERO_INSTALL_DIR"] ?? defaultInstallDir();
    if (installDir !== undefined) env.INSTALL_DIR = installDir;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
      ? Math.min(options.timeoutMs!, INSTALL_TIMEOUT_MS) : INSTALL_TIMEOUT_MS;
    return await new Promise<AutoUpdateResult>((resolve) => {
      const interactive = !options.quiet && Boolean(process.stderr.isTTY && process.env["TERM"] !== "dumb");
      const progress = interactive ? terminalProgress(`Updating 0 to ${normalizedTag}`) : undefined;
      // bash, not /bin/sh: dash does not implement pipefail. Every descendant
      // belongs to this process group so the deadline stops the whole pipeline.
      // The script is fetched whole from the first URL that answers, so a failed first attempt cannot leave a partial script.
      const fetchAndRun = 's=$(curl -fsSL --connect-timeout 10 --max-time 30 "$1") || s=$(curl -fsSL --connect-timeout 10 --max-time 30 "$2") || exit 22; printf "%s\\n" "$s" | bash';
      const child = spawn("bash", ["-o", "pipefail", "-c", fetchAndRun, "0-update", ...installerUrls], {
        stdio: interactive ? ["inherit", "pipe", "pipe"] : options.quiet ? ["ignore", "pipe", "pipe"] : "inherit", env, detached: true,
      });
      let details = "";
      let pendingLine = "";
      const report = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        details = (details + text).slice(-16_384);
        const lines = (pendingLine + text).split(/[\r\n]/);
        pendingLine = lines.pop()!.slice(-2048);
        const stage = lines.filter(line => line.trim()).at(-1);
        if (stage) progress?.update(stage);
      };
      child.stdout?.on("data", report);
      child.stderr?.on("data", report);
      let timedOut = false;
      let settled = false;
      let parentSignal: NodeJS.Signals | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: AutoUpdateResult) => {
        if (settled) return;
        settled = true;
        progress?.finish(result.success ? `✓ Installed ${normalizedTag}` : result.signal ? "Update cancelled." : "Update failed.");
        // Keep actionable installer errors and optional-companion warnings visible.
        if (interactive && details && (!result.success || /0 installer:|Could not update/.test(details))) process.stderr.write(details.endsWith("\n") ? details : `${details}\n`);
        clearTimeout(timer);
        clearTimeout(killTimer);
        process.removeListener("SIGINT", onInterrupt);
        process.removeListener("SIGTERM", onTerminate);
        resolve(result);
      };
      const terminate = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try { process.kill(-child.pid, signal); } catch { /* The owned process group already exited. */ }
      };
      const interrupt = (signal: NodeJS.Signals) => {
        if (parentSignal || settled) return;
        parentSignal = signal;
        clearTimeout(timer);
        terminate(signal);
        clearTimeout(killTimer);
        killTimer = setTimeout(() => {
          terminate("SIGKILL");
          finish({ success: false, installed: false, signal, error: `Installer stopped by ${signal}.` });
        }, 1_000);
      };
      const onInterrupt = () => interrupt("SIGINT");
      const onTerminate = () => interrupt("SIGTERM");
      const timer = setTimeout(() => {
        timedOut = true;
        terminate("SIGTERM");
        killTimer = setTimeout(() => {
          terminate("SIGKILL");
          finish({ success: false, installed: false, exitCode: 1, error: `Installer exceeded its ${timeoutMs}ms deadline.` });
        }, 1_000);
      }, timeoutMs);
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onTerminate);
      child.once("error", error => finish({ success: false, installed: false, exitCode: 1, error: `Could not start the installer: ${error.message}. Ensure bash and curl are available.` }));
      child.once("close", (code, signal) => {
        if (timedOut || parentSignal) return;
        if (signal) finish({ success: false, installed: false, signal, error: `Installer stopped by ${signal}.` });
        else if (code === 0) finish({ success: true, installed: true, installedVersion: normalizedTag, exitCode: 0 });
        else finish({ success: false, installed: false, exitCode: code ?? 1, error: `Installer exited with code ${code ?? 1}.` });
      });
    });
  } catch (error) {
    return { success: false, installed: false, exitCode: 1, error: error instanceof Error ? error.message : "Update failed." };
  } finally { installInProgress = false; }
}

/** Notify asynchronously, or await this function when automatic is explicit. */
async function maybeNotifyUpdate(currentVersion: string, options: NotifyOptions = {}): Promise<void> {
  const policy = options.policy;
  if (!shouldRunCheck(process.env, Boolean(process.stdout.isTTY), policy) || !parseVersion(currentVersion)) return;
  const now = Date.now();
  let cache = readCheckCache();
  if (!cache || !recent(cache.lastCheckedAt, now)) {
    const tag = await fetchLatestTag();
    cache = { ...cache, lastCheckedAt: new Date(now).toISOString(), latestVersion: tag ?? cache?.latestVersion };
    writeCheckCache(cache);
  }
  const tag = cache.latestVersion;
  const candidate = tag ? parseVersion(tag) : null;
  if (!tag || !candidate?.complete || candidate.prerelease.length > 0 || compareVersions(tag, currentVersion) <= 0) return;
  if (policy !== "automatic" || isNpmStyleInstall()) {
    process.stderr.write(`[0] Update available: ${currentVersion} → ${tag}. Run 0 doctor upgrade.\n`);
    if (isNpmStyleInstall()) process.stderr.write(`[0] ${NPM_MIGRATION_HINT}\n`);
    return;
  }
  if (attemptedAutomaticTags.has(tag) || (cache.lastInstallTag === tag && recent(cache.lastInstallAttemptAt, now))) return;
  attemptedAutomaticTags.add(tag);
  writeCheckCache({ ...cache, lastInstallTag: tag, lastInstallAttemptAt: new Date(now).toISOString() });
  if (!process.stderr.isTTY || process.env["TERM"] === "dumb") process.stderr.write(`[0] Updating to ${tag} before starting 0…\n`);
  const result = await performAutoUpdate({ version: tag });
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.stderr.write(result.success
    ? `[0] Installed ${result.installedVersion}. This process is still ${currentVersion}; restart to use the update.\n`
    : `[0] Update not installed: ${result.error ?? "unknown error"} Continuing with ${currentVersion}.\n`);
}

/**
 * Automatic is the default. Only an explicit global choice can turn it down; project settings can never
 * change the policy, so an install that never chose follows the default (including after this default moved).
 */
export function resolveUpdatePolicy(): UpdatePolicy {
  const { settings, sources } = loadLayeredSettings();
  return sources.updatePolicy === "global" ? settings.updatePolicy : "automatic";
}

/** Environment switches that disable every update lookup and install, whatever the policy. */
export function updatesDisabledByEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return disabled(env["ZERO_OFFLINE"]) || disabled(env["ZERO_NO_UPDATE_CHECK"]);
}

export function isStableNewer(tag: string | null | undefined, current: string): tag is string {
  const candidate = tag ? parseVersion(tag) : null;
  return Boolean(tag && candidate?.complete && candidate.prerelease.length === 0 && compareVersions(tag, current) > 0);
}

/** Awaited at the entry point: the automatic policy (the default) delays startup while it installs. */
export async function runStartupUpdate(version: string): Promise<void> {
  if (!shouldRunCheck(process.env, Boolean(process.stdout.isTTY), "notify")) return;
  const policy = resolveUpdatePolicy();
  if (policy === "automatic") await maybeNotifyUpdate(version, { policy });
  else if (policy !== "off") void maybeNotifyUpdate(version, { policy });
}
