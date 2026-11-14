/**
 * Separate team capacity from the number of simultaneous model requests.
 *
 * Resolution order, highest first: the ZERO_SUBAGENT_* environment variable
 * (an explicit override; malformed values are rejected), then the operator
 * setting handed in through `configureSubagentLimits`, then the built-in default.
 */
export const SUBAGENT_LIMIT_DEFAULTS = { concurrency: 32, maxDepth: 8, fanOut: 1024 } as const;
export interface SubagentLimitSettings { concurrency?: number; maxDepth?: number; fanOut?: number }

let configured: SubagentLimitSettings = {};

/** Installs the operator's settings (already validated and clamped by the settings layer). */
export function configureSubagentLimits(limits: SubagentLimitSettings = {}): void {
  const pick = (value: number | undefined) => (Number.isSafeInteger(value) && (value as number) >= 1 ? value : undefined);
  configured = { concurrency: pick(limits.concurrency), maxDepth: pick(limits.maxDepth), fanOut: pick(limits.fanOut) };
}

function positiveInteger(name: string, setting: number | undefined, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return setting ?? fallback;
  const value = Number(raw);
  if (!raw.trim() || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
export const subagentBatchLimit = () => positiveInteger("ZERO_SUBAGENT_MAX_FANOUT", configured.fanOut, SUBAGENT_LIMIT_DEFAULTS.fanOut);
export const subagentWorkerLimit = () => positiveInteger("ZERO_SUBAGENT_MAX_WORKERS", undefined, 4096);
export const subagentConcurrency = () => positiveInteger("ZERO_SUBAGENT_CONCURRENCY", configured.concurrency, SUBAGENT_LIMIT_DEFAULTS.concurrency);
export const subagentDepthLimit = () => positiveInteger("ZERO_SUBAGENT_MAX_DEPTH", configured.maxDepth, SUBAGENT_LIMIT_DEFAULTS.maxDepth);
