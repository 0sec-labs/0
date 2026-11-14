/**
 * User-configurable display settings for the interactive console, persisted
 * to `~/.0/tui-settings.json`.
 *
 * The trigger was "let me hide the status bar", but a single boolean would
 * have been the wrong shape: every chrome element in the TUI (logo, hints,
 * turn summaries, timestamps, subagent list) is something somebody wants
 * gone, and adding a bespoke flag per element means a new persistence path,
 * a new default, and a new migration each time. So the settings are a *table*
 * — `SETTING_DEFS` — and everything else (the settings UI, `/settings`
 * toggling, normalisation of a file on disk) is driven off that table. Adding
 * a toggle is one entry plus one field on `TuiSettings`, and the tests refuse
 * to let those two drift apart.
 *
 * Two hard rules follow from where this code runs. First, the file is
 * user-visible and therefore hand-editable and therefore corruptible:
 * `normalizeSettings` is total, accepting literally any parsed JSON value and
 * always producing a complete, valid object, so a stray comma or a `true`
 * where a string belongs degrades to a default instead of crashing a session.
 * Second, this runs inside a TUI that owns the terminal — nothing here may
 * print, and nothing here may throw on an I/O failure, because a read-only
 * `$HOME` is an inconvenience, not a reason to lose the console.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { DEFAULT_ALLOW_MODEL_SELF_EXTENSION, homeStateDir } from "@0/engine/shared";

type SettingKind = "boolean" | "enum" | "number" | "text";

export interface SettingDef<T = unknown> {
  key: string;
  label: string;
  description: string;
  kind: SettingKind;
  default: T;
  /** Allowed values for kind === "enum". */
  choices?: readonly string[];
  /** Grouping label for the settings UI, e.g. "Display". */
  group: string;
  /** Inclusive bounds and step for kind === "number" (integers only). */
  min?: number;
  max?: number;
  step?: number;
  /** Maximum length for kind === "text". */
  maxLength?: number;
}

/** One operator choice, bound to the connection on which it was applied. */
export interface ModelPreference {
  providerId: string;
  model: string;
  connectionIdentity: string;
  cyberAccessProgram?: "standard" | "daybreak_blue" | "daybreak_red";
}

export interface TuiSettings {
  /** Show the active subagent list while workers run. */
  showSubagents: boolean;
  /** Relative timestamps on transcript entries. */
  showTimestamps: boolean;
  /** Density of the transcript: "comfortable" adds blank lines. */
  density: "comfortable" | "compact";
  /** Whether follow-up input steers the main turn or waits for it to finish. */
  busyInputMode: "steer" | "queue";
  /** Internal first-use state, persisted only in the operator's global layer. */
  onboardingCompleted: boolean;
  /** Operator-global execution boundary; never granted by a project checkout. */
  executionProfile: "local" | "smolvm";
  /** Let sibling subagents message each other directly (child↔child channel). */
  allowSubagentPeerMessaging: boolean;
  /** Let a subagent send a message to the operator's transcript (child→operator). */
  allowSubagentOperatorMessaging: boolean;
  /** How a tool/subagent call is drawn (failures always show). */
  toolCardStyle: "rail" | "inline" | "compact" | "hidden";
  /**
   * Transcript detail. "collapsed" folds each turn's successful tool calls and
   * reasoning into one-line summaries so the transcript reads as input + answer;
   * "expanded" shows every detail. Failures are never folded. Consumed by
   * chat-screen's transcript planner.
   */
  transcriptDetail: "collapsed" | "expanded";
  /**
   * Automatically summarise older turns when the conversation nears the model's
   * context window. Read by the context-compaction path (Stream B); this module
   * only declares it.
   */
  autoCompaction: boolean;
  /**
   * How full the context window gets before auto-compaction runs. Consumed
   * alongside `autoCompaction` by the compaction path (Stream B).
   */
  compactionThreshold: "70%" | "75%" | "80%" | "85%";
  /** Let the model add tools to its own session (off by default). */
  allowModelSelfExtension: boolean;
  /**
   * Dev-only: rebuild the engine from own source and hand off the live console
   * session. Separate from sandboxed tool extension; requires trusted host code.
   */
  allowDevSourceUpdates: boolean;
  /**
   * Per-turn "in→out tok" line under each answer. Consumed by chat-screen's
   * per-message footer (wired by the coordinator); this module only declares it.
   */
  showTokenUsage: boolean;
  /** Estimated dollar cost — per turn (chat-screen) and in the bottom bar. */
  showCost: boolean;
  /** Visual context-usage meter (a compact bar + percent) in the bottom bar. */
  showContextMeter: boolean;
  /**
   * Turn timer in the bottom bar: "left" shows a compact clock-glyphed elapsed
   * time next to the left spinner icon; "off" hides it. An enum (rather than a
   * boolean) leaves room for a future "right" placement once the bar grows a
   * right cluster. chat-screen gates the bar's `turnElapsedMs` on this.
   */
  elapsedTimer: "left" | "off";
  /**
   * Operator-global consent for pseudonymous usage metrics; sharing is opt-in.
   * Explicit environment restrictions and saved opt-outs remain effective.
   * Problem-report preferences are independent; a project cannot widen either.
   */
  analyticsLevel: "off" | "usage";
  /** Operator-global consent; a project must never enable diagnostic egress. */
  diagnosticReporting: "off" | "ask" | "automatic";
  /** Internal first-use state, not a grant of reporting consent. */
  diagnosticReportingPrompted: boolean;
  /** Operator-global update policy; unset installations use automatic updates. */
  updatePolicy: "off" | "notify" | "automatic";
  /** Operator-only: provider, model and connection are replaced as one value. */
  modelPreference: ModelPreference | null;
  /** Subagents running at once. Env ZERO_SUBAGENT_CONCURRENCY wins; a project may only lower it. */
  subagentConcurrency: number;
  /** Nested subagent depth. Env ZERO_SUBAGENT_MAX_DEPTH wins; a project may only lower it. */
  subagentMaxDepth: number;
  /** Tasks accepted in one fan-out call. Env ZERO_SUBAGENT_MAX_FANOUT wins; a project may only lower it. */
  subagentFanOut: number;
  /** Operator guidance appended to the auto-title prompt (redaction unchanged). */
  titleInstructions: string;
  /** Archive saved sessions idle longer than this many days at startup; 0 is off. Operator-only. */
  archiveIdleDays: number;
}

