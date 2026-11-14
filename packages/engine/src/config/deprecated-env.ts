/**
 * One deprecation mechanism for environment variables that are pure duplicates
 * of another variable. Entry points call `applyEnvAliases()` before any code
 * reads the environment; readers then use only the replacement name.
 */
import { STRICT_FALSY, STRICT_TRUTHY, parseFlag } from "./env.js";

export interface DeprecatedEnvEntry {
  readonly old: string;
  readonly replacement: string;
  /** The replacement is the boolean opposite of the old flag. */
  readonly invert?: boolean;
  readonly note?: string;
}

export const DEPRECATED_ENV: readonly DeprecatedEnvEntry[] = [
  { old: "ZERO_CHATGPT_AUTH_FILE", replacement: "ZERO_CODEX_AUTH_JSON_PATH", note: "Same codex auth.json path, two names." },
  { old: "ZERO_WPSCAN_API_TOKEN", replacement: "WPSCAN_API_TOKEN" },
  { old: "ZERO_SKIP_PROVIDER_BANNER", replacement: "ZERO_SUPPRESS_PROVIDER_STARTUP_LOG" },
] as const;

const warned = new Set<string>();

const STRICT = { falsy: STRICT_FALSY, truthy: STRICT_TRUTHY, unknown: false, trim: true, ignoreCase: true } as const;

/** Map each deprecated variable onto its replacement. Idempotent; never logs values. */
export function applyEnvAliases(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => { process.stderr.write(`${message}\n`); },
): void {
  const quiet = env["ZERO_NO_DEPRECATION_WARNINGS"] !== undefined
    && parseFlag(env["ZERO_NO_DEPRECATION_WARNINGS"], STRICT);
  const notify = (key: string, message: string): void => {
    if (quiet || warned.has(key)) return;
    warned.add(key);
    warn(message);
  };
  for (const { old, replacement, invert } of DEPRECATED_ENV) {
    const raw = env[old];
    if (raw === undefined) continue;
    const mapped = invert ? (parseFlag(raw, STRICT) ? "0" : "1") : raw;
    const current = env[replacement];
    if (current === undefined) {
      env[replacement] = mapped;
      notify(old, `[0] ${old} is deprecated; use ${replacement}.`);
    } else if (current !== mapped) {
      notify(old, `[0] ${old} is deprecated; use ${replacement}. Both are set and differ; using ${replacement}.`);
    } else {
      notify(old, `[0] ${old} is deprecated; use ${replacement}.`);
    }
  }
}
