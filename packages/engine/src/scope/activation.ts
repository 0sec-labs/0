import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { SCOPE_PLUGIN_ID } from "../plugins/builtin.js";
import { getBuiltinPluginState } from "../plugins/builtin-state.js";

/**
 * Scope is a first-party plugin that is ON by default and FAILS CLOSED.
 *
 * - No scope defined: nothing is restricted (unchanged for casual use).
 * - A scope is defined (project, `--scope`, Agent/automation, pull-request checkout):
 *   host, path and network checks enforce. Defining a scope is the operator's consent.
 * - A scope is defined but the plugin is disabled: authorization is DENIED, never allowed.
 * - Explicitly enabled (including every pre-default-on approval): checks also apply
 *   with no scope defined, exactly as before ("strict").
 */
export interface ScopeEnforcementState {
  readonly pluginId: typeof SCOPE_PLUGIN_ID;
  /** Authorization checks are active for this run. */
  readonly enabled: boolean;
  readonly projectPath: string;
  readonly message: string;
  /** False only when an operator explicitly disabled the plugin for this project. */
  readonly pluginEnabled: boolean;
  /** Explicitly enabled: checks apply even with no scope defined. */
  readonly explicit: boolean;
  /** A scope is defined for this run. */
  readonly scopeDefined: boolean;
  /** A scope is defined but the plugin is disabled: commands are denied. */
  readonly denied: boolean;
}

const executionState = new AsyncLocalStorage<ScopeEnforcementState>();

function describe(pluginEnabled: boolean, enabled: boolean, scopeDefined: boolean): string {
  if (!pluginEnabled && scopeDefined) {
    return "Scope extension disabled while a scope is defined: commands and network access are DENIED (fail closed). Re-enable with `0 plugin enable scope` for this project.";
  }
  if (!pluginEnabled) {
    return "Scope extension disabled for this project: no scope is defined, so nothing is restricted. If a scope is defined, commands will be denied until it is re-enabled.";
  }
  return enabled
    ? "Scope extension on: engagement authorization checks are active; configure policy or approve scope where the workflow requires it."
    : "Scope extension on: no scope is defined, so nothing is restricted. Defining a scope (--scope, project, Agent or automation scope) enforces it.";
}

/**
 * Resolve scope state for a project. `scopeDefined` says a scope exists for the
 * run being started; it can only add enforcement. A state pinned by
 * {@link withScopeEnforcement} is returned as is unless a scope is now defined
 * (scope never weakens during a run).
 */
export function getScopeEnforcementState(projectPath?: string, homeDir?: string, scopeDefined = false): ScopeEnforcementState {
  const current = executionState.getStore();
  if (current && projectPath === undefined && homeDir === undefined) {
    // The pinned snapshot is authoritative for the run; a scope can only add enforcement.
    if (!scopeDefined || current.scopeDefined) return current;
    return derive(current.projectPath, current.pluginEnabled, current.explicit, true);
  }
  const project = resolve(projectPath ?? process.cwd());
  const plugin = getBuiltinPluginState(SCOPE_PLUGIN_ID, project, homeDir);
  return derive(plugin?.project ?? project, plugin?.enabled ?? false, plugin?.explicit ?? false, scopeDefined);
}

function derive(projectPath: string, pluginEnabled: boolean, explicit: boolean, defined: boolean): ScopeEnforcementState {
  const enabled = pluginEnabled && (explicit || defined);
  return Object.freeze({
    pluginId: SCOPE_PLUGIN_ID,
    enabled,
    projectPath,
    message: describe(pluginEnabled, enabled, defined),
    pluginEnabled,
    explicit,
    scopeDefined: defined,
    denied: !pluginEnabled && defined,
  });
}

/** The shared gate for every authorization check, never an environment bypass. */
export function isScopeEnforcementEnabled(): boolean {
  return getScopeEnforcementState().enabled;
}

/**
 * Check mode for a site that knows whether a scope exists for what it guards:
 * `off` (nothing defined, not strict), `enforce`, or `deny` (a scope is defined
 * but the plugin is disabled, fail closed).
 */
export function scopeCheckMode(scopeDefined: boolean): "off" | "enforce" | "deny" {
  const state = getScopeEnforcementState(undefined, undefined, scopeDefined);
  if (state.denied) return "deny";
  return state.enabled ? "enforce" : "off";
}

/** Pin one approval snapshot for an entire scan, turn or standalone tool call. */
export function withScopeEnforcement<T>(state: ScopeEnforcementState, run: () => T): T {
  return executionState.run(state, run);
}
