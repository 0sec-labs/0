import { Option, type Command } from "commander";

const announced = new Set<string>();

/**
 * Declare `current` (the documented spelling) plus a hidden `legacy` alias that writes to the same
 * attribute. Old spellings keep working; one stderr notice per flag per process points to the new one.
 */
function withAlias(command: Command, current: Option, legacy: string): Command {
  const legacyFlag = legacy.split(/[ <]/)[0]!;
  const target = current.attributeName();
  command.addOption(current);
  command.addOption(new Option(legacy).hideHelp());
  command.on(`option:${legacyFlag.slice(2)}`, (value: unknown) => {
    command.setOptionValue(target, value == null ? true : value);
    if (!announced.has(legacyFlag)) {
      announced.add(legacyFlag);
      process.stderr.write(`Notice: ${legacyFlag} is deprecated; use ${current.long}.\n`);
    }
  });
  return command;
}

export interface EngineOptionText { engine?: string; enginesConfig?: string }

/** `--engine <id>` and `--engines-config <path>` with hidden `--backend` and `--backends-config` aliases. */
export function engineOptions(command: Command, text: EngineOptionText = {}): Command {
  withAlias(command, new Option("--engine <id>", text.engine ?? "Use a registered remote engine"), "--backend <id>");
  return enginesConfigOption(command, text.enginesConfig);
}

/** `--engines-config <path>` with a hidden `--backends-config` alias, for commands that only read the registry. */
export function enginesConfigOption(command: Command, description = "Operator engine connection registry JSON file"): Command {
  return withAlias(command, new Option("--engines-config <path>", description), "--backends-config <path>");
}

/** `--chat <id>` with a hidden `--session` alias. */
export function chatOption(command: Command, description: string, required = false): Command {
  const current = required ? new Option("--chat <id>", description).makeOptionMandatory() : new Option("--chat <id>", description);
  return withAlias(command, current, "--session <id>");
}

/** `--automations` with a hidden `--workflows` alias. */
export function automationsOption(command: Command, description: string): Command {
  return withAlias(command, new Option("--automations", description).default(false), "--workflows");
}
