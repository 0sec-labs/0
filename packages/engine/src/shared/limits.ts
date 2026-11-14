/**
 * Tunable (non-security) limits behind one resolver.
 *
 * Resolution order, highest first: the environment variable (first of
 * `env` that is set), then the operator setting handed in through
 * `configureLimits`, then the built-in default. The result is always inside
 * [min, max]: a value above `max` is clamped down; a value below `min` or one
 * that is not a number is rejected and falls back (env → setting → default),
 * matching how these knobs behaved before they were centralised.
 *
 * An invalid env value produces one stderr notice per variable per process.
 * The notice names the variable only; the value is never printed.
 *
 * Do NOT register security limits here (scope, admission, protective caps).
 * Settings must only come from the operator's global layer; a project-level
 * file must never be able to call `configureLimits`.
 */
import { DAY_MS, SECOND_MS } from "./units.js";

export interface LimitDefinition {
  readonly key: string;
  /** Environment variable name(s); the first one that is set wins. */
  readonly env: string | readonly string[];
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

const registry = new Map<string, LimitDefinition>();
let configured: Record<string, number> = {};
const noticed = new Set<string>();

export function defineLimit(definition: LimitDefinition): LimitDefinition {
  const { key, min, max } = definition;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max
    || definition.default < min || definition.default > max) {
    throw new RangeError(`Invalid limit definition ${key}`);
  }
  if (registry.has(key)) throw new Error(`Limit ${key} is already defined`);
  const frozen = Object.freeze({ ...definition });
  registry.set(key, frozen);
  return frozen;
}

export function listLimits(): readonly LimitDefinition[] {
  return [...registry.values()];
}

function parse(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.floor(value) : undefined;
}

function accept(limit: LimitDefinition, value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < limit.min) return undefined;
  return Math.min(Math.floor(value), limit.max);
}

/** Installs operator settings keyed by limit key. Invalid entries are dropped. */
export function configureLimits(values: Readonly<Record<string, number | undefined>> = {}): void {
  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) {
    const limit = registry.get(key);
    const accepted = limit && typeof value === "number" ? accept(limit, value) : undefined;
    if (accepted !== undefined) next[key] = accepted;
  }
  configured = next;
}

export function resolveLimit(limit: LimitDefinition, env: NodeJS.ProcessEnv = process.env): number {
  const names = typeof limit.env === "string" ? [limit.env] : limit.env;
  const name = names.find((candidate) => env[candidate] !== undefined);
  const raw = name === undefined ? undefined : env[name]!;
  if (name !== undefined && raw!.trim() !== "") {
    const accepted = accept(limit, parse(raw!));
    if (accepted !== undefined) return accepted;
    if (!noticed.has(name)) {
      noticed.add(name);
      process.stderr.write(`0: ignoring invalid ${name}; using the configured or default value\n`);
    }
  }
  return configured[limit.key] ?? limit.default;
}

/** Test hook: forget injected settings and one-time notices. */
export function resetLimitsForTests(): void {
  configured = {};
  noticed.clear();
}

// ── Registered limits (defaults are the values the readers used before) ──

/** Bash tool wall-clock ceiling. */
export const BASH_TIMEOUT_MS = defineLimit({ key: "exec.bashTimeoutMs", env: "ZERO_BASH_TIMEOUT_MS", default: 120 * SECOND_MS, min: 1, max: DAY_MS });
/** Source-file count above which `review` refuses a target. */
export const REVIEW_MAX_FILES = defineLimit({ key: "review.maxFiles", env: "ZERO_REVIEW_MAX_FILES", default: 5000, min: 1, max: 10_000_000 });
/** Blind-verify agents in flight at once. */
export const VERIFY_CONCURRENCY = defineLimit({ key: "verify.concurrency", env: "ZERO_VERIFY_CONCURRENCY", default: 8, min: 1, max: 1024 });
/** Total attempts for a transient empty LLM stream (1 initial + retries). */
export const LLM_STREAM_MAX_ATTEMPTS = defineLimit({ key: "llm.streamMaxAttempts", env: "ZERO_LLM_STREAM_MAX_ATTEMPTS", default: 3, min: 1, max: 5 });
/** LLM retries after the initial attempt. */
export const LLM_MAX_RETRIES = defineLimit({ key: "llm.maxRetries", env: "ZERO_LLM_MAX_RETRIES", default: 6, min: 0, max: 100 });
/** LLM retries for 429s; falls back to the generic retry variable. */
export const LLM_429_MAX_RETRIES = defineLimit({ key: "llm.maxRetries429", env: ["ZERO_LLM_429_MAX_RETRIES", "ZERO_LLM_MAX_RETRIES"], default: 12, min: 0, max: 100 });
