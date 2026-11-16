/**
 * Help snapshot of every command node (visible and hidden). The lean-engine plan
 * (docs/design/lean-engine.md) removes code in steps; this fixture makes each step's
 * effect on the CLI surface an explicit, reviewable diff of `help-snapshot.txt`.
 * Regenerate with `UPDATE_HELP_SNAPSHOT=1 pnpm --filter @0/cli exec vitest run help-snapshot`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { configureGroupedHelp, registerCommandTree } from "../tree.js";
import { loadAllTopLevel, registerLazyCommandTree } from "../lazy-tree.js";
import { addCommandStubs, createRootProgram } from "../../program.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/help-snapshot.txt", import.meta.url));

export function helpSnapshot(program: Command): string {
  const sections: string[] = [];
  const walk = (command: Command, path: string): void => {
    command.configureOutput({ getOutHelpWidth: () => 100, getErrHelpWidth: () => 100 });
    sections.push(`### ${path}${(command as unknown as { _hidden?: boolean })._hidden ? " (hidden)" : ""}\n${command.helpInformation()}`);
    for (const sub of [...command.commands].sort((a, b) => a.name().localeCompare(b.name()))) walk(sub, `${path} ${sub.name()}`);
  };
  walk(program, "0");
  return `${sections.join("\n")}\n`;
}

// Same root as index.ts (name, description, positional options); the real `--version` flag is not part of the fixture.
function plainRoot(): Command {
  return new Command().name("0").description("Security agents for your repositories. Run 0 to open the console.").enablePositionalOptions();
}

export function eagerProgram(): Command {
  const program = plainRoot();
  registerCommandTree(program);
  configureGroupedHelp(program);
  return program;
}

describe("help snapshot", () => {
  it("matches the recorded help of every command", () => {
    const actual = helpSnapshot(eagerProgram());
    if (process.env["UPDATE_HELP_SNAPSHOT"]) writeFileSync(FIXTURE, actual);
    expect(actual).toBe(readFileSync(FIXTURE, "utf8"));
  });

  it("the lazy tree has the identical help for every node", async () => {
    const program = plainRoot();
    await loadAllTopLevel(program);
    configureGroupedHelp(program);
    expect(helpSnapshot(program)).toBe(readFileSync(FIXTURE, "utf8"));
  });

  it("root help from the static manifest alone matches the real root help", () => {
    const stubbed = plainRoot();
    addCommandStubs(stubbed);
    const real = eagerProgram();
    for (const program of [stubbed, real]) program.configureOutput({ getOutHelpWidth: () => 100 });
    expect(stubbed.helpInformation()).toBe(real.helpInformation());
    expect(stubbed.commands.map((c) => [c.name(), c.aliases(), (c as unknown as { _hidden?: boolean })._hidden === true]).sort())
      .toEqual(real.commands.map((c) => [c.name(), c.aliases(), (c as unknown as { _hidden?: boolean })._hidden === true]).sort());
  });

  it("loading only the invoked command leaves every other name known and gives the same help", async () => {
    const real = eagerProgram();
    for (const [argv, path] of [[["doctor", "--help"], ["doctor"]], [["help", "scan"], ["scan"]], [["threads", "list"], ["threads"]], [["lab", "runs"], ["lab"]]] as const) {
      const program = createRootProgram();
      await registerLazyCommandTree(program, argv);
      expect(program.commands.map((c) => c.name()).sort()).toEqual(real.commands.map((c) => c.name()).sort());
      const pick = (root: Command) => root.commands.find((c) => c.name() === path[0])!;
      expect(helpSnapshot(pick(program))).toBe(helpSnapshot(pick(real)));
    }
  });
});
