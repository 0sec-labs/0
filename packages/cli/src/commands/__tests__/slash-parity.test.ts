/**
 * The chat slash commands and the CLI are one vocabulary. Every slash command that names a CLI
 * command must resolve to a real one, and every visible top-level CLI noun must either have a
 * slash entry or be listed here as CLI-only. A rename in the command tree fails this test.
 */
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "@0/engine/shared";
import { registerCommandTree } from "../tree.js";

/** Nouns that make no sense in a chat composer. */
const CLI_ONLY = new Set(["scan"]);

const isHidden = (command: Command): boolean => (command as unknown as { _hidden?: boolean })._hidden === true;

/** The visible command a `cli` path names; the trailing `--flags` are the new-grammar options and are not part of the path. */
function resolve(root: Command, path: string): Command | undefined {
  let node: Command | undefined = root;
  for (const word of path.split(" ").filter((part) => !part.startsWith("-"))) {
    node = node?.commands.find((c) => c.name() === word && !isHidden(c));
    if (!node) return undefined;
  }
  return node;
}

const program = new Command("0");
registerCommandTree(program);

describe("slash commands match the CLI", () => {
  it("every slash cli path is a real CLI command", () => {
    const missing = SLASH_COMMANDS.filter((c) => c.cli && !resolve(program, c.cli)).map((c) => `/${c.name} -> 0 ${c.cli}`);
    expect(missing).toEqual([]);
  });

  it("a command named like a visible CLI path points at that path", () => {
    for (const c of SLASH_COMMANDS.filter((x) => x.name.includes(" ") && resolve(program, x.name))) expect(c.cli?.split(" --")[0], c.name).toBe(c.name);
  });

  it("every visible top-level CLI noun has a slash entry or is explicitly CLI-only", () => {
    const covered = new Set(SLASH_COMMANDS.flatMap((c) => (c.cli ? [c.cli.split(" ")[0]!] : [])));
    const uncovered = program.commands
      .filter((c) => !(c as unknown as { _hidden?: boolean })._hidden && c.name() !== "help")
      .map((c) => c.name())
      .filter((name) => !covered.has(name) && !CLI_ONLY.has(name));
    expect(uncovered).toEqual([]);
  });

  it("CLI-only nouns really exist and have no slash command", () => {
    for (const noun of CLI_ONLY) {
      expect(resolve(program, noun), noun).toBeDefined();
      expect(SLASH_COMMANDS.some((c) => c.name.split(" ")[0] === noun)).toBe(false);
    }
  });
});
