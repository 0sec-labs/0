/**
 * Static description of every top-level command, so `0 --help`, unknown-command errors
 * and the "is this a known command" check need no command module. The lazy tree loads a
 * command's real implementation only when it is invoked (see lazy-tree.ts).
 *
 * `options` and `arguments` exist only so the root help line renders the same
 * `name [options] [arg]` term as the real command. `help-snapshot.test.ts` fails when
 * any entry drifts from the real tree.
 */
export interface TopLevelCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly hidden?: boolean;
  /** The real command has options of its own. */
  readonly options?: boolean;
  /** Positional arguments in the real command's usage, for example `[path]`. */
  readonly arguments?: string;
}

/** Descriptions of the eight visible commands: the one copy the real groups and the root help share. */
export const GROUP_DESCRIPTIONS: Readonly<Record<string, string>> = {
  findings: "Browse findings and change their status",
  threads: "Start, follow and stop threads",
  sentinels: "Sentinels and their automations: list, run, change",
  skills: "Skills and extensions: list, add",
  memory: "What 0 remembers across threads",
  models: "Models and provider connections",
  computers: "Remote computers that run 0",
  config: "Settings, API keys, team and setup checks (config doctor)",
};

/** The only subcommands `--help` shows for each visible command. Everything else stays registered but hidden (see command-grammar.ts). */
export const VISIBLE_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  findings: ["list", "show", "update"],
  threads: ["list", "send", "start", "stop"],
  sentinels: ["list", "run", "set"],
  skills: ["list", "add"],
  memory: ["list", "add", "remove"],
  models: ["list", "set", "connect"],
  computers: ["list", "add", "stop"],
  config: ["get", "set", "doctor"],
};

export const TOP_LEVEL_COMMANDS: readonly TopLevelCommand[] = [
  { name: "findings", aliases: [], description: GROUP_DESCRIPTIONS["findings"]!, options: true },
  { name: "threads", aliases: [], description: GROUP_DESCRIPTIONS["threads"]! },
  { name: "sentinels", aliases: [], description: GROUP_DESCRIPTIONS["sentinels"]! },
  { name: "skills", aliases: [], description: GROUP_DESCRIPTIONS["skills"]! },
  { name: "memory", aliases: [], description: GROUP_DESCRIPTIONS["memory"]! },
  { name: "models", aliases: [], description: GROUP_DESCRIPTIONS["models"]! },
  { name: "computers", aliases: [], description: GROUP_DESCRIPTIONS["computers"]! },
  { name: "config", aliases: [], description: GROUP_DESCRIPTIONS["config"]! },
  // Implementation commands behind the grammar in command-grammar.ts: hidden.
  { name: "automation", aliases: [], description: "Discover templates, inspect saved automations, and run an automation", hidden: true },
  { name: "doctor", aliases: [], description: "Check local runtime prerequisites and suggest the next command", hidden: true, options: true },
  { name: "web", aliases: [], description: "Run the local browser console and operations workspace", hidden: true, options: true },
  { name: "api", aliases: [], description: "Call a trusted engine API with deterministic JSON output (defaults to its handshake)", hidden: true, options: true, arguments: "[path]" },
];

export function findTopLevel(name: string): TopLevelCommand | undefined {
  return TOP_LEVEL_COMMANDS.find((command) => command.name === name || command.aliases.includes(name));
}
