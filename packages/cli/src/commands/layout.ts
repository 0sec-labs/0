/**
 * Light layout facts about the command tree: where commands live and how the root help
 * is grouped. This file imports only the `commander` types, so the startup fast path can
 * print `0 --help` without loading any command module or the engine.
 */
import { Option, type Command, type Help } from "commander";
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
  ["Work", ["scan", "sbom", "findings", "threads", "sentinels"]],
  ["Setup", ["skills", "models", "computers", "config"]],
];

/** Root `--help`: the visible commands grouped by purpose instead of one flat list. */
export function configureGroupedHelp(program: Command): void {
  program.configureHelp({
    formatHelp(cmd: Command, helper: Help): string {
      const width = Math.max(helper.padWidth(cmd, helper), ...(cmd.parent ? [] : ROOT_OPTIONS.map(([term]) => term.length)));
      const item = (term: string, description: string): string => helper.formatItem(term, width, description, helper);
      const out = [`Usage: ${helper.commandUsage(cmd)}`, "", helper.commandDescription(cmd), ""];
      out.push("Options:", ...helper.visibleOptions(cmd).map((option) => item(helper.optionTerm(option), helper.optionDescription(option))));
      if (!cmd.parent) out.push(...ROOT_OPTIONS.map(([term, description]) => item(term, description)));
      out.push("");
      const visible = new Map(helper.visibleCommands(cmd).map((command) => [command.name(), command]));
      for (const [title, names] of HELP_GROUPS) {
        out.push(`${title}:`);
        for (const name of names) {
          const command = visible.get(name);
          if (command) out.push(item(helper.subcommandTerm(command), helper.subcommandDescription(command)));
        }
        out.push("");
      }
      if (!cmd.parent) out.push("Run `0 <command>` to list its subcommands; `0 <command> <subcommand> --help` for flags.", "", examplesBlock(ROOT_EXAMPLES));
      return out.join("\n").replace(/\n+$/, "\n");
    },
  });
}

/** Headless entry points live outside the command tree (main.ts runs them), so the root help lists them by hand. */
const ROOT_OPTIONS: readonly (readonly [string, string])[] = [
  ["-p, --print <prompt>", "Run one prompt headless: only the answer goes to stdout"],
  ["-c, --continue", "With -p: continue the most recent thread"],
  ["-r, --resume <id>", "With -p: continue a saved thread"],
];
const ROOT_EXAMPLES: readonly string[] = [
  '0 -p "Review ./app for injection bugs"',
  '0 threads start "Map the login flow" --wait',
  "0 findings list --severity high --format json",
  "0 sentinels list --presets",
];
const examplesBlock = (lines: readonly string[]): string => `Examples:\n${lines.map((line) => `  ${line}`).join("\n")}\n`;

