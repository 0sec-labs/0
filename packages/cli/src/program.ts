import { Command, Option } from "commander";
import { VERSION } from "@0/engine/shared";
import { configureGroupedHelp } from "./commands/layout.js";
import { TOP_LEVEL_COMMANDS } from "./commands/manifest.js";

/** The root command with its name, version and grouped help; no subcommands yet. */
export function createRootProgram(): Command {
  const program = new Command();
  program
    .name("0")
    .description("Security sentinels for your repositories. Run 0 to open the console.")
    .version(VERSION)
    .enablePositionalOptions();
  return program;
}

/** Placeholder for a top-level command that is not loaded: enough for help, suggestions and name checks. */
export function addCommandStubs(program: Command, skip?: ReadonlySet<string>): void {
  for (const entry of TOP_LEVEL_COMMANDS) {
    if (skip?.has(entry.name)) continue;
    const stub = program.command(entry.name, { hidden: entry.hidden === true }).description(entry.description);
    if (entry.aliases.length) stub.aliases([...entry.aliases]);
    if (entry.options) stub.addOption(new Option("--lazy-stub").hideHelp());
    if (entry.arguments) stub.argument(entry.arguments);
  }
  configureGroupedHelp(program);
}
