import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { readEnablement } from "../plugins/enablement.js";
import { SCOPE_PLUGIN_ID, getBuiltinPlugin } from "../plugins/builtin.js";

export interface ScopeEnforcementState {
  readonly pluginId: typeof SCOPE_PLUGIN_ID;
  readonly enabled: boolean;
  readonly projectPath: string;
  readonly message: string;
}

const executionState = new AsyncLocalStorage<ScopeEnforcementState>();

/** Resolve explicit operator approval; a scope file alone never activates checks. */
export function getScopeEnforcementState(projectPath?: string, homeDir?: string): ScopeEnforcementState {
  const current = executionState.getStore();
  if (current && projectPath === undefined && homeDir === undefined) return current;
  const project = resolve(projectPath ?? process.cwd());
  const record = readEnablement(project, homeDir);
  const approval = record.enabled[SCOPE_PLUGIN_ID];
  const builtin = getBuiltinPlugin(SCOPE_PLUGIN_ID)!;
  const enabled = approval !== undefined && approval.version === builtin.version && approval.capabilities.length === 0;
  return Object.freeze({
    pluginId: SCOPE_PLUGIN_ID,
    enabled,
    projectPath: record.project,
    message: enabled
      ? "Scope plugin enabled: engagement authorization checks are active; configure policy or approve scope where the workflow requires it."
      : "Scope plugin disabled: engagement host/path authorization, exclusions and local filesystem scope are NOT enforced. Saved target credential boundaries, sandboxing and resource limits remain active. Enable with `0 plugin enable scope` for this project.",
  });
}

/** The shared gate for every authorization check, never an environment bypass. */
export function isScopeEnforcementEnabled(): boolean {
  return getScopeEnforcementState().enabled;
}

/** Pin one approval snapshot for an entire scan, turn or standalone tool call. */
export function withScopeEnforcement<T>(state: ScopeEnforcementState, run: () => T): T {
  return executionState.run(state, run);
}