/** Keys of `TuiSettings` holding a bounded integer. */
type NumberKey = "subagentConcurrency" | "subagentMaxDepth" | "subagentFanOut" | "archiveIdleDays";
/** Keys of `TuiSettings` holding free text. */
type TextKey = "titleInstructions";
export const MAX_TITLE_INSTRUCTIONS = 500;
/** Higher values are the sensitive direction: a project checkout may only lower these. */
const LIMIT_KEYS: readonly NumberKey[] = ["subagentConcurrency", "subagentMaxDepth", "subagentFanOut"];

/** Keys of `TuiSettings` whose value is a boolean. */
type BooleanKey = {
  [K in keyof TuiSettings]: TuiSettings[K] extends boolean ? K : never;
}[keyof TuiSettings];

/** Keys of `TuiSettings` whose value is one of a fixed set of strings.
 *  `keybindings` is neither boolean nor a fixed-choice enum — it is a bespoke
 *  chord-override map validated by its own path (see its field doc) — so it is
 *  excluded here rather than forced into the enum contract. */
type EnumKey = Exclude<keyof TuiSettings, BooleanKey | NumberKey | TextKey | "modelPreference">;

interface BooleanSettingDef extends SettingDef<boolean> {
  key: BooleanKey;
  kind: "boolean";
  choices?: undefined;
}

interface EnumSettingDef<K extends EnumKey = EnumKey> extends SettingDef<TuiSettings[K]> {
  key: K;
  kind: "enum";
  /** Non-optional here even though `SettingDef` allows it: an enum without
   *  choices cannot be normalised or cycled, so the table may not contain one. */
  choices: readonly TuiSettings[K][];
}

interface NumberSettingDef extends SettingDef<number> {
  key: NumberKey;
  kind: "number";
  choices?: undefined;
  min: number;
  max: number;
  step: number;
}

interface TextSettingDef extends SettingDef<string> {
  key: TextKey;
  kind: "text";
  choices?: undefined;
  maxLength: number;
}

type TuiSettingDef =
  | BooleanSettingDef
  | NumberSettingDef
  | TextSettingDef
  | EnumSettingDef<"density">
  | EnumSettingDef<"toolCardStyle">
  | EnumSettingDef<"transcriptDetail">
  | EnumSettingDef<"compactionThreshold">
  | EnumSettingDef<"elapsedTimer">
  | EnumSettingDef<"busyInputMode">
  | EnumSettingDef<"analyticsLevel">
  | EnumSettingDef<"diagnosticReporting">
  | EnumSettingDef<"updatePolicy">
  | EnumSettingDef<"executionProfile">;

