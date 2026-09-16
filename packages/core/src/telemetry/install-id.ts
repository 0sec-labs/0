/**
 * Random install and session identifiers for analytics.
 *
 * The install id is a random UUID minted once and persisted under the 0sec
 * home state dir (`~/.0sec/analytics-id`, reusing `homeStateDir` from
 * `@0sec/shared`). It is not derived from email, hostname, MAC, username or
 * machine id. Authenticated delivery still links records to the caller.
 * The session id is a fresh random UUID per run.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homeStateDir } from "@0sec/shared";

/** File that persists the install id. */
export const INSTALL_ID_FILENAME = "analytics-id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InstallIdOptions {
  /** Override the home directory (tests point this at a tmpdir). */
  homeDir?: string;
}

function installIdPath(homeDir?: string): string {
  return join(homeStateDir(homeDir), INSTALL_ID_FILENAME);
}

/**
 * Return the persistent random install id, minting and persisting one on
 * first call. The file is created 0o600 under a 0o700 state dir. If a stored
 * value is missing or malformed it is regenerated.
 */
export function getInstallId(opts: InstallIdOptions = {}): string {
  const path = installIdPath(opts.homeDir);

  try {
    const existing = readFileSync(path, "utf8").trim();
    if (UUID_RE.test(existing)) return existing;
  } catch {
    // Not yet created (or unreadable) — fall through and mint a new one.
  }

  const id = randomUUID();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${id}\n`, { mode: 0o600 });
  return id;
}

/**
 * A fresh per-run session id. Random only — never derived from anything
 * identifying, and not linked to the install id.
 */
export function newSessionId(): string {
  return randomUUID();
}
