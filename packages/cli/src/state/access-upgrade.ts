import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homeStateDir } from "@0/engine/shared";

/**
 * One-time upgrade note for the move to one mode. Threads and Agents always have shell access;
 * limits are scope, budget and the sandbox. The first start after upgrade records how many
 * Agents and threads already existed (one audit entry) and shows ONE dismissible notice next
 * to the setting. Nothing stored is rewritten here.
 */
export interface AccessUpgradeState { recordedAt: string; agents: number; threads: number; dismissed: boolean }
export type AccessUpgradeNotice = Pick<AccessUpgradeState, "agents" | "threads">;

const file = (home?: string): string => join(home ?? homeStateDir(), "access-upgrade.json");

export function readAccessUpgrade(home?: string): AccessUpgradeState | undefined {
  try {
    const value = JSON.parse(readFileSync(file(home), "utf8")) as Partial<AccessUpgradeState>;
    return typeof value.recordedAt === "string" && typeof value.agents === "number" && typeof value.threads === "number" ? { recordedAt: value.recordedAt, agents: value.agents, threads: value.threads, dismissed: value.dismissed === true } : undefined;
  } catch { return undefined; }
}
function write(state: AccessUpgradeState, home?: string): void {
  try { mkdirSync(dirname(file(home)), { recursive: true }); writeFileSync(file(home), JSON.stringify(state), { mode: 0o600 }); } catch { /* The note is advisory; never block startup. */ }
}

/** First start only: record the counts. Returns true when this call recorded them (and the caller should audit). */
export function recordAccessUpgrade(counts: AccessUpgradeNotice, home?: string, now: () => Date = () => new Date()): boolean {
  if (readAccessUpgrade(home)) return false;
  write({ recordedAt: now().toISOString(), agents: counts.agents, threads: counts.threads, dismissed: counts.agents + counts.threads === 0 }, home);
  return true;
}
export function accessUpgradeNotice(home?: string): AccessUpgradeNotice | undefined {
  const state = readAccessUpgrade(home);
  return state && !state.dismissed && state.agents + state.threads > 0 ? { agents: state.agents, threads: state.threads } : undefined;
}
export function dismissAccessUpgrade(home?: string): void {
  const state = readAccessUpgrade(home);
  if (state && !state.dismissed) write({ ...state, dismissed: true }, home);
}