/**
 * The narrowly-typed table. `SETTING_DEFS` re-exports it under the public,
 * deliberately loose `SettingDef` type; internally we keep the literal key and
 * value types so the compiler — not a test — catches a typo in a choice list.
 */
const DEFS: readonly TuiSettingDef[] = [
  {
    key: "showSubagents",
    label: "Subagent list",
    description: "List the active subagents while workers are running.",
    kind: "boolean",
    default: true,
    group: "Transcript",
  },
  {
    key: "showTimestamps",
    label: "Timestamps",
    description: "Relative timestamps on transcript entries.",
    kind: "boolean",
    default: false,
    group: "Transcript",
  },
  {
    key: "density",
    label: "Density",
    description: 'Transcript spacing: "comfortable" adds blank lines between entries.',
    kind: "enum",
    default: "comfortable",
    choices: ["comfortable", "compact"],
    group: "Display",
  },
  {
    key: "busyInputMode",
    label: "Busy input",
    description: "Queue waits for the current turn without interrupting its agents. Steer interrupts the turn before sending the follow-up and may stop agents linked to that turn.",
    kind: "enum",
    default: "queue",
    choices: ["steer", "queue"],
    group: "Display",
  },
  {
    key: "allowSubagentPeerMessaging",
    label: "Subagent peer messaging",
    description:
      "A subagent runs attacker-influenced code, so a direct sibling channel is how one compromised subagent reaches another's context.",
    kind: "boolean",
    default: true,
    group: "Security",
  },
  {
    key: "allowSubagentOperatorMessaging",
    label: "Subagent messages to you",
    description:
      "Messages arrive in your transcript sanitized and attributed, but a compromised subagent can use this channel to say things to you.",
    kind: "boolean",
    default: true,
    group: "Security",
  },
  {
    key: "toolCardStyle",
    label: "Tool card",
    description: "How a tool or subagent call is drawn: compact, rail, inline or hidden (failures always show).",
    kind: "enum",
    default: "compact",
    choices: ["compact", "rail", "inline", "hidden"],
    group: "Display",
  },
  {
    key: "transcriptDetail",
    label: "Transcript detail",
    description: "Fold tool and reasoning steps. Click a card to see more.",
    kind: "enum",
    default: "collapsed",
    choices: ["collapsed", "expanded"],
    group: "Transcript",
  },
  {
    key: "autoCompaction",
    label: "Auto-compaction",
    description: "Summarize older turns when the context window gets full.",
    kind: "boolean",
    default: true,
    group: "Context",
  },
  {
    key: "compactionThreshold",
    label: "Compaction threshold",
    description: "How full the context window gets before auto-compaction runs.",
    kind: "enum",
    default: "80%",
    choices: ["70%", "75%", "80%", "85%"],
    group: "Context",
  },
  {
    key: "allowModelSelfExtension",
    label: "Model self-extension",
    description: "Let new missions add sandboxed tools. Missions started with this off stay off. Trusted tool code also needs workspace trust; engine updates are a separate setting.",
    kind: "boolean",
    default: DEFAULT_ALLOW_MODEL_SELF_EXTENSION,
    group: "Security",
  },
  {
    key: "allowDevSourceUpdates",
    label: "Development engine updates",
    description: "0dev only. Reload changed engine code between turns. Runs with full access to this machine, including your credentials; separate from sandboxed tools.",
    kind: "boolean",
    default: false,
    group: "Security",
  },
  {
    key: "showTokenUsage",
    label: "Token usage",
    description: 'Per-turn "in→out tok" line under each answer.',
    kind: "boolean",
    default: true,
    group: "Telemetry",
  },
  {
    key: "showCost",
    label: "Cost",
    description: "Estimated dollar cost, per turn and in the status bar.",
    kind: "boolean",
    default: true,
    group: "Telemetry",
  },
  {
    key: "showContextMeter",
    label: "Context meter",
    description: "Visual context-usage bar in the status bar.",
    kind: "boolean",
    default: true,
    group: "Telemetry",
  },
  {
    key: "elapsedTimer",
    label: "Elapsed timer",
    description: "Show how long the current turn has been running.",
    kind: "enum",
    default: "left",
    choices: ["left", "off"],
    group: "Telemetry",
  },
  {
    key: "analyticsLevel",
    label: "Data sharing",
    description: "Usage shares pseudonymous counts, timing, cost and error types, never code or tool content. Off sends nothing. Environment opt-outs win. Applies to this computer.",
    kind: "enum",
    default: "usage",
    choices: ["off", "usage"],
    group: "Privacy",
  },
  {
    key: "diagnosticReporting",
    label: "Problem reports",
    description: "Review error reports before sending, send automatically, or keep them local. Needs a configured destination; separate from usage sharing. Applies to this computer.",
    kind: "enum",
    default: "ask",
    choices: ["off", "ask", "automatic"],
    group: "Privacy",
  },
  {
    key: "updatePolicy",
    label: "Updates",
    description: "Off, notify about new releases, or install updates at startup. Applies to this computer; project settings can't turn on installing.",
    kind: "enum",
    default: "automatic",
    choices: ["off", "notify", "automatic"],
    group: "Updates",
  },
  {
    key: "executionProfile",
    label: "Execution profile",
    description: "SmolVM runs everything (agents, browser, shell) in the online Kali workbench. Set it up with 0 workbench setup. Applies to this computer on next launch; failures never fall back to running on your machine.",
    kind: "enum",
    default: "local",
    choices: ["local", "smolvm"],
    group: "Security",
  },
  {
    key: "subagentConcurrency",
    label: "Concurrent subagents",
    description: "How many subagents run at once. Environment ZERO_SUBAGENT_CONCURRENCY overrides it; a project may only lower it.",
    kind: "number",
    default: 32,
    min: 1,
    max: 128,
    step: 1,
    group: "Agents",
  },
  {
    key: "subagentMaxDepth",
    label: "Nested subagent depth",
    description: "How deeply subagents may start further subagents. Environment ZERO_SUBAGENT_MAX_DEPTH overrides it; a project may only lower it.",
    kind: "number",
    default: 8,
    min: 1,
    max: 16,
    step: 1,
    group: "Agents",
  },
  {
    key: "subagentFanOut",
    label: "Subagents per call",
    description: "Maximum tasks in one parallel subagent call. Environment ZERO_SUBAGENT_MAX_FANOUT overrides it; a project may only lower it.",
    kind: "number",
    default: 1024,
    min: 1,
    max: 4096,
    step: 1,
    group: "Agents",
  },
  {
    key: "titleInstructions",
    label: "Title instructions",
    description: "Guidance for automatic conversation titles, such as a language or style. Credentials are still redacted.",
    kind: "text",
    default: "",
    maxLength: MAX_TITLE_INSTRUCTIONS,
    group: "Conversations",
  },
  {
    key: "archiveIdleDays",
    label: "Archive idle conversations",
    description: "At startup, archive saved conversations idle for more than this many days. 0 keeps everything. Applies to this computer.",
    kind: "number",
    default: 0,
    min: 0,
    max: 365,
    step: 1,
    group: "Conversations",
  },
];

