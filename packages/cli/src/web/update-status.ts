import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "@0/engine/shared";
import { compareVersions } from "../utils/update-check.js";
import { detectInstallKind, type InstallInfo, type InstallKind } from "../utils/install-origin.js";

/** idle: nothing in progress. installing: downloading and verifying. staged: installed on disk, waiting for a restart. restarting: the server is going down to start the new version. */
export type UpdatePhase = "idle" | "installing" | "staged" | "restarting";

export interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  url: string;
  /** Which kind of install this is, so the console offers only what can work. */
  install: { kind: InstallKind; managed: boolean; instruction?: string };
  /** True when this console can update and restart itself (a managed binary install). */
  canApply: boolean;
  phase: UpdatePhase;
  /** Threads (and automations) running now; an update restarts the server and interrupts them. */
  threadsRunning: number;
  /** A supervisor (launchd, systemd, pm2) restarts the process; the console exits instead of starting itself again. */
  supervised: boolean;
  serverMode: boolean;
  error?: string;
}

const RELEASES = "https://github.com/0sec-labs/0security/releases";
type Policy = "off" | "notify" | "automatic";

function disabled(value: string | undefined): boolean {
  return value !== undefined && !["", "0", "false"].includes(value.toLowerCase());
}

/** The tag the CLI's own check last saw. Read-only: this never fetches or writes. */
function cachedLatest(stateDir: string): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(stateDir, "last-update-check"), "utf8"));
    const tag = raw && typeof raw === "object" ? (raw as Record<string, unknown>).latestVersion : undefined;
    return typeof tag === "string" ? tag : null;
  } catch { return null; }
}

export interface UpdateStatusOptions {
  current: string;
  policy: Policy;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  install?: InstallInfo;
  /** Version installed on disk and waiting for a restart (a newer release than `latest` is never hidden). */
  staged?: string | null;
  phase?: UpdatePhase;
  threadsRunning?: number;
  supervised?: boolean;
  serverMode?: boolean;
  /** Whether a caller that can restart this process is attached. */
  restartable?: boolean;
  error?: string;
}

/**
 * Update status for the console, derived only from the cache the update check keeps. Nothing is
 * reported when the policy is off or updates are disabled by environment, and prereleases never qualify.
 */
export function readUpdateStatus(options: UpdateStatusOptions): UpdateStatus {
  const env = options.env ?? process.env;
  const install = options.install ?? detectInstallKind();
  const base: UpdateStatus = {
    current: options.current, latest: null, available: false, url: `${RELEASES}/latest`,
    install: { kind: install.kind, managed: install.managed, ...(install.instruction ? { instruction: install.instruction } : {}) },
    canApply: false, phase: options.phase ?? "idle", threadsRunning: options.threadsRunning ?? 0,
    supervised: options.supervised ?? false, serverMode: options.serverMode ?? false,
    ...(options.error ? { error: options.error } : {}),
  };
  if (options.policy === "off" || disabled(env.ZERO_OFFLINE) || disabled(env.ZERO_NO_UPDATE_CHECK)) return base;
  const tag = options.staged ?? cachedLatest(options.stateDir ?? homeStateDir());
  const match = tag ? /^v?(\d+\.\d+\.\d+)$/.exec(tag) : null;
  if (!match) return base;
  const latest = match[1]!;
  if (compareVersions(latest, options.current) <= 0) return { ...base, latest, phase: "idle" };
  return { ...base, latest, available: true, url: `${RELEASES}/tag/v${latest}`, canApply: install.managed && options.restartable === true };
}