/** Short, real examples for the visible commands, keyed by command path. */
const EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  scan: ["0 scan ~/code/app", "0 scan ~/code/app --format sarif -o scan.sarif --fail-on high", "0 scan https://github.com/acme/app --budget 2 --format json"],
  sbom: ["0 sbom generate . -o sbom.cdx.json", "0 sbom check sbom.cdx.json", "0 sbom check sbom.cdx.json --format json"],
  "sbom generate": ["0 sbom generate . -o sbom.cdx.json", "0 sbom generate ~/code/app --name app"],
  "sbom check": ["0 sbom check sbom.cdx.json", "0 sbom check sbom.cdx.json --format json"],
  findings: ["0 findings list --severity high", "0 findings show 3f2a", '0 findings update 3f2a --status accepted --note "known"'],
  "findings list": ["0 findings list --severity high --status verified", "0 findings list --format json", "0 findings list --format sarif -o findings.sarif"],
  "findings show": ["0 findings show 3f2a"],
  "findings update": ['0 findings update 3f2a --status false-positive --reason "test fixture"'],
  threads: ['0 threads start "Map the login flow" --folder ~/code/app --wait', "0 threads list", "0 threads show <id>", '0 threads send <id> "Now the logout path" --wait', "0 threads stop <id>"],
  "threads list": ["0 threads list", "0 threads list --format json"],
  "threads show": ["0 threads show <id>", "0 threads show <id> --wait", "0 threads show <id> --format json"],
  "threads start": ['id=$(0 threads start "Review ./app for injection bugs")', '0 threads start "Summarize open findings" --wait', '0 threads start "Audit CI" --skill workflow-hardening --wait --timeout 900'],
  "threads send": ['0 threads send <id> "Also check the API routes" --wait', '0 threads send new "Review ./app"'],
  "threads stop": ["0 threads stop <id>"],
  sentinels: ["0 sentinels list --presets", '0 sentinels set --create --preset dependency-watcher --name "Nightly check"', "0 sentinels set <id> --state active", '0 sentinels run <id> --task "Re-test login" --yes'],
  "sentinels list": ["0 sentinels list", "0 sentinels list <id>", "0 sentinels list --presets"],
  "sentinels run": ['0 sentinels run <id> --task "Re-test login" --yes', "0 sentinels run <id> --history"],
  "sentinels set": ['0 sentinels set --create --preset pr-security-reviewer --name "PR review"', "0 sentinels set <id> --state paused", "0 sentinels set <id> --trigger add --kind schedule --frequency daily --at 09:00", "0 sentinels set <id> --files put NOTES.md --file ./notes.md"],
  skills: ["0 skills list", "0 skills list pr-diff-review", "0 skills add owner/repo@<full-sha>", "0 skills add ./my-skills"],
  "skills list": ["0 skills list", "0 skills list pr-diff-review", "0 skills list --catalog"],
  "skills add": ["0 skills add ./my-skills", "0 skills add owner/repo@<full-sha> --yes"],
  models: ["0 models connect", "0 models connect anthropic --key-env ANTHROPIC_API_KEY", "0 models list", "0 models set claude-sonnet-4-6 --provider anthropic"],
  "models list": ["0 models list", "0 models list --provider anthropic --format json"],
  "models set": ["0 models set", "0 models set claude-sonnet-4-6 --provider anthropic"],
  "models connect": ["0 models connect", "0 models connect anthropic --key-env ANTHROPIC_API_KEY", "0 models connect anthropic --test", "0 models connect anthropic --remove --yes"],
  computers: ["0 computers list", "0 computers add --ssh me@build-box", "0 computers stop <id>"],
  "computers add": ["0 computers add --ssh me@build-box"],
  config: ["0 config doctor", "0 config get approvals", "0 config set approvals ask", "0 config get --all"],
  "config get": ["0 config get", "0 config get approvals", "0 config get --all --format json"],
  "config set": ["0 config set approvals ask", "0 config set approvals auto --project"],
  "config doctor": ["0 config doctor", "0 config doctor --fix"],
};

const isLeaf = (command: Command): boolean => command.commands.length === 0;
const longs = (command: Command): Set<string> => new Set(command.options.map((option) => option.long ?? ""));

/**
 * Every list/show command takes `--format text|json` and the short `--json`; one of them is documented
 * (`--format`), the other still works. Commands whose own --format means a file type (export) keep it.
 */
function unifyOutputFlags(command: Command): void {
  const flags = longs(command);
  if (flags.has("--json") && !flags.has("--format")) {
    const json = command.options.find((option) => option.long === "--json")!;
    json.hidden = true;
    command.addOption(new Option("--format <format>", "Output: text or json").choices(["text", "json"]));
    command.on("option:format", (value: string) => command.setOptionValue("json", value === "json"));
  } else if (flags.has("--format") && !flags.has("--json")) {
    const format = command.options.find((option) => option.long === "--format")!;
    if (!(format.argChoices ?? []).length && /json or text/i.test(format.description)) {
      command.addOption(new Option("--json").hideHelp());
      command.on("option:json", () => command.setOptionValue("format", "json"));
    }
  }
}

/** A group with no subcommand prints its help (exit 0); an unknown word is a usage error with the closest match. */
function groupBehaviour(top: Command): void {
  if (!top.commands.length) return;
  const hadAction = (top as unknown as { _actionHandler?: unknown })._actionHandler != null;
  top.helpCommand(true);
  if (hadAction) return; // findings: its own action lists findings
  top.allowExcessArguments(true).action(function (this: Command) {
    if (this.args[0]) (this as unknown as { unknownCommand(): never }).unknownCommand();
    this.help();
  });
}

function polish(command: Command, path: string): void {
  const examples = EXAMPLES[path];
  if (examples && !(command as unknown as { _hidden?: boolean })._hidden) command.addHelpText("after", `\n${examplesBlock(examples)}`);
  for (const option of command.options) if (option.long === "--scan") option.hidden = true;
  if (isLeaf(command)) unifyOutputFlags(command);
  for (const sub of command.commands) polish(sub, `${path} ${sub.name()}`);
}