export const SETTING_DEFS: readonly SettingDef[] = DEFS;

const DEF_BY_KEY = new Map<string, TuiSettingDef>(DEFS.map((def) => [def.key, def]));

export const DEFAULT_SETTINGS: TuiSettings = {
  showSubagents: true,
  showTimestamps: false,
  density: "comfortable",
  busyInputMode: "queue",
  onboardingCompleted: false,
  executionProfile: "local",
  allowSubagentPeerMessaging: true,
  allowSubagentOperatorMessaging: true,
  toolCardStyle: "compact",
  transcriptDetail: "collapsed",
  autoCompaction: true,
  compactionThreshold: "80%",
  allowModelSelfExtension: DEFAULT_ALLOW_MODEL_SELF_EXTENSION,
  allowDevSourceUpdates: false,
  showTokenUsage: true,
  showCost: true,
  showContextMeter: true,
  elapsedTimer: "left",
  analyticsLevel: "usage",
  diagnosticReporting: "ask",
  diagnosticReportingPrompted: false,
  updatePolicy: "automatic",
  modelPreference: null,
  subagentConcurrency: 32,
  subagentMaxDepth: 8,
  subagentFanOut: 1024,
  titleInstructions: "",
  archiveIdleDays: 0,
};

/** Basename of the settings file inside the 0 state directory. */
const SETTINGS_FILENAME = "tui-settings.json";

