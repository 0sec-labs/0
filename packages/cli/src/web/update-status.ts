import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "@0/engine/shared";
import { compareVersions } from "../utils/update-check.js";

export interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  url: string;
}

const RELEASES = "https://github.com/0sec-labs/0/releases";
type Policy = "off" | "notify" | "automatic";

function disabled(value: string | undefined): boolean {
  return value !== undefined && !["", "0", "false"].includes(value.toLowerCase());
}

/** The tag the CLI's own daily check last saw. Read-only: this never fetches or writes. */
function cachedLatest(stateDir: string): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(stateDir, "last-update-check"), "utf8"));
    const tag = raw && typeof raw === "object" ? (raw as Record<string, unknown>).latestVersion : undefined;
    return typeof tag === "string" ? tag : null;
  } catch { return null; }
}

/**
 * Update status for the console, derived only from the cache the CLI update check already keeps. Nothing is
 * reported when the policy is off or updates are disabled by environment, and prereleases never qualify.
 */
export function readUpdateStatus(options: { current: string; policy: Policy; env?: NodeJS.ProcessEnv; stateDir?: string }): UpdateStatus {
  const env = options.env ?? process.env;
  const none = { current: options.current, latest: null, available: false, url: `${RELEASES}/latest` };
  if (options.policy === "off" || disabled(env.ZERO_OFFLINE) || disabled(env.ZERO_NO_UPDATE_CHECK)) return none;
  const tag = cachedLatest(options.stateDir ?? homeStateDir());
  const match = tag ? /^v?(\d+\.\d+\.\d+)$/.exec(tag) : null;
  if (!match) return none;
  const latest = match[1]!;
  if (compareVersions(latest, options.current) <= 0) return { ...none, latest };
  return { current: options.current, latest, available: true, url: `${RELEASES}/tag/v${latest}` };
}
