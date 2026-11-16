// The old `0 plugin` command group, kept only so old scripts and muscle memory land somewhere. Nothing here installs,
// runs or approves anything: `resolveInvocation` (command-compat.ts) rewrites the verbs that still exist onto
// `0 skills extensions ...`; the rest are stubs that say what replaced them. Hidden from help and completion.
import type { Command } from "commander";
import { EXIT_USAGE, defaultIo, type CommandIo } from "./console-output.js";

const GIT = "removed: extensions are installed from git: 0 skills add <repo>@<sha>";

/** Old verb -> the sentence a stub prints. A verb missing here has a rewrite and never reaches its stub. */
export const PLUGIN_REMOVED: Readonly<Record<string, string>> = {
  run: "removed: an extension's scripts run through bash; there is no plugin runner. See `0 skills extensions info <name>`.",
  init: "removed: write a folder with an extension.json or a SKILL.md, then review it with `0 skills add <folder> --preview`.",
  validate: "removed: review a folder with `0 skills add <folder> --preview`.",
  submit: GIT,
  connectors: "removed: connect services on the Extensions page. Installed extensions: `0 skills extensions list`.",
  connect: "removed: connect services on the Extensions page.",
  disconnect: "removed: disconnect services on the Extensions page.",
  "mcp test": "removed: MCP tools are pinned per tool and checked when they are used. See `0 skills extensions info <name>`.",
  registry: GIT,
};

const MOVED: Readonly<Record<string, string>> = {
  list: "0 skills extensions list", search: "0 skills extensions list", browse: "0 skills catalog", info: "0 skills extensions info <name>",
  enable: "0 skills extensions enable <name>", disable: "0 skills extensions disable <name>", install: "0 skills extensions add <repo>@<sha>",
  "mcp list": "0 skills extensions list", "mcp add": "0 skills extensions mcp <name> --url <url>", "mcp remove": "0 skills extensions remove <name>",
};

export function registerPluginMovedCommand(program: Command, io: CommandIo = defaultIo()): void {
  const plugin = program.command("plugin").description("Moved: see `0 skills extensions`");
  const stub = (parent: Command, verb: string, key: string) => parent.command(verb).description("Moved: see `0 skills extensions`").allowUnknownOption().allowExcessArguments()
    .action(() => { io.err(PLUGIN_REMOVED[key] ?? `moved: use \`${MOVED[key] ?? "0 skills extensions"}\``); io.setExitCode(EXIT_USAGE); });
  for (const verb of ["list", "search", "browse", "install", "enable", "disable", "info", "run", "init", "validate", "submit", "connectors", "connect", "disconnect"]) stub(plugin, verb, verb);
  const mcp = plugin.command("mcp").description("Moved: see `0 skills extensions mcp`").allowUnknownOption().allowExcessArguments()
    .action(() => { io.err("moved: use `0 skills extensions mcp <name> --url <url>`"); io.setExitCode(EXIT_USAGE); });
  for (const verb of ["list", "add", "test", "remove"]) stub(mcp, verb, `mcp ${verb}`);
}
