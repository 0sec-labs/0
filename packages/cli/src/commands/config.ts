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

import { UsageError, exitWhenDone, expectOk, printJson, runConsoleCommand, type ConsoleCommandDeps as ConsoleDeps } from "./console-support.js";

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
  "executionProfile", "approvals", "analyticsLevel", "diagnosticReporting", "updatePolicy",
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

export function runConfigShow(deps: ConfigCommandDeps & { json?: boolean } = {}): void {
  const out = outOf(deps);
  const { settings, sources } = loadLayeredSettings({
    homeDir: deps.homeDir,
    projectDir: deps.projectDir,
  });
  if (deps.json) {
    out(JSON.stringify(Object.fromEntries(CLI_CONFIG_KEYS.map((key) => [key, { value: settings[key], source: sources[key] }])), null, 2));
    process.exitCode = EXIT_OK;
    return;
  }

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

// ── get / set / reset ─────────────────────────────────────────────────────────

function publicKey(key: string): keyof TuiSettings {
  if (!(CLI_CONFIG_KEYS as readonly string[]).includes(key)) throw new UsageError(`Unknown setting "${key}". Run \`0 config list\` for the available keys.`);
  return key as keyof TuiSettings;
}

function parseValue(key: keyof TuiSettings, raw: string): unknown {
  const def = SETTING_DEFS.find((entry) => entry.key === key);
  if (!def) throw new UsageError(`Unknown setting "${key}".`);
  if (def.kind === "boolean") {
    if (/^(on|true|yes|1)$/i.test(raw)) return true;
    if (/^(off|false|no|0)$/i.test(raw)) return false;
    throw new UsageError(`${key} takes on or off.`);
  }
  if (def.kind === "number") {
    if (raw.trim() === "" || !Number.isFinite(Number(raw))) throw new UsageError(`${key} takes a number.`);
    return Number(raw);
  }
  if (def.choices && !def.choices.includes(raw)) throw new UsageError(`${key} takes one of: ${def.choices.join(", ")}.`);
  return raw;
}

export function runConfigGet(key: string, deps: ConfigCommandDeps & { json?: boolean } = {}): void {
  try {
    const name = publicKey(key);
    const { settings, sources } = loadLayeredSettings({ homeDir: deps.homeDir, projectDir: deps.projectDir });
    outOf(deps)(deps.json ? JSON.stringify({ key: name, value: settings[name], source: sources[name] }) : renderValue(settings[name]));
    process.exitCode = EXIT_OK;
  } catch (error) {
    errOf(deps)(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof UsageError ? 2 : EXIT_USER_ERROR;
  }
}

/** Same server-side validation and operator-only rules as the web Settings page (PATCH /settings). */
export function runConfigSet(key: string, value: string, options: { project?: boolean; yes?: boolean; json?: boolean }, deps: ConsoleDeps = {}) {
  return runConsoleCommand(options, deps, async (client, io) => {
    const name = publicKey(key);
    const parsed = parseValue(name, value);
    if (SECURITY_KEYS.includes(name) && options.yes !== true) throw new UsageError(`${name} is a security-sensitive setting. Re-run with --yes to change it.`);
    const data = expectOk(await client.request("PATCH", "/api/console/settings", { key: name, value: parsed, scope: options.project ? "project" : "global" }));
    if (options.json) printJson(io, { key: name, value: data.settings[name], source: data.sources[name], persisted: data.persisted });
    else io.out(`${name} = ${renderValue(data.settings[name])}`);
  });
}

export function runConfigReset(keys: string[], options: { yes?: boolean; json?: boolean }, deps: ConsoleDeps = {}) {
  return runConsoleCommand(options, deps, async (client, io) => {
    const names = keys.length ? keys.map(publicKey) : [...CLI_CONFIG_KEYS];
    if (options.yes !== true) throw new UsageError(`This resets ${keys.length ? names.join(", ") : "all engine settings"} to defaults. Re-run with --yes.`);
    const data = expectOk(await client.request("POST", "/api/console/settings/reset", { keys: names }));
    if (options.json) printJson(io, { reset: names.filter((n) => !(data.preserved ?? []).includes(n)), preserved: data.preserved ?? [], persisted: data.persisted });
    else {
      io.out(`Reset ${names.length - (data.preserved?.length ?? 0)} setting(s) to defaults.`);
      if (data.preserved?.length) io.out(`Kept stricter safety settings: ${data.preserved.join(", ")}`);
    }
  });
}

// ── commander wiring ───────────────────────────────────────────────────────────

export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description("Inspect, export, and import engine configuration (global and project layers)");

  config
    .command("show")
    .description("Show the effective config with the source layer (default/global/project) per key")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => {
      runConfigShow({ json: opts.json });
    });

  config
    .command("list")
    .description("Alias of show")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => {
      runConfigShow({ json: opts.json });
    });

  config
    .command("get <key>")
    .description("Print the effective value of one setting")
    .option("--json", "Print JSON with the source layer")
    .action((key: string, opts: { json?: boolean }) => {
      runConfigGet(key, { json: opts.json });
    });

  config
    .command("set <key> <value>")
    .description("Change one setting (global by default, --project for this folder)")
    .option("--project", "Write the per-project override")
    .option("--yes", "Confirm a security-sensitive setting")
    .option("--json", "Print JSON")
    .action((key: string, value: string, opts: { project?: boolean; yes?: boolean; json?: boolean }) => exitWhenDone(runConfigSet(key, value, opts)));

  config
    .command("reset [keys...]")
    .description("Reset settings to defaults (all engine settings when no key is given)")
    .option("--yes", "Confirm the reset")
    .option("--json", "Print JSON")
    .action((keys: string[], opts: { yes?: boolean; json?: boolean }) => exitWhenDone(runConfigReset(keys, opts)));

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
