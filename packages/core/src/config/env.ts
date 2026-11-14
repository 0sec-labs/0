/**
 * Single environment-variable parsing helper.
 *
 * `envFlag` is the strict, general-purpose boolean reader: '0', 'false', 'off',
 * 'no' and '' are false; '1', 'true', 'on', 'yes' are true (case-insensitive,
 * trimmed); anything else, and an unset variable, yields the default.
 *
 * `parseFlag` is the lower-level primitive for call sites that historically
 * accepted a different value set (for example "anything but 0/false is on").
 * Those sites pass their exact legacy sets so migration does not change
 * which inputs they accept.
 */

export interface FlagParseOptions {
  /** Values (after optional trim/lowercase) that mean false. */
  readonly falsy: readonly string[];
  /** Values that mean true. Unlisted values resolve to `unknown`. */
  readonly truthy?: readonly string[];
  /** Result for a value in neither set. */
  readonly unknown: boolean;
  /** Trim surrounding whitespace before matching. */
  readonly trim?: boolean;
  /** Lowercase before matching. */
  readonly ignoreCase?: boolean;
}

export const STRICT_FALSY = ["0", "false", "off", "no", ""] as const;
export const STRICT_TRUTHY = ["1", "true", "on", "yes"] as const;

export function parseFlag(raw: string, options: FlagParseOptions): boolean {
  let value = options.trim ? raw.trim() : raw;
  if (options.ignoreCase) value = value.toLowerCase();
  if (options.falsy.includes(value)) return false;
  if (options.truthy?.includes(value)) return true;
  return options.unknown;
}

export function envFlag(
  name: string,
  defaultValue: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[name];
  if (raw === undefined) return defaultValue;
  return parseFlag(raw, { falsy: STRICT_FALSY, truthy: STRICT_TRUTHY, unknown: defaultValue, trim: true, ignoreCase: true });
}

export function envInt(
  name: string,
  defaultValue: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name]?.trim();
  if (!raw || !/^[+-]?\d+$/.test(raw)) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : defaultValue;
}

export function envString(
  name: string,
  defaultValue: string,
  env?: NodeJS.ProcessEnv,
): string;
export function envString(
  name: string,
  defaultValue?: undefined,
  env?: NodeJS.ProcessEnv,
): string | undefined;
export function envString(
  name: string,
  defaultValue?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : defaultValue;
}
