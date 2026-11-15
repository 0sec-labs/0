// `0 config` — inspect, export, and import the console configuration.
//
// Configuration is TWO-LEVEL (see tui/settings.ts): a per-user GLOBAL file
// (`~/.0/tui-settings.json`) with a per-project OVERRIDE
// (`<cwd>/.0/tui-settings.json`) layered on top, per key, falling through to
// the built-in defaults. This command is the operator surface over that model:
//
//   show           the effective config, each key labelled default/global/project
//   export [file]  write the effective (or --global) config as shareable JSON
//   import <file>  merge a shared config into the global (default) or --project layer
//
// SECURITY: import never silently enables a security-sensitive setting. If an
// imported config would change any Security-group key (allowModelSelfExtension or
// a subagent-messaging toggle), the import is refused unless --yes is passed, and
// the specific change is printed. Unknown keys are dropped, never blindly written,
// and every value is validated via the settings sanitiser/normaliser before it
// lands on disk.

import { readFileSync, writeFileSync } from "node:fs";

import chalk from "chalk";
import type { Command } from "commander";

import {
  DEFAULT_SETTINGS,
  SETTING_DEFS,
  loadGlobalSettings,
  loadLayeredSettings,
  projectSettingsFilePath,
  readProjectOverrides,
  sanitizeOverrides,
  saveProjectOverrides,
  saveSettings,
  settingsFilePath,
  normalizeSettings,
  validSettingValue,
  type SettingLayer,
  type TuiSettings,
} from "../state/settings.js";

const EXIT_OK = 0;
const EXIT_USER_ERROR = 1;

/** Public engine controls with consumers in command/browser sessions. Renderer
 * preferences remain loadable for old files, but are not a CLI configuration API. */
const CLI_CONFIG_KEYS = [
  "busyInputMode", "autoCompaction", "compactionThreshold", "allowSubagentPeerMessaging",
  "allowSubagentOperatorMessaging", "allowModelSelfExtension", "allowDevSourceUpdates",
  "executionProfile", "analyticsLevel", "diagnosticReporting", "updatePolicy",
] as const satisfies readonly (keyof TuiSettings)[];
const PUBLIC_CONFIG_KEYS = new Set<keyof TuiSettings>(CLI_CONFIG_KEYS);
const INTERNAL_CONFIG_KEYS = new Set<keyof TuiSettings>(["onboardingCompleted", "diagnosticReportingPrompted", "modelPreference"]);
function publicConfig(settings: TuiSettings): Partial<TuiSettings> {
  return Object.fromEntries(CLI_CONFIG_KEYS.map(key => [key, settings[key]]));
}

/** The security-sensitive keys, derived from the settings table's Security group
 *  so a new gated setting is covered automatically. */
const SECURITY_KEYS: readonly (keyof TuiSettings)[] = SETTING_DEFS.filter(
  (d) => d.group === "Security",
).map((d) => d.key as keyof TuiSettings);

export interface ConfigCommandDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  homeDir?: string;
  projectDir?: string;
}

function outOf(deps: ConfigCommandDeps): (line: string) => void {
  return deps.out ?? ((l) => console.log(l));
}
function errOf(deps: ConfigCommandDeps): (line: string) => void {
  return deps.err ?? ((l) => console.error(l));
}

function renderValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  // Non-scalar settings (the keybindings overrides map) render as compact JSON
  // rather than "[object Object]".
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ── show ──────────────────────────────────────────────────────────────────────

export function runConfigShow(deps: ConfigCommandDeps = {}): void {
  const out = outOf(deps);
  const { settings, sources } = loadLayeredSettings({
    homeDir: deps.homeDir,
    projectDir: deps.projectDir,
  });

  out(chalk.bold("Effective engine configuration"));
  out(chalk.dim(`  global:  ${settingsFilePath(deps.homeDir)}`));
  out(chalk.dim(`  project: ${projectSettingsFilePath(deps.projectDir)}`));
  out("");
  const keys: readonly (keyof TuiSettings)[] = CLI_CONFIG_KEYS;
  const width = Math.max(...keys.map((k) => k.length));
  for (const key of keys) {
    const layer = sources[key];
    const tag =
      layer === "project"
        ? chalk.cyan("[project]")
        : layer === "global"
          ? chalk.green("[global]")
          : chalk.dim("[default]");
    out(`  ${key.padEnd(width)}  ${renderValue(settings[key]).padEnd(11)} ${tag}`);
  }
  process.exitCode = EXIT_OK;
}

// ── export ──────────────────────────────────────────────────────────────────

