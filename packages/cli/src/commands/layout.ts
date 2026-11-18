/**
 * Light layout facts about the command tree: where commands live and how the root help
 * is grouped. This file imports only the `commander` types, so the startup fast path can
 * print `0 --help` without loading any command module or the engine.
 */
import type { Command, Help } from "commander";
import { GROUP_DESCRIPTIONS, TOP_LEVEL_COMMANDS, VISIBLE_SUBCOMMANDS } from "./manifest.js";

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

/** Commands registered at the top by their module, then moved under their group. */
export const NEW_HOME: Readonly<Record<string, string>> = {
  reports: "findings",
  connections: "models", usage: "models",
  "audit-log": "config", team: "config", db: "config", github: "config",
  upgrade: "doctor", workbench: "doctor",
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
  ["Work", ["findings", "threads", "sentinels"]],
  ["Setup", ["skills", "memory", "models", "computers", "config"]],
];

/** Root `--help`: the visible commands grouped by purpose instead of one flat list. */
export function configureGroupedHelp(program: Command): void {
  program.configureHelp({
    formatHelp(cmd: Command, helper: Help): string {
      const width = helper.padWidth(cmd, helper);
      const item = (term: string, description: string): string => helper.formatItem(term, width, description, helper);
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

interface NewFormStub { readonly name: string; readonly args: string; readonly description: string; readonly options?: readonly (readonly [string, string])[] }

/** Visible subcommands that have no implementation command of their own: `command-grammar.ts` rewrites them before parsing, so the action only runs on incomplete input. */
const NEW_FORM_STUBS: Readonly<Record<string, readonly NewFormStub[]>> = {
  findings: [{ name: "update", args: "<id>", description: "Change a finding's status", options: [["--status <status>", "accepted | suppressed | open | false-positive"], ["--note <text>", "Why (optional)"], ["--reason <text>", "Why; required with false-positive"], ["--db-path <path>", "Path to SQLite database"]] }],
  models: [
    { name: "set", args: "[model]", description: "Show or choose the default model", options: [["--provider <provider>", "Provider of the model"]] },
    { name: "connect", args: "[provider]", description: "Add, list, test or remove a provider connection", options: [["--list", "List connections"], ["--test", "Test a connection"], ["--remove", "Remove a connection"]] },
  ],
  config: [{ name: "doctor", args: "[checks...]", description: "Check this machine and the engine, then suggest the next command", options: [["--fix", "Repair the local database"]] }],
};

/** Flags the new grammar adds to commands that already existed; shown at the end of their help. */
const NEW_FORM_HELP: Readonly<Record<string, string>> = {
  "threads list": "With an id: show that thread. Then --events, --export, --rename <title>, --set, --clear, --close, --archive or --delete act on it.",
  "threads send": "`send new <prompt>` starts a thread. With an id: --retry, --resume or --decide <decision-id>.",
  "sentinels list": "With an id: show that Sentinel. --presets lists the starting points. --automation lists saved automations (with an id or --template: shows one).",
  "sentinels run": "--history lists past activations.",
  "sentinels set": "--create makes a Sentinel. With an id: --state active|paused|acknowledged|archived|deleted, --trigger <list|add|enable|disable|check|rm> ..., --files <list|get|put|rm> ... `--automation <create|edit|duplicate|delete|versions|rollback> ...` manages saved automations.",
  "skills list": "With a name: show that skill. --catalog browses the catalog. Extensions: `0 skills extensions list|info|enable|disable|update|remove`; --info, --enable, --disable and --mcp-remove on a name reach them.",
  "skills add": "<src> may be a catalog id, a repository, a folder of skills or a bundle. An extension is <repo>@<full sha>: you see one prompt first. Also: --mcp <url> adds an MCP server as a local extension, --preview checks a folder, --remove <name> removes a skill.",
  "models list": "Also: --usage shows tokens and cost, --recommended the suggested models.",
  "computers list": "--hosts lists SSH hosts you could add.",
  "computers add": "--repair <id> reconnects a computer.",
  "config get": "No key: show the configuration. --all lists every setting, --export [file] writes it. Namespaces: audit, team, github, api.keys.",
  "config set": "--from-file <file> imports, --reset [keys...] resets. Namespaces: api.key <name> [--revoke <id>], team <init|add-user>, db <repair|reset>, github <connect|repos>.",
  "findings list": "Also: --format sarif|json|md exports, --import <report> imports a report.",
};

function setHidden(command: Command, hidden: boolean): void {
  (command as unknown as { _hidden: boolean })._hidden = hidden;
}

/** Make `top` the 0.35 surface: its description, only the listed subcommands visible, and the new-grammar help. Everything old stays registered but hidden. */
export function applyNewSurface(top: Command): void {
  const visible = VISIBLE_SUBCOMMANDS[top.name()];
  const description = GROUP_DESCRIPTIONS[top.name()];
  if (!visible || !description) {
    if (TOP_LEVEL_COMMANDS.some((entry) => entry.name === top.name() && entry.hidden)) setHidden(top, true);
    return;
  }
  top.description(description);
  const topHelp = NEW_FORM_HELP[top.name()];
  if (topHelp) top.addHelpText("after", `\n${topHelp}\n`);
  for (const stub of NEW_FORM_STUBS[top.name()] ?? []) {
    if (top.commands.some((command) => command.name() === stub.name)) continue;
    const added = top.createCommand(stub.name).description(stub.description).arguments(stub.args).allowUnknownOption().allowExcessArguments();
    for (const [flags, text] of stub.options ?? []) added.option(flags, text);
    const choices = (stub.options ?? []).map(([flags, text]) => `${flags} (${text})`).join(", ");
    added.action(() => { throw new Error(`${choices ? `Missing or unrecognised option. Use ${choices}. ` : "Incomplete. "}See \`0 ${top.name()} ${stub.name} --help\`.`); });
    top.addCommand(added);
  }
  // Visible subcommands first, in the documented order.
  const rank = (command: Command): number => { const at = visible.indexOf(command.name()); return at < 0 ? visible.length : at; };
  (top.commands as Command[]).sort((a, b) => rank(a) - rank(b));
  for (const command of top.commands) {
    const keep = visible.includes(command.name());
    setHidden(command, !keep);
    const hide = (node: Command): void => { for (const child of node.commands) { setHidden(child, true); hide(child); } };
    hide(command);
    const extra = NEW_FORM_HELP[`${top.name()} ${command.name()}`];
    if (extra && keep) command.addHelpText("after", `\n${extra}\n`);
  }
}