/**
 * Settings live beside the rest of the per-user engine state (scan DB,
 * journals, credentials) rather than in a TUI-specific directory, so
 * `homeStateDir` from `@0/engine/shared` — not a local `".0"` literal — decides
 * where that is. One definition of the state root means a future relocation or
 * an `$XDG_STATE_HOME` migration happens in one place.
 */
export function settingsFilePath(homeDir?: string): string {
  return join(homeStateDir(homeDir), SETTINGS_FILENAME);
}

/**
 * Two-level configuration: a per-user GLOBAL file and a per-project OVERRIDE.
 *
 * The global file (`~/.0/tui-settings.json`) is the base. A project may add a
 * local `<cwd>/.0/tui-settings.json` whose SET keys override the global ones;
 * a key absent from the project file falls through to global, and a key absent
 * from both falls through to the built-in default. Precedence, highest first:
 *
 *     project  >  global  >  default
 *
 * The layering is resolved per KEY, not per file: a project file that sets only
 * `density` overrides only the density and leaves every other key to the global
 * layer. And it is total — a corrupt project file (bad JSON, wrong shape) or a
 * single out-of-range value degrades to the lower layer instead of crashing.
 */
export type SettingLayer = "default" | "global" | "project";

/** The `.0` directory inside a project working tree. */
function projectStateDir(projectDir: string = process.cwd()): string {
  return join(projectDir, ".0");
}

/** The per-project override settings file (may not exist; that is the norm). */
export function projectSettingsFilePath(projectDir: string = process.cwd()): string {
  return join(projectStateDir(projectDir), SETTINGS_FILENAME);
}

/** Read + parse a settings file into a raw value, or `undefined`. Never throws:
 *  a missing/unreadable/malformed file is simply "no layer here". */
function readRawSettingsFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** True when a project override file exists and parses to an object we can layer
 *  over. Used to decide the default write target. */
export function projectSettingsExist(projectDir: string = process.cwd()): boolean {
  const raw = readRawSettingsFile(projectSettingsFilePath(projectDir));
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/**
 * Strict per-key extractor: the valid value this key holds in `raw`, or
 * `undefined` when the key is absent or its value is not valid for the key. This
 * is what makes the layering per-key — a layer "has" a key only when it carries
 * a usable value for it, so an invalid project value falls through to global
 * rather than masking it.
 */
function strictValueAt<K extends keyof TuiSettings>(raw: unknown, key: K): TuiSettings[K] | undefined {
  const value = rawValue(raw, key);
  if (value === undefined) return undefined;
  if (key === "onboardingCompleted" || key === "diagnosticReportingPrompted") {
    return typeof value === "boolean" ? (value as TuiSettings[K]) : undefined;
  }
  if (value === false && (key === "diagnosticReporting" || key === "updatePolicy")) {
    return "off" as TuiSettings[K];
  }
  if (key === "modelPreference") {
    return normalizeModelPreference(value) as TuiSettings[K] | undefined;
  }
  const def = DEF_BY_KEY.get(key);
  if (def?.kind === "boolean") {
    return typeof value === "boolean" ? (value as TuiSettings[K]) : undefined;
  }
  if (def?.kind === "number") return clampInteger(value, def) as TuiSettings[K] | undefined;
  if (def?.kind === "text") return cleanText(value, def.maxLength) as TuiSettings[K] | undefined;
  const choices: readonly string[] = def?.choices ?? [];
  return typeof value === "string" && choices.includes(value)
    ? (value as TuiSettings[K])
    : undefined;
}

/** Round and clamp a finite number into the def's range; anything else is "absent". */
function clampInteger(value: unknown, def: NumberSettingDef): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(def.max, Math.max(def.min, Math.round(value)));
}

/** Strip control characters, trim, and cap length; non-strings are "absent". */
function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, maxLength);
}

export interface LayeredSettings {
  /** The effective, fully-populated, valid settings object. */
  settings: TuiSettings;
  /** Which layer each key's effective value came from. */
  sources: Record<keyof TuiSettings, SettingLayer>;
}

