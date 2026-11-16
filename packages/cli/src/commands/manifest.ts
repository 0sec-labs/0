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

/** Descriptions of the nine visible commands: the one copy the real groups and the root help share. */
export const GROUP_DESCRIPTIONS: Readonly<Record<string, string>> = {
  scan: "Scan a target (URL, repository, package) or work a finding: fix, verify, disclose",
  findings: "Browse findings and change their status",
  threads: "Start, follow and stop threads",
  agents: "Agents and their automations: list, run, change",
  skills: "Skills and extensions: list, add",
  memory: "What 0 remembers across threads",
  models: "Models and provider connections",
  computers: "Remote computers that run 0",
  config: "Settings, API keys, team and setup checks (config doctor)",
};

/** The only subcommands `--help` shows for each visible command. Everything else stays reachable as a hidden old name (see command-compat.ts). */
export const VISIBLE_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  scan: ["fix", "verify", "disclose"],
  findings: ["list", "show", "update"],
  threads: ["list", "send", "stop"],
  agents: ["list", "run", "set"],
  skills: ["list", "add"],
  memory: ["list", "set", "export"],
  models: ["list", "set", "connect"],
  computers: ["list", "add", "stop"],
  config: ["get", "set", "doctor"],
};

export const TOP_LEVEL_COMMANDS: readonly TopLevelCommand[] = [
  { name: "scan", aliases: [], description: GROUP_DESCRIPTIONS["scan"]! },
  { name: "findings", aliases: [], description: GROUP_DESCRIPTIONS["findings"]!, options: true },
  { name: "threads", aliases: [], description: GROUP_DESCRIPTIONS["threads"]! },
  { name: "agents", aliases: [], description: GROUP_DESCRIPTIONS["agents"]! },
  { name: "skills", aliases: [], description: GROUP_DESCRIPTIONS["skills"]! },
  { name: "memory", aliases: [], description: GROUP_DESCRIPTIONS["memory"]! },
  { name: "models", aliases: [], description: GROUP_DESCRIPTIONS["models"]! },
  { name: "computers", aliases: ["worker"], description: GROUP_DESCRIPTIONS["computers"]! },
  { name: "config", aliases: [], description: GROUP_DESCRIPTIONS["config"]! },
  // Old top-level names: hidden, still working for one release (command-compat.ts prints the moved line).
  { name: "automation", aliases: ["automations"], description: "Discover templates, inspect saved automations, and run an automation", hidden: true },
  { name: "plugin", aliases: [], description: "Moved: see `0 skills extensions`", hidden: true },
  { name: "doctor", aliases: [], description: "Check local runtime prerequisites and suggest the next command", hidden: true, options: true },
  { name: "web", aliases: [], description: "Run the local browser console and operations workspace", hidden: true, options: true },
  { name: "api", aliases: [], description: "Call a trusted engine API with deterministic JSON output (defaults to its handshake)", hidden: true, options: true, arguments: "[path]" },
  { name: "lab", aliases: [], description: "Developer commands: research, improve, console, mcp-server, runs", hidden: true },
];

export function findTopLevel(name: string): TopLevelCommand | undefined {
  return TOP_LEVEL_COMMANDS.find((command) => command.name === name || command.aliases.includes(name));
}
