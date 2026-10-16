import { getScopeEnforcementState } from "./activation.js";

/** Authorization checks supplied by the first-party scope plugin. */
export const SCOPE_DEPENDENT_BASH_GUARDS = [
  "bash_out_of_scope_url_refusal",
  "bash_http_audit_path_allowlist",
  "bash_generic_scanner_suppression",
] as const;

export interface ScopeGuardStatus {
  /** Whether the operator explicitly activated the scope plugin. */
  pluginEnabled: boolean;
  /** Whether a configured policy is actually being enforced. */
  active: boolean;
  /** Missing-policy fail-closed strictness, meaningful only with the plugin active. */
  required: boolean;
  inertGuards: readonly string[];
  message: string;
}

export const SCOPE_GUARDS_INERT_EVENT = "scope_guards_inert";

/** The legacy strictness setting never activates the plugin by itself. */
export function isScopeRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["ZERO_REQUIRE_SCOPE"]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function targetRequiresScope(target: string): boolean {
  try {
    const protocol = new URL(target).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mcp:";
  } catch {
    return false;
  }
}

export function networkScopeRequiredRefusal(target: string): string {
  return (
    `scan refused: live network target '${target}' requires an engagement scope while the scope plugin is enabled. ` +
    "Pass --scope <file> or use http_audit with an operator-provided host policy."
  );
}

export function describeScopeGuards(
  scopeConfigured: boolean,
  env: NodeJS.ProcessEnv = process.env,
): ScopeGuardStatus {
  const state = getScopeEnforcementState();
  const required = state.enabled && isScopeRequired(env);
  if (!state.enabled) {
    return { pluginEnabled: false, active: false, required: false, inertGuards: SCOPE_DEPENDENT_BASH_GUARDS, message: state.message };
  }
  if (scopeConfigured) {
    return { pluginEnabled: true, active: true, required, inertGuards: [], message: "" };
  }
  return {
    pluginEnabled: true,
    active: false,
    required,
    inertGuards: SCOPE_DEPENDENT_BASH_GUARDS,
    message: "Scope plugin enabled, but no engagement scope is configured. Bash scope guards are inert; pass --scope <file> to enforce host authorization. Live network scans are refused until a scope is configured.",
  };
}

export function scopeRequiredRefusal(site: string): string {
  return (
    `${site} refused: the scope plugin is enabled and ZERO_REQUIRE_SCOPE is set but no engagement scope is configured. ` +
    "Pass --scope <file>, or unset ZERO_REQUIRE_SCOPE to run local modes with visibly inert scope guards."
  );
}