/**
 * Settings a repository checkout may never set on the operator's behalf.
 *
 * Both halves of this list are load-bearing and neither side's list is
 * sufficient alone. A project-level settings file that could set
 * `diagnosticReporting`, `analyticsLevel` or `updatePolicy` would let a
 * checked-in file turn on telemetry egress (or broaden what it authorizes) or
 * automatic update installation for anyone who opens that
 * repository — a privilege the repository does not have. One that could set
 * `onboardingCompleted` would suppress first-use consent the operator has not
 * actually given. Both are the same class of escalation: the project claiming
 * a decision that belongs to the person at the keyboard.
 *
 * `allowDevSourceUpdates` is operator-only because it gates loading and
 * executing user-owned source code from disk, which a project checkout must
 * never enable on the operator's behalf without explicit consent.
 */
export function isOperatorSetting(key: keyof TuiSettings): boolean {
  return key === "onboardingCompleted"
    || key === "analyticsLevel"
    || key === "diagnosticReporting"
    || key === "diagnosticReportingPrompted"
    || key === "updatePolicy"
    || key === "allowDevSourceUpdates"
    || key === "executionProfile"
    || key === "archiveIdleDays"
    || key === "modelPreference";
}

/**
 * Resolve two raw layers (already parsed) plus the built-in defaults into the
 * effective settings and per-key provenance. Pure and total.
 */
export function resolveLayeredSettings(globalRaw: unknown, projectRaw: unknown): LayeredSettings {
  const settings = {} as Record<string, unknown>;
  const sources = {} as Record<keyof TuiSettings, SettingLayer>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof TuiSettings)[]) {
    const globalValue = strictValueAt(globalRaw, key);
    let projectValue: unknown = isOperatorSetting(key) ? undefined : strictValueAt(projectRaw, key);
    // A checkout may only tighten resource limits, never raise them above the operator's choice.
    if (typeof projectValue === "number" && (LIMIT_KEYS as readonly string[]).includes(key)
      && projectValue >= ((globalValue as number | undefined) ?? (DEFAULT_SETTINGS[key] as number))) projectValue = undefined;
    if (projectValue !== undefined) {
      settings[key] = projectValue;
      sources[key] = "project";
      continue;
    }
    if (globalValue !== undefined) {
      settings[key] = globalValue;
      sources[key] = "global";
      continue;
    }
    settings[key] = DEFAULT_SETTINGS[key];
    sources[key] = "default";
  }
  return { settings: settings as unknown as TuiSettings, sources };
}

/**
 * Load the effective settings AND their provenance, merging the project override
 * over the global file over the defaults.
 */
export function loadLayeredSettings(opts: { homeDir?: string; projectDir?: string } = {}): LayeredSettings {
  const globalRaw = readRawSettingsFile(settingsFilePath(opts.homeDir));
  const projectRaw = readRawSettingsFile(projectSettingsFilePath(opts.projectDir));
  return resolveLayeredSettings(globalRaw, projectRaw);
}

/** Reads `key` off a raw object, tolerating any value shape. */
function rawValue(raw: unknown, key: string): unknown {
  // Arrays and `null` are typeof "object" too; neither can carry our keys, and
  // treating them as an empty bag is exactly the "fall back to defaults"
  // behaviour we want rather than a special case.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = (raw as Record<string, unknown>)[key];
  // Legacy content-sharing grants narrow to usage metrics. Refusals and malformed
  // saved values remain explicit opt-outs rather than an unset setup decision.
  if (key === "analyticsLevel" && value !== undefined) {
    return value === "usage" || value === "commands" || value === "full" ? "usage" : "off";
  }
  // A persisted `messenger` comes from installed 0.16.3, whose default it was.
  // The canonical union does not carry that name, so the value is migrated to
  // its equivalent rather than failing validation: dropping it would silently
  // reset a preference every 0.16.3 operator currently has written to disk,
  // and rejecting it would invalidate the whole settings layer over one key.
  return key === "transcriptStyle" && value === "messenger" ? "bubble" : value;
}

function booleanAt(raw: unknown, key: BooleanKey): boolean {
  const value = rawValue(raw, key);
  return typeof value === "boolean" ? value : DEFAULT_SETTINGS[key];
}


function numberAt(raw: unknown, key: NumberKey): number {
  return strictValueAt(raw, key) ?? DEFAULT_SETTINGS[key];
}