interface NewFormStub { readonly name: string; readonly args: string; readonly description: string; readonly usage?: string; readonly options?: readonly (readonly [string, string])[] }

/** Visible subcommands that have no implementation command of their own: `command-grammar.ts` rewrites them before parsing, so the action only runs on incomplete input. */
const NEW_FORM_STUBS: Readonly<Record<string, readonly NewFormStub[]>> = {
  findings: [{ name: "update", args: "<id>", description: "Change a finding's status", usage: "0 findings update <id> --status accepted|suppressed|open|false-positive [--note <text>]", options: [["--status <status>", "accepted | suppressed | open | false-positive"], ["--note <text>", "Why (optional)"], ["--reason <text>", "Why; required with false-positive"], ["--db-path <path>", "Path to SQLite database"]] }],
  models: [
    { name: "set", args: "[model]", description: "Show or choose the default model", usage: "0 models set <model> --provider <id>", options: [["--provider <provider>", "Provider of the model"]] },
    { name: "connect", args: "[provider]", description: "Add, list, test or remove a provider connection", options: [["--key-env <VAR>", "Add: read the API key from this environment variable"], ["--stdin", "Add: read the API key from stdin"], ["--list", "List connections (the default with no provider)"], ["--test", "Test a connection"], ["--remove", "Remove a connection (with --yes)"]] },
  ],
  config: [{ name: "doctor", args: "[checks...]", description: "Check this machine and the engine, then suggest the next command", options: [["--fix", "Repair the local database"], ["--json", "Print JSON"]] }],
};

/** Flags the new grammar adds to commands that already existed; shown at the end of their help. */
const NEW_FORM_HELP: Readonly<Record<string, string>> = {
  "threads list": "With an id: show that thread. Then --events, --export, --rename <title>, --set, --clear, --close, --archive or --delete act on it.",
  "threads send": "`send new <prompt>` starts a thread. With an id: --retry, --resume or --decide <decision-id>.",
  "sentinels list": "With an id: show that Sentinel. --presets lists the starting points.",
  "sentinels run": "--history lists past activations.",
  "sentinels set": "--create --preset <id> --name <name> makes a Sentinel. With an id: --state active|paused|acknowledged|archived|deleted, --trigger <list|add|enable|disable|check|rm> ... (see `0 sentinels set <id> --trigger add --help`), --files <list|get|put|rm> ...",
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
    // A visible command with no subcommands (`scan`) still prints its examples.
    else if (EXAMPLES[top.name()]) top.addHelpText("after", `\n${examplesBlock(EXAMPLES[top.name()]!)}`);
    return;
  }
  top.description(description);
  const topHelp = NEW_FORM_HELP[top.name()];
  if (topHelp) top.addHelpText("after", `\n${topHelp}\n`);
  for (const stub of NEW_FORM_STUBS[top.name()] ?? []) {
    if (top.commands.some((command) => command.name() === stub.name)) continue;
    const added = top.createCommand(stub.name).description(stub.description).arguments(stub.args).allowUnknownOption().allowExcessArguments();
    for (const [flags, text] of stub.options ?? []) added.option(flags, text);
    added.action(() => { throw new Error(`${stub.usage ? `Usage: ${stub.usage}. ` : "Incomplete. "}See \`0 ${top.name()} ${stub.name} --help\`.`); });
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
  for (const command of top.commands) polish(command, `${top.name()} ${command.name()}`);
  const own = EXAMPLES[top.name()];
  if (own) top.addHelpText("after", `\n${examplesBlock(own)}`);
  groupBehaviour(top);
}

/** Usage errors exit 2 (not commander's 1) and say where to look; `--help` and `--version` exit 0. Applied to the finished tree. */
export function applyErrorPolicy(command: Command, path = "0"): void {
  command.exitOverride((error) => process.exit(error.exitCode === 0 || error.code === "commander.helpDisplayed" || error.code === "commander.version" ? 0 : 2));
  command.configureOutput({
    outputError: (text, write) => { write(`${text.replace(/\s+$/, "")}\nRun \`${path} --help\` for usage.\n`); },
  });
  for (const sub of command.commands) applyErrorPolicy(sub, `${path} ${sub.name()}`);
}
