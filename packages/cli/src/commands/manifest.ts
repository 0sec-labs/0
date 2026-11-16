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

export const TOP_LEVEL_COMMANDS: readonly TopLevelCommand[] = [
  { name: "scan", aliases: [], description: "Assess a target: live web/MCP, source repository, package, deep review, or repair loop" },
  { name: "findings", aliases: [], description: "Browse and manage persisted findings", options: true },
  { name: "automation", aliases: ["automations"], description: "Discover templates, inspect saved automations, and run an automation" },
  { name: "threads", aliases: [], description: "Inspect and control threads on the selected engine" },
  { name: "agents", aliases: [], description: "Create, inspect and control Agents" },
  { name: "lab", aliases: [], description: "Developer commands: research, improve, console, mcp-server, runs", hidden: true },
  { name: "web", aliases: [], description: "Run the local browser console and operations workspace", options: true },
  { name: "api", aliases: [], description: "Call a trusted engine API with deterministic JSON output (defaults to its handshake)", options: true, arguments: "[path]" },
  { name: "computers", aliases: ["worker"], description: "Add and manage remote computers" },
  { name: "doctor", aliases: [], description: "Check local runtime prerequisites and suggest the next command", options: true },
  { name: "config", aliases: [], description: "Inspect, export, and import engine configuration (global and project layers)" },
  { name: "models", aliases: [], description: "List available models and choose the default (the web Models page)" },
  { name: "plugin", aliases: [], description: "Find, install, enable, inspect, run, and author plugins" },
  { name: "skills", aliases: [], description: "Browse, add, create, edit, import, export and link skills" },
  { name: "memory", aliases: [], description: "List, disable, export and import what 0 remembers across threads" },
];

export function findTopLevel(name: string): TopLevelCommand | undefined {
  return TOP_LEVEL_COMMANDS.find((command) => command.name === name || command.aliases.includes(name));
}