function enumAt<K extends EnumKey>(raw: unknown, key: K): TuiSettings[K] {
  const def = DEF_BY_KEY.get(key);
  const value = rawValue(raw, key);
  const choices: readonly string[] = def?.choices ?? [];
  // `includes` narrows to `string`, not to this key's literal union, so the
  // assertion carries the fact the membership check just established.
  return typeof value === "string" && choices.includes(value)
    ? (value as TuiSettings[K])
    : DEFAULT_SETTINGS[key];
}

function normalizeModelPreference(raw: unknown): ModelPreference | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.providerId !== "string" || !value.providerId.trim()
    || typeof value.model !== "string" || !value.model.trim()
    || typeof value.connectionIdentity !== "string" || !/^[a-f0-9]{64}$/.test(value.connectionIdentity)) return undefined;
  if (value.cyberAccessProgram !== undefined && !["standard", "daybreak_blue", "daybreak_red"].includes(value.cyberAccessProgram as string)) return undefined;
  return { providerId: value.providerId, model: value.model, connectionIdentity: value.connectionIdentity,
    ...(value.cyberAccessProgram !== undefined ? { cyberAccessProgram: value.cyberAccessProgram as ModelPreference["cyberAccessProgram"] } : {}),
  };
}

/**
 * Total, pure coercion of anything at all into a valid `TuiSettings`.
 *
 * Building a fresh literal rather than merging over the input is what drops
 * unknown keys: a hand-edited file that grew a stale or misspelled key cannot
 * smuggle it back into memory or, via `saveSettings`, back onto disk.
 */
export function normalizeSettings(raw: unknown): TuiSettings {
  return {
    showSubagents: booleanAt(raw, "showSubagents"),
    showTimestamps: booleanAt(raw, "showTimestamps"),
    density: enumAt(raw, "density"),
    busyInputMode: enumAt(raw, "busyInputMode"),
    onboardingCompleted: booleanAt(raw, "onboardingCompleted"),
    executionProfile: enumAt(raw, "executionProfile"),
    allowSubagentPeerMessaging: booleanAt(raw, "allowSubagentPeerMessaging"),
    allowSubagentOperatorMessaging: booleanAt(raw, "allowSubagentOperatorMessaging"),
    toolCardStyle: enumAt(raw, "toolCardStyle"),
    transcriptDetail: enumAt(raw, "transcriptDetail"),
    autoCompaction: booleanAt(raw, "autoCompaction"),
    compactionThreshold: enumAt(raw, "compactionThreshold"),
    allowModelSelfExtension: booleanAt(raw, "allowModelSelfExtension"),
    allowDevSourceUpdates: booleanAt(raw, "allowDevSourceUpdates"),
    showTokenUsage: booleanAt(raw, "showTokenUsage"),
    showCost: booleanAt(raw, "showCost"),
    showContextMeter: booleanAt(raw, "showContextMeter"),
    elapsedTimer: enumAt(raw, "elapsedTimer"),
    analyticsLevel: enumAt(raw, "analyticsLevel"),
    diagnosticReporting: strictValueAt(raw, "diagnosticReporting") ?? DEFAULT_SETTINGS.diagnosticReporting,
    diagnosticReportingPrompted: booleanAt(raw, "diagnosticReportingPrompted"),
    updatePolicy: strictValueAt(raw, "updatePolicy") ?? DEFAULT_SETTINGS.updatePolicy,
    modelPreference: normalizeModelPreference(rawValue(raw, "modelPreference")) ?? null,
    subagentConcurrency: numberAt(raw, "subagentConcurrency"),
    subagentMaxDepth: numberAt(raw, "subagentMaxDepth"),
    subagentFanOut: numberAt(raw, "subagentFanOut"),
    titleInstructions: strictValueAt(raw, "titleInstructions") ?? DEFAULT_SETTINGS.titleInstructions,
    archiveIdleDays: numberAt(raw, "archiveIdleDays"),
  };
}

/**
 * Loads settings, or the defaults. Never throws and never reports: a missing
 * file is the common case (first run), and an unreadable or malformed one is
 * still not worth interrupting a session over — the user sees default chrome
 * and can re-toggle, which rewrites the file cleanly.
 */
export function loadSettings(homeDir?: string, projectDir?: string): TuiSettings {
  return loadLayeredSettings({ homeDir, projectDir }).settings;
}

/**
 * The GLOBAL layer alone, as a complete normalised object (ignoring any project
 * override). Used by `config import --global`, which merges into the global file
 * rather than the effective view.
 * Workbench routing may require an explicit valid profile: a corrupt/missing
 * selection must not silently become host-local execution.
 */
