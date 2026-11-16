/**
 * Light layout facts about the command tree: where commands live and how the root help
 * is grouped. This file imports only the `commander` types, so the startup fast path can
 * print `0 --help` without loading any command module or the engine.
 */
import type { Command, Help } from "commander";

export type Registrar = (parent: Command) => void;

export function child(parent: Command, name: string): Command {
  const found = parent.commands.find((command) => command.name() === name);
  if (!found) throw new Error(`Command tree: \`${name}\` must be registered before its children`);
  return found;
}

export function nest(parent: Command, group: string, registrars: readonly Registrar[]): void {
  const target = child(parent, group);
  for (const register of registrars) register(target);
}

/** Commands that moved under another group. The old top-level name keeps working through `command-aliases.ts`. */
export const NEW_HOME: Readonly<Record<string, string>> = {
  fix: "scan", verify: "scan", deps: "scan", eval: "scan", "agent-assure": "scan", disclose: "scan",
  reports: "findings",
  connections: "models", usage: "models",
  "audit-log": "config", team: "config", db: "config", github: "config",
  upgrade: "doctor", workbench: "doctor", checks: "doctor",
  research: "lab", improve: "lab", console: "lab", "mcp-server": "lab", runs: "lab",
};

/** Move already-registered top-level commands under their new parent, keeping each command object (and handler) as is. `only` limits it to one parent (the lazy loader builds one group at a time). */
export function adoptCommands(program: Command, only?: string): void {
  for (const [name, group] of Object.entries(NEW_HOME)) {
    if (only !== undefined && group !== only) continue;
    const index = program.commands.findIndex((command) => command.name() === name);
    if (index < 0) throw new Error(`Command tree: \`${name}\` is not registered`);
    const [moved] = (program.commands as Command[]).splice(index, 1);
    child(program, group).addCommand(moved!);
  }
}

export const HELP_GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ["Work", ["scan", "findings", "threads", "agents", "automation"]],
  ["Setup", ["models", "computers", "skills", "plugin", "memory", "config"]],
  ["Run", ["web", "doctor", "api"]],
];

/** Root `--help`: the visible commands grouped by purpose instead of one flat list. */
export function configureGroupedHelp(program: Command): void {
  program.configureHelp({
    formatHelp(cmd: Command, helper: Help): string {
      const width = helper.padWidth(cmd, helper);
      const columns = helper.helpWidth ?? 80;
      const item = (term: string, description: string): string => {
        const fullText = `${term.padEnd(width)}  ${description}`;
        return "  " + (description ? helper.wrap(fullText, columns - 2, width + 4) : term);
      };
      const out = [`Usage: ${helper.commandUsage(cmd)}`, "", helper.commandDescription(cmd), ""];
      out.push("Options:", ...helper.visibleOptions(cmd).map((option) => item(helper.optionTerm(option), helper.optionDescription(option))), "");
      const visible = new Map(helper.visibleCommands(cmd).map((command) => [command.name(), command]));
      for (const [title, names] of HELP_GROUPS) {
        out.push(`${title}:`);
        for (const name of names) {
          const command = visible.get(name);
          if (command) out.push(item(helper.subcommandTerm(command), helper.subcommandDescription(command)));
        }
        out.push("");
      }
      return out.join("\n").replace(/\n+$/, "\n");
    },
  });
}
