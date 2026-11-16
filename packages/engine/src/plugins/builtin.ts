import { BUILTIN_EXTENSIONS } from "./extensions/core/builtins.js";
import type { PluginCapability } from "./manifest.js";

/** First-party host features as the `0 plugin` commands see them: a view over the one built-in registry. */
export interface BuiltinPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly capabilities: readonly PluginCapability[];
  /** On for every install until an operator explicitly turns it off. */
  readonly defaultEnabled?: boolean;
}

export const SCOPE_PLUGIN_ID = "scope";

export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = Object.freeze(
  BUILTIN_EXTENSIONS.filter(b => b.pluginTitle !== undefined).map(b => Object.freeze({
    id: b.name, name: b.pluginTitle!, version: b.version, description: b.description, capabilities: Object.freeze([]) as readonly PluginCapability[], defaultEnabled: true,
  })),
);

export function getBuiltinPlugin(id: string): BuiltinPlugin | undefined {
  return BUILTIN_PLUGINS.find(plugin => plugin.id === id);
}