export function runConfigExport(
  file: string | undefined,
  deps: ConfigCommandDeps & { global?: boolean } = {},
): void {
  const out = outOf(deps);
  const err = errOf(deps);
  const settings = deps.global
    ? loadGlobalSettings(deps.homeDir)
    : loadLayeredSettings({ homeDir: deps.homeDir, projectDir: deps.projectDir }).settings;

  const json = `${JSON.stringify(publicConfig(settings), null, 2)}\n`;
  if (!file) {
    out(json.trimEnd());
    process.exitCode = EXIT_OK;
    return;
  }
  try {
    writeFileSync(file, json, "utf8");
    out(chalk.green(`Exported ${deps.global ? "global" : "effective"} config to ${file}.`));
    process.exitCode = EXIT_OK;
  } catch (e) {
    err(chalk.red(`Could not write ${file}: ${e instanceof Error ? e.message : String(e)}`));
    process.exitCode = EXIT_USER_ERROR;
  }
}

// ── import ────────────────────────────────────────────────────────────────────

/** Pull the settings bag out of an imported file: a config artifact manifest
 *  (`{ kind: "config", config: {…} }`) or a plain settings object. */
function extractConfigBag(parsed: unknown): unknown {
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).kind === "config" &&
    typeof (parsed as Record<string, unknown>).config === "object"
  ) {
    return (parsed as Record<string, unknown>).config;
  }
  return parsed;
}

