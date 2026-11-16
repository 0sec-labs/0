import type { PluginCapability } from "./manifest.js";

/** First-party host features use the same explicit per-project approval store. */
export interface BuiltinPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly capabilities: readonly PluginCapability[];
  /** On for every install and project until an operator explicitly turns it off. */
  readonly defaultEnabled?: boolean;
}

export const SCOPE_PLUGIN_ID = "scope";

export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = Object.freeze([
  Object.freeze({
    id: SCOPE_PLUGIN_ID,
    name: "Scope enforcement",
    version: "1.1.0",
    description: "Enforces engagement host/path authorization, exclusions and local filesystem scope. On by default: it enforces whenever a scope is defined and allows everything when none is. Credential protection, sandboxing and resource limits remain independent.",
    capabilities: Object.freeze([]),
    defaultEnabled: true,
  }),
]);

export function getBuiltinPlugin(id: string): BuiltinPlugin | undefined {
  return BUILTIN_PLUGINS.find(plugin => plugin.id === id);
}
