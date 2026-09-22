/**
 * Deterministic environment for in-process TUI self-tests.
 *
 * The console reads real state from the operator's machine: `$HOME/.0` for
 * settings, an on-disk sqlite DB, telemetry endpoints, provider credentials.
 * A self-test must depend on none of that, so `withDeterministicEnv` builds a
 * throwaway `$HOME` under the OS tmpdir, seeds a settings file that pins the
 * console into its calmest, most stable shape (reduce-motion on, a known
 * theme), and flips the offline / no-telemetry / test switches the codebase
 * already honours. It returns a `restore()` that puts `process.env` back to
 * exactly what it was and removes the temp tree — so a test leaves the worker
 * process as clean as it found it, which matters because vitest reuses the
 * fork across files.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Env keys this harness owns. Restoring these exactly is what keeps the fork clean. */
const MANAGED_KEYS = [
  "HOME",
  "ZERO_DB_PATH",
  "ZERO_OFFLINE",
  "ZERO_NO_TELEMETRY",
  "ZERO_TUI_TEST",
  "ZERO_TUI_REDUCE_MOTION",
  // The console resolves a registry URL from this; an explicit empty value is a
  // deliberate "no store" so the marketplace route never reaches the network.
  "ZERO_REGISTRY_URL",
  // Belt-and-suspenders: keep the MCP autoloader from trying to connect.
  "ZERO_MCP",
  // The default hosted runtime otherwise reaches cloud.0.ai for health,
  // catalog and balance — and in a networked CI it actually connects, flipping
  // the home between "connecting"/"ready"/"Usage: unavailable" run to run.
  // Pointing the cloud host at an unroutable local port makes every cloud fetch
  // fail FAST and DETERMINISTICALLY, so the home settles into one stable
  // offline state (an interactive composer, "Usage: unavailable").
  "ZERO_CLOUD_HOST",
  "ZERO_CLOUD_TOKEN",
] as const;

export interface DeterministicEnv {
  /** The throwaway home directory (`$HOME`), which owns `.0/tui-settings.json`. */
  homeDir: string;
  /** The sqlite path handed to the console via `ZERO_DB_PATH`. */
  dbPath: string;
  /** Put `process.env` back to its prior state and delete the temp tree. */
  restore: () => void;
}

/** The base settings a self-test wants: no motion and a fixed theme. */
const BASE_SETTINGS: Record<string, unknown> = {
  reduceMotion: true,
  theme: "blue-team",
  // Individual setup scenarios override completion without changing the landing route.
  onboardingCompleted: true,
  // Quiet, deterministic chrome.
  logoAnimation: "off",
  mouseSupport: false,
};

/**
 * Build a deterministic `$HOME` + env and seed the settings file.
 *
 * `overrides` are merged into the seeded settings object (so a scenario can pin
 * a different theme, say), NOT into `process.env`.
 */
export function withDeterministicEnv(
  overrides: Record<string, unknown> = {},
): DeterministicEnv {
  const homeDir = mkdtempSync(join(tmpdir(), "0-tui-"));
  const stateDir = join(homeDir, ".0");
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(homeDir, "0.db");

  const settings = { ...BASE_SETTINGS, ...overrides };
  writeFileSync(
    join(stateDir, "tui-settings.json"),
    JSON.stringify(settings, null, 2) + "\n",
    "utf8",
  );

  // Snapshot every managed key so restore is exact (undefined → delete).
  const prior = new Map<string, string | undefined>();
  for (const key of MANAGED_KEYS) prior.set(key, process.env[key]);

  process.env["HOME"] = homeDir;
  process.env["ZERO_DB_PATH"] = dbPath;
  process.env["ZERO_OFFLINE"] = "1";
  process.env["ZERO_NO_TELEMETRY"] = "1";
  process.env["ZERO_TUI_TEST"] = "1";
  process.env["ZERO_TUI_REDUCE_MOTION"] = "1";
  process.env["ZERO_REGISTRY_URL"] = "";
  process.env["ZERO_MCP"] = "";
  // Unroutable: connection is refused immediately, so cloud state is stable.
  process.env["ZERO_CLOUD_HOST"] = "http://127.0.0.1:9";
  delete process.env["ZERO_CLOUD_TOKEN"];

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; a leftover temp dir is not worth failing a test.
    }
  };

  return { homeDir, dbPath, restore };
}
