import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { resolveInvocation } from "../../command-grammar.js";
import { readableError } from "../error-text.js";
import { applyErrorPolicy } from "../layout.js";
import { loadAllTopLevel } from "../lazy-tree.js";
import { addCommandStubs, createRootProgram } from "../../program.js";

async function tree(): Promise<Command> {
  const program = createRootProgram();
  await loadAllTopLevel(program);
  return program;
}
const visible = (command: Command): Command[] => command.commands.filter((sub) => !(sub as unknown as { _hidden?: boolean })._hidden);
const find = (program: Command, ...path: string[]): Command => path.reduce<Command>((node, name) => node.commands.find((sub) => sub.name() === name)!, program);

describe("CLI usability", () => {
  it("every visible top-level command prints an Examples block, and every visible list/show takes --format", async () => {
    const program = await tree();
    const missing: string[] = [];
    for (const top of visible(program)) {
      if (!/Examples:/.test(renderedHelp(top))) missing.push(top.name());
      for (const sub of visible(top)) {
        const takesFormat = sub.options.some((option) => option.long === "--format" || option.long === "--json");
        // findings list and show reach their formats through the grammar and the show command's own --json.
        if (/^(list|show)$/.test(sub.name()) && !takesFormat && top.name() !== "findings") missing.push(`${top.name()} ${sub.name()} has no --format`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("--json is accepted next to --format wherever either exists, and --format json sets it", async () => {
    const program = await tree();
    const memoryList = find(program, "models", "list");
    expect(memoryList.options.find((o) => o.long === "--json")?.hidden).toBe(true);
    expect(memoryList.options.find((o) => o.long === "--format")?.argChoices).toEqual(["text", "json"]);
    const threadsList = find(program, "threads", "list");
    expect(threadsList.options.some((o) => o.long === "--json" && o.hidden)).toBe(true);
  });

  it("a command group with no subcommand prints its help and exits 0; an unknown word suggests the closest", async () => {
    const program = await tree();
    applyErrorPolicy(program);
    const writes: string[] = [];
    program.configureOutput({ writeOut: (t) => writes.push(t), writeErr: (t) => writes.push(`ERR ${t}`) });
    const threads = find(program, "threads");
    threads.configureOutput({ writeOut: (t) => writes.push(t), writeErr: (t) => writes.push(`ERR ${t}`), outputError: (t, write) => write(t) });
    const exits: number[] = [];
    for (const node of [program, threads]) node.exitOverride((error) => { exits.push(error.exitCode); throw error; });
    await expect(program.parseAsync(["threads"], { from: "user" })).rejects.toMatchObject({ exitCode: 0 });
    expect(writes.join("")).toContain("Commands:");
    expect(writes.join("")).not.toContain("ERR");
    await expect(program.parseAsync(["threads", "lst"], { from: "user" })).rejects.toMatchObject({ code: "commander.unknownCommand" });
    expect(writes.join("")).toContain("Did you mean list?");
  });

  it("the grammar maps --json and --format on findings list, and bare findings to help", () => {
    expect(resolveInvocation(["findings"])).toEqual(["findings", "--help"]);
    expect(resolveInvocation(["findings", "list", "--json", "--severity", "high"])).toEqual(["findings", "export", "--severity", "high", "--format", "json"]);
    expect(resolveInvocation(["findings", "list", "--format", "text"])).toEqual(["findings", "list"]);
    expect(resolveInvocation(["findings", "list", "--format", "sarif"])).toEqual(["findings", "export", "--format", "sarif"]);
    expect(resolveInvocation(["findings", "list", "--severity", "high"])).toEqual(["findings", "list", "--severity", "high"]);
    expect(resolveInvocation(["sentinels", "set", "s1", "--trigger", "add", "--help"])).toEqual(["sentinels", "triggers", "add", "--help"]);
  });

  it("validation errors from the engine read as one line, a missing thread says where to look", () => {
    expect(readableError(JSON.stringify([{ path: ["automationIds", 0], message: "Too small" }, { message: "Bad" }]))).toBe("automationIds.0: Too small; Bad");
    expect(readableError("Console thread was not found.")).toBe("Thread not found. List threads with `0 threads list`.");
    expect(readableError("[not json")).toBe("[not json");
  });

  it("the root help lists the headless flags and examples without loading any command", () => {
    const program = createRootProgram();
    addCommandStubs(program);
    program.configureOutput({ getOutHelpWidth: () => 100 });
    const help = program.helpInformation();
    expect(help).toMatch(/-p, --print <prompt>/);
    expect(help).toMatch(/Examples:\n {2}0 -p /);
  });
});

function renderedHelp(command: Command): string {
  const chunks: string[] = [];
  command.configureOutput({ writeOut: (value) => chunks.push(value), writeErr: (value) => chunks.push(value) });
  command.outputHelp();
  return chunks.join("");
}