export function runConfigImport(
  file: string,
  deps: ConfigCommandDeps & { scope?: Exclude<SettingLayer, "default">; yes?: boolean } = {},
): void {
  const out = outOf(deps);
  const err = errOf(deps);
  const scope: Exclude<SettingLayer, "default"> = deps.scope ?? "global";

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    err(chalk.red(`Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }

  const bag = extractConfigBag(parsed);
  const legacyKeys = typeof bag === "object" && bag !== null && !Array.isArray(bag)
    ? Object.keys(bag).filter(key => Object.hasOwn(DEFAULT_SETTINGS, key) && !PUBLIC_CONFIG_KEYS.has(key as keyof TuiSettings) && !INTERNAL_CONFIG_KEYS.has(key as keyof TuiSettings))
    : [];
  if (legacyKeys.length) {
    err(chalk.red(`Retired terminal settings cannot be imported: ${legacyKeys.join(", ")}. Nothing was written.`));
    err("Use 0 web → Settings for browser appearance. Remove retired keys to import engine settings.");
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  // Drop unknown/invalid keys up front — never blindly overwrite. What survives
  // is a sparse, validated patch of known settings.
  const patch = sanitizeOverrides(bag);
  // Project patches cannot carry operator authority. The global import surface
  // may select this execution boundary only through the security gate below.
  const profile = typeof bag === "object" && bag !== null
    ? (bag as Record<string, unknown>)["executionProfile"]
    : undefined;
  const profileChoices = SETTING_DEFS.find((def) => def.key === "executionProfile")?.choices;
  if (scope === "global" && typeof profile === "string" && profileChoices?.includes(profile)) {
    patch.executionProfile = profile as TuiSettings["executionProfile"];
  }
  for (const key of Object.keys(patch) as (keyof TuiSettings)[]) if (!PUBLIC_CONFIG_KEYS.has(key)) delete patch[key];
  const patchKeys = Object.keys(patch) as (keyof TuiSettings)[];
  const skipped =
    typeof bag === "object" && bag !== null && !Array.isArray(bag)
      ? Object.keys(bag).filter((k) => !patchKeys.includes(k as keyof TuiSettings))
      : [];

  if (patchKeys.length === 0) {
    err(chalk.red(`Nothing to import: ${file} contains no recognised settings.`));
    if (skipped.length > 0) err(chalk.dim(`  Skipped unknown/invalid keys: ${skipped.join(", ")}`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }

  // Diff against the current EFFECTIVE config so the report and the security gate
  // reflect what would actually change.
  const current = loadLayeredSettings({ homeDir: deps.homeDir, projectDir: deps.projectDir }).settings;
  const changes = patchKeys.filter((k) => current[k] !== patch[k]);
  const securityChanges = changes.filter((k) => SECURITY_KEYS.includes(k));

  if (securityChanges.length > 0 && deps.yes !== true) {
    err(chalk.yellow("Refusing to import: this would change security-sensitive settings."));
    for (const k of securityChanges) {
      err(`  ${k}: ${renderValue(current[k])} -> ${renderValue(patch[k])}`);
    }
    err("  Re-run with --yes to accept these changes. Nothing was written.");
    process.exitCode = EXIT_USER_ERROR;
    return;
  }

  // Apply to the chosen layer.
  let saved: boolean;
  if (scope === "global") {
    const merged = normalizeSettings({ ...loadGlobalSettings(deps.homeDir), ...patch });
    saved = saveSettings(merged, deps.homeDir);
  } else {
    const merged = { ...readProjectOverrides(deps.projectDir), ...patch };
    saved = saveProjectOverrides(merged, deps.projectDir);
  }
  if (!saved) {
    err(chalk.red(`Could not write the ${scope} config layer.`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }

  out(chalk.green(`Imported ${changes.length} change(s) into the ${scope} config.`));
  for (const k of changes) {
    const tag = SECURITY_KEYS.includes(k) ? chalk.yellow(" (security)") : "";
    out(`  ${k}: ${renderValue(current[k])} -> ${renderValue(patch[k])}${tag}`);
  }
  if (changes.length === 0) out(chalk.dim("  (all imported values already matched the current config)"));
  if (skipped.length > 0) out(chalk.dim(`  Skipped unknown/invalid keys: ${skipped.join(", ")}`));
  process.exitCode = EXIT_OK;
}

// ── set ───────────────────────────────────────────────────────────────────────

/** Parse a CLI value for a setting: booleans accept on/off/true/false/yes/no; enums are exact. */
function parseSetValue(key: keyof TuiSettings, raw: string): unknown {
  const def = SETTING_DEFS.find((d) => d.key === key);
  const text = raw.trim();
  if (def?.kind === "boolean") {
    const v = text.toLowerCase();
    if (["on", "true", "yes", "1"].includes(v)) return true;
    if (["off", "false", "no", "0"].includes(v)) return false;
    return undefined;
  }
  if (def?.kind === "number") return /^-?\d+$/.test(text) ? Number(text) : undefined;
  // Enums must match a choice exactly (the analyticsLevel loader treats unknown text as `off`).
  if (def?.choices && !def.choices.includes(text)) return undefined;
  return text;
}

/** `0 config set <key> <value>`: change one public operator-global setting. */
export function runConfigSet(
  key: string,
  value: string,
  deps: ConfigCommandDeps & { yes?: boolean } = {},
): void {
  const out = outOf(deps);
  const err = errOf(deps);
  if (!PUBLIC_CONFIG_KEYS.has(key as keyof TuiSettings)) {
    err(chalk.red(`Unknown setting "${key}". Settings you can change: ${CLI_CONFIG_KEYS.join(", ")}.`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  const typedKey = key as keyof TuiSettings;
  const parsed = parseSetValue(typedKey, value);
  const checked = parsed === undefined ? undefined : validSettingValue(typedKey, parsed);
  const patch: Partial<TuiSettings> = checked === undefined ? {} : { [typedKey]: checked };
  if (!(typedKey in patch)) {
    const choices = SETTING_DEFS.find((d) => d.key === typedKey)?.choices;
    err(chalk.red(`"${value}" is not a valid value for ${key}${choices ? ` (use ${choices.join(", ")})` : ""}.`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  const current = loadGlobalSettings(deps.homeDir);
  if (SECURITY_KEYS.includes(typedKey) && deps.yes !== true && current[typedKey] !== patch[typedKey]) {
    err(chalk.yellow(`Refusing to change security-sensitive setting ${key} without --yes. Nothing was written.`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  if (!saveSettings(normalizeSettings({ ...current, ...patch }), deps.homeDir)) {
    err(chalk.red("Could not write the global config."));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  out(chalk.green(`${key}: ${renderValue(current[typedKey])} -> ${renderValue(patch[typedKey])} (global)`));
  process.exitCode = EXIT_OK;
}

// ── commander wiring ───────────────────────────────────────────────────────────

export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description("Inspect, export, and import engine configuration (global and project layers)");

  config
    .command("show")
    .description("Show the effective config with the source layer (default/global/project) per key")
    .action(() => {
      runConfigShow();
    });

  config
    .command("set <key> <value>")
    .description("Change one operator-global setting, e.g. `0 config set analyticsLevel off`")
    .option("--yes", "Accept a change to a security-sensitive setting")
    .action((key: string, value: string, opts: { yes?: boolean }) => {
      runConfigSet(key, value, { yes: opts.yes === true });
    });

  config
    .command("export [file]")
    .description("Write the effective (or --global) config as shareable JSON (stdout if no file)")
    .option("--global", "Export only the global layer instead of the effective config")
    .action((file: string | undefined, opts: { global?: boolean }) => {
      runConfigExport(file, { global: opts.global });
    });

  config
    .command("import <file>")
    .description("Merge a shared config into the global (default) or --project layer")
    .option("--project", "Import into the per-project override instead of the global config")
    .option("--global", "Import into the global config (default)")
    .option("--yes", "Accept changes to security-sensitive settings (required to flip them)")
    .action((file: string, opts: { project?: boolean; global?: boolean; yes?: boolean }) => {
      const scope: Exclude<SettingLayer, "default"> = opts.project ? "project" : "global";
      runConfigImport(file, { scope, yes: opts.yes === true });
    });
}
