/**
 * First-party built-in extensions. They live inside the binary, update with the binary (the binary is the trust
 * root), cannot be removed and are never installed from a folder. To register one, add a row to
 * {@link BUILTIN_EXTENSIONS}; the store, the CLI and the prompt read only this array.
 */
export interface BuiltinExtension {
  readonly name: string; readonly version: string; readonly description: string;
  /** Title for the older `0 plugin` listing. Present only for built-ins that appear there too. */
  readonly pluginTitle?: string;
  /** One line per thing it can do, in the same words as an install prompt. */
  readonly canDo: readonly string[];
  /** Shown when the operator disables it; disabling needs an explicit confirmation and is audited. */
  readonly confirmDisable: string;
}

/** The ONE registry of built-ins. `plugins/builtin.ts` derives the `0 plugin` view from it; there is no second list. */
export const BUILTIN_EXTENSIONS: readonly BuiltinExtension[] = [
  {
    name: "scope", version: "1.1.0", pluginTitle: "Scope enforcement",
    description: "Enforces engagement host/path authorization, exclusions and local filesystem scope. On by default: it enforces whenever a scope is defined and allows everything when none is. Credential protection, sandboxing and resource limits remain independent.",
    canDo: ["defines a scope: allows or denies commands before they run"], confirmDisable: "Disabling scope runs commands without scope enforcement; while a scope is defined, commands are denied instead.",
  },
  // Placeholder: step 5 moves the GitHub connector here. Disabling pauses pull request Agents.
  { name: "github", version: "0.0.0", description: "GitHub connection used by pull request Agents.", canDo: ["calls a service: github.com"], confirmDisable: "Disabling github pauses pull request Agents." },
];

export const getBuiltin = (name: string): BuiltinExtension | undefined => BUILTIN_EXTENSIONS.find(b => b.name === name);
