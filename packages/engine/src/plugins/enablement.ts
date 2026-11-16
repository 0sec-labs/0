/**
 * The per-project view of first-party built-in enablement (today: `scope`). It is a compatibility facade: the one
 * store is `extensions/state.json` (builtin-store.ts). Reads never throw and degrade to the built-in's default; a
 * corrupt old record is reported in `builtinIssues` so scope fails closed. Installed extensions are not here.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { homeStateDir } from "../shared/index.js";

import { BUILTIN_PLUGINS, getBuiltinPlugin } from "./builtin.js";
import { readBuiltinEnablement, writeBuiltinEnablement } from "./builtin-store.js";

/** Old per-project records live here; they are only read by the one-time built-in migration. */
export const ENABLEMENT_DIR_NAME = "plugin-enablement";
export const ENABLEMENT_DIR_MODE = 0o700;
export const ENABLEMENT_FILE_MODE = 0o600;
export const ENABLEMENT_SCHEMA_VERSION = 2;
const MAX_ENABLEMENT_BYTES = 1024 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface EnabledPluginRecord {
  version: string;
  capabilities: string[];
  enabledAt: number;
  /** `default` marks a built-in that is on by default, not by an explicit operator choice. */
  origin?: "default";
}

export interface EnablementRecord {
  schema: number;
  /** Built-ins whose recorded enablement could not be trusted (id -> why). Absent from `enabled` too. */
  builtinIssues?: Record<string, string>;
  project: string;
  enabled: Record<string, EnabledPluginRecord>;
}

export function emptyEnablement(project = ""): EnablementRecord {
  return { schema: ENABLEMENT_SCHEMA_VERSION, project, enabled: {} };
}

export type EnableResult = { ok: true; record: EnablementRecord } | { ok: false; error: string };

/** Record that a built-in is on. Pure: returns a new record. */
export function enable(record: EnablementRecord, id: string, opts: { version: string; capabilities: readonly string[]; now: number }): EnableResult {
  if (!SAFE_ID.test(id)) return { ok: false, error: `id ${JSON.stringify(String(id))} is not a safe identifier; rejected, not sanitized` };
  return { ok: true, record: { ...record, schema: ENABLEMENT_SCHEMA_VERSION, enabled: { ...record.enabled, [id]: { version: opts.version, capabilities: [...opts.capabilities], enabledAt: opts.now } } } };
}

/** Record that a built-in is off. Pure; a no-op when it was not on. */
export function disable(record: EnablementRecord, id: string): EnablementRecord {
  if (!Object.prototype.hasOwnProperty.call(record.enabled, id)) return record;
  const enabled = { ...record.enabled }; delete enabled[id];
  return { schema: ENABLEMENT_SCHEMA_VERSION, project: record.project, enabled };
}

/** Stable per-project filename: `sha256(realpath(project)).json`. */
export function enablementDir(homeDir?: string): string { return join(homeStateDir(homeDir), ENABLEMENT_DIR_NAME); }
export function enablementFilePath(projectPath: string, homeDir?: string): string {
  let real: string;
  try { real = realpathSync(projectPath); } catch { real = resolve(projectPath); }
  return join(enablementDir(homeDir), `${createHash("sha256").update(real, "utf8").digest("hex")}.json`);
}

/** Read what the records say about the built-ins for this project. NEVER throws. */
export function readEnablement(projectPath: string, homeDir?: string): EnablementRecord {
  let real: string;
  try { real = realpathSync(projectPath); } catch { real = resolve(projectPath); }
  const enabled: Record<string, EnabledPluginRecord> = {};
  const issues: Record<string, string> = {};
  const legacy = { dir: enablementDir(homeDir), projectFile: enablementFilePath(projectPath, homeDir) };
  for (const builtin of BUILTIN_PLUGINS) {
    const state = readBuiltinEnablement(builtin.id, legacy, homeDir);
    if (state.kind === "corrupt") { issues[builtin.id] = state.message ?? "its enablement record is corrupt"; continue; }
    if (state.kind === "off") continue;
    const base = { version: builtin.version, capabilities: [...builtin.capabilities], enabledAt: 0 };
    enabled[builtin.id] = state.kind === "explicit" ? base : { ...base, origin: "default" };
  }
  return { schema: ENABLEMENT_SCHEMA_VERSION, project: real, enabled, ...(Object.keys(issues).length ? { builtinIssues: issues } : {}) };
}

/** Persist the built-ins' modes. False when one could not be recorded (including from an agent session). */
export function writeEnablement(
  projectPath: string,
  record: EnablementRecord,
  homeDir?: string,
): boolean {
  const dir = enablementDir(homeDir);
  const path = enablementFilePath(projectPath, homeDir);
  // Built-ins go to their one store; the per-project file keeps only installed-plugin approvals.
  const legacy = { dir, projectFile: path };
  const files: Record<string, EnabledPluginRecord> = {};
  for (const [id, value] of Object.entries(record.enabled)) if (!getBuiltinPlugin(id)) files[id] = value;
  for (const builtin of BUILTIN_PLUGINS) {
    if (record.builtinIssues?.[builtin.id] !== undefined && record.enabled[builtin.id] === undefined) continue;
    const entry = record.enabled[builtin.id];
    const wanted = entry === undefined ? "off" : entry.origin === "default" ? "default" : "explicit";
    const current = readBuiltinEnablement(builtin.id, legacy, homeDir).kind;
    const now = current === "off" ? "off" : current === "explicit" ? "explicit" : "default";
    if (wanted !== now && !writeBuiltinEnablement(builtin.id, wanted, homeDir)) return false;
  }
  try {
    mkdirSync(dir, { recursive: true, mode: ENABLEMENT_DIR_MODE });
    chmodSync(dir, ENABLEMENT_DIR_MODE);
  } catch {
    // Directory may already exist with the right mode; fall through and let the
    // write decide success.
  }
  try {
    const normalized: EnablementRecord = {
      schema: ENABLEMENT_SCHEMA_VERSION,
      project: record.project,
      enabled: files,
    };
    writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, {
      mode: ENABLEMENT_FILE_MODE,
    });
    chmodSync(path, ENABLEMENT_FILE_MODE);
    return true;
  } catch {
    return false;
  }
}
