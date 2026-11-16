/**
 * First-party built-in extensions. They live inside the binary, update with the binary (the binary is the trust
 * root), cannot be removed and are never installed from a folder. To register one, add a row to
 * {@link BUILTIN_EXTENSIONS}; the store, the CLI and the prompt read only this array.
 */
export interface BuiltinExtension {
  readonly name: string; readonly version: string; readonly description: string;
  /** One line per thing it can do, in the same words as an install prompt. */
  readonly canDo: readonly string[];
  /** Shown when the operator disables it; disabling needs an explicit confirmation and is audited. */
  readonly confirmDisable: string;
}

export const BUILTIN_EXTENSIONS: readonly BuiltinExtension[] = [
  // Placeholder: step 1 (beforeCommand hook, default on, fail closed) registers the real scope policy under this name.
  { name: "scope", version: "1.0.0", description: "Enforces the engagement scope on every command.", canDo: ["defines a scope: allows or denies commands before they run"], confirmDisable: "Disabling scope runs commands without scope enforcement." },
  // Placeholder: step 5 moves the GitHub connector here. Disabling pauses pull request Agents.
  { name: "github", version: "0.0.0", description: "GitHub connection used by pull request Agents.", canDo: ["calls a service: github.com"], confirmDisable: "Disabling github pauses pull request Agents." },
];

export const getBuiltin = (name: string): BuiltinExtension | undefined => BUILTIN_EXTENSIONS.find(b => b.name === name);
