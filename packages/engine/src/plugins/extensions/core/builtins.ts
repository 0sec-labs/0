/**
 * First-party built-in extensions. They live inside the binary, update with the binary (the binary is the trust
 * root), cannot be removed and are never installed from a folder. To register one, add a row to
 * {@link BUILTIN_EXTENSIONS}; the store, the CLI and the prompt read only this array.
 */
import { connectorCanDo, type ConnectorDecl } from "./connector.js";

export interface BuiltinExtension {
  readonly name: string; readonly version: string; readonly description: string;
  /** Title for the older `0 plugin` listing. Present only for built-ins that appear there too. */
  readonly pluginTitle?: string;
  /** One line per thing it can do, in the same words as an install prompt. */
  readonly canDo: readonly string[];
  /** Shown when the operator disables it; disabling needs an explicit confirmation and is audited. */
  readonly confirmDisable: string;
  /** Present when the built-in connects 0 to a service: the same contract an installed connector extension declares. */
  readonly connector?: ConnectorDecl;
  /** Skills it contributes, by id. They ship in the binary like the extension itself. */
  readonly skills?: readonly string[];
  /** `always`: it cannot be switched off from the Extensions page. `scope-defined`: it cannot be while a scope is defined. */
  readonly required?: "always" | "scope-defined";
}

/**
 * GitHub: the connection pull request Agents, the pull request trigger and the webhook receiver use. All access goes
 * through the GitHub CLI's own login (`gh`), which holds the credential; a fine-grained token is validated by `gh` and
 * stored in its store, so no environment variable is involved and no script ever receives the token.
 */
export const GITHUB_CONNECTOR: ConnectorDecl = {
  service: "github", title: "GitHub", description: "Review repositories, security alerts and pull requests.", category: "Code",
  auth: "cli-login", methods: ["cli-login", "oauth-device", "token"], env: [], hosts: ["github.com", "api.github.com"],
  read: ["pull requests", "pull request diffs", "repository contents", "repository list"],
  write: ["comments on pull requests"],
  health: { type: "adapter" }, connectLabel: "Connect", surface: null,
};

/** The ONE registry of built-ins. `plugins/builtin.ts` derives the `0 plugin` view from it; there is no second list. */
export const BUILTIN_EXTENSIONS: readonly BuiltinExtension[] = [
  {
    name: "scope", version: "1.1.0", required: "scope-defined", pluginTitle: "Scope enforcement",
    description: "Enforces engagement host/path authorization, exclusions and local filesystem scope. On by default: it enforces whenever a scope is defined and allows everything when none is. Credential protection, sandboxing and resource limits remain independent.",
    canDo: ["adds rules: scope allows or denies commands before they run"], confirmDisable: "Disabling scope runs commands without scope enforcement; while a scope is defined, commands are denied instead.",
  },
  {
    name: "github", version: "1.0.0", required: "always", description: "GitHub connection used by pull request Agents, the pull request trigger and the webhook receiver. Built in: it cannot be removed and updates with the 0 binary.",
    canDo: [connectorCanDo(GITHUB_CONNECTOR), "adds skills (text instructions): pr-diff-review"], confirmDisable: "Disabling github pauses pull request Agents.",
    connector: GITHUB_CONNECTOR, skills: ["pr-diff-review"],
  },
];

export const getBuiltin = (name: string): BuiltinExtension | undefined => BUILTIN_EXTENSIONS.find(b => b.name === name);
