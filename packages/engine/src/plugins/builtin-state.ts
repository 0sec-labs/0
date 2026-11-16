import { resolve } from "node:path";
import { readEnablement } from "./enablement.js";
import { getBuiltinPlugin } from "./builtin.js";

/** What an operator's records say about one first-party built-in plugin in one project. */
export interface BuiltinPluginState {
  readonly id: string;
  readonly version: string;
  /** False only after an operator explicitly disabled it (or never for default-on built-ins). */
  readonly enabled: boolean;
  /**
   * True when the operator (or a pre-default-on release) explicitly enabled it.
   * A default-on built-in that nobody touched is `enabled` but not `explicit`.
   */
  readonly explicit: boolean;
  readonly project: string;
  /** Why the recorded enablement could not be trusted (a corrupt record); `enabled` is then false. */
  readonly corrupt?: string;
}

/** What an operator's records say about one first-party built-in. Read through the one store (extensions/state.json). Never throws; a missing or unparseable record resolves to the built-in's default. */
export function getBuiltinPluginState(id: string, projectPath?: string, homeDir?: string): BuiltinPluginState | undefined {
  const builtin = getBuiltinPlugin(id);
  if (!builtin) return undefined;
  const record = readEnablement(resolve(projectPath ?? process.cwd()), homeDir);
  const entry = record.enabled[id];
  const corrupt = record.builtinIssues?.[id];
  return Object.freeze({
    ...(corrupt !== undefined ? { corrupt } : {}),
    id,
    version: builtin.version,
    enabled: entry !== undefined,
    explicit: entry !== undefined && entry.origin !== "default",
    project: record.project,
  });
}