export function loadGlobalSettings(homeDir?: string, options: { requireExecutionProfile?: boolean } = {}): TuiSettings {
  const raw = readRawSettingsFile(settingsFilePath(homeDir));
  if (options.requireExecutionProfile && strictValueAt(raw, "executionProfile") === undefined) {
    throw new Error("Configured workbench execution profile is missing or invalid. Run 0 workbench setup or 0 workbench disable to make an explicit operator choice; direct fallback is refused.");
  }
  return normalizeSettings(raw);
}

/**
 * Persists settings, reporting success as a return value rather than an
 * exception. Callers render "could not save" in the transcript; a read-only or
 * full home directory must not take the console down with it.
 *
 * The payload is normalised on the way out and pretty-printed with a trailing
 * newline because this file is meant to be opened and edited by hand.
 */
export function saveSettings(settings: TuiSettings, homeDir?: string): boolean {
  const path = settingsFilePath(homeDir);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* best-effort failed-write cleanup */ }
  }
}

/* --------------------------------------------------- project override writes */

/**
 * Keep only known keys that carry a valid value for their key, dropping unknown
 * or malformed entries — the same "build a clean literal" discipline
 * `normalizeSettings` uses, but SPARSE: keys not present stay absent so they keep
 * falling through to the global layer. This is what a project override file is
 * allowed to contain.
 */
export function sanitizeOverrides(raw: unknown): Partial<TuiSettings> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof TuiSettings)[]) {
    if (isOperatorSetting(key)) continue;
    const value = strictValueAt(raw, key);
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<TuiSettings>;
}

/** Read the current project override file as a sanitised sparse patch. */
export function readProjectOverrides(projectDir?: string): Partial<TuiSettings> {
  return sanitizeOverrides(readRawSettingsFile(projectSettingsFilePath(projectDir)));
}

/**
 * Write a sparse project override file. The patch is sanitised on the way out so
 * a project file can never carry an unknown or invalid key. Reports success as a
 * return value; never throws on an I/O failure.
 */
export function saveProjectOverrides(patch: Partial<TuiSettings>, projectDir?: string): boolean {
  try {
    const path = projectSettingsFilePath(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(sanitizeOverrides(patch), null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge one key into the project override file, preserving the other overrides.
 * The value is validated (via the sanitiser) before it lands, so an out-of-range
 * value is simply not written. Reports success as a return value.
 */
export function setProjectOverride<K extends keyof TuiSettings>(
  key: K,
  value: TuiSettings[K],
  projectDir?: string,
): boolean {
  if (isOperatorSetting(key)) return false;
  const current = readProjectOverrides(projectDir);
  return saveProjectOverrides({ ...current, [key]: value }, projectDir);
}

/**
 * Advances one setting: booleans flip, enums step to the next choice and wrap.
 *
 * Enums cycle rather than open a picker because the settings UI binds a single
 * key (enter/space) to "change this row", and a three-value enum is faster to
 * cycle than to select. An unknown key is returned unchanged instead of
 * throwing so a stale keybinding or slash-command argument is inert.
 */
export function toggleSetting(settings: TuiSettings, key: string): TuiSettings {
  const def = DEF_BY_KEY.get(key);
  if (!def) return settings;

  if (def.kind === "boolean") {
    return { ...settings, [def.key]: !settings[def.key] };
  }

  if (def.kind === "number" || def.kind === "text") return settings;
  const choices: readonly string[] = def.choices;
  // indexOf returning -1 (current value not in choices, i.e. a corrupt object
  // was passed straight in) lands on index 0 — the first choice — which is a
  // sane repair rather than an out-of-range read.
  const next = choices[(choices.indexOf(settings[def.key]) + 1) % choices.length];
  // The computed key is a union of enum keys, so TS cannot prove `next` fits
  // whichever one this is; the choice list it came from is that key's own.
  const patch = { [def.key]: next } as Partial<TuiSettings>;
  return { ...settings, ...patch };
}

/** One-line "Label: value - description" for the settings UI and `/settings`. */
export function describeSetting(settings: TuiSettings, key: string): string {
  const def = DEF_BY_KEY.get(key);
  if (!def) return "";
  const value = normalizeSettings(settings)[def.key];
  const rendered = def.kind === "boolean" ? (value ? "on" : "off") : String(value);
  return `${def.label}: ${rendered} - ${def.description}`;
}
