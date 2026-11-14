import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { rewriteMovedCommand } from "./command-aliases.js";
import { registerCommandTree } from "./commands/tree.js";
import { rewriteScanArgs } from "./routing.js";

function tree(): Command {
  const program = new Command();
  registerCommandTree(program);
  return program;
}
function resolves(program: Command, path: readonly string[]): boolean {
  let node = program;
  for (const word of path) {
    const next = node.commands.find((command) => command.name() === word);
    if (!next) return false;
    node = next;
  }
  return true;
}

describe("command tree", () => {
  it("keeps the visible top-level surface small", () => {
    expect(tree().commands.length).toBeLessThanOrEqual(26);
  });

  it("registers the nested groups", () => {
    const program = tree();
    for (const path of [
      ["research", "kernel"], ["research", "hunt"], ["runs", "history"], ["runs", "relaunch"],
      ["findings", "triage"], ["improve", "bench"], ["plugin", "author"],
      ["scan", "web"], ["scan", "source"], ["scan", "package"], ["scan", "deep"], ["scan", "repair"], ["scan", "campaign"],
    ]) expect(resolves(program, path), path.join(" ")).toBe(true);
  });
});

describe("moved-command aliases", () => {
  it("rewrites an old first word and preserves the rest", () => {
    expect(rewriteMovedCommand(["kernel", "--help"])?.args).toEqual(["research", "kernel", "--help"]);
    expect(rewriteMovedCommand(["resume", "abc"])?.args).toEqual(["runs", "relaunch", "abc"]);
  });

  it("leaves current commands and inherited object keys alone", () => {
    expect(rewriteMovedCommand(["scan"])).toBeUndefined();
    expect(rewriteMovedCommand(["constructor"])).toBeUndefined();
    expect(rewriteMovedCommand([])).toBeUndefined();
  });

  it("only points at paths that exist in the tree", () => {
    const program = tree();
    for (const old of ["hunt", "kernel", "h1", "history", "resume", "triage", "bench", "evolve", "hackstore", "orchestrate", "review", "audit", "secure", "deep-review", "campaign"]) {
      const moved = rewriteMovedCommand([old])!;
      expect(resolves(program, moved.args), old).toBe(true);
    }
  });
});

describe("scan module routing", () => {
  it("routes by target and keeps the legacy --target form", () => {
    expect(rewriteScanArgs(["scan", "https://example.com"])?.slice(0, 4)).toEqual(["scan", "web", "--target", "https://example.com"]);
    expect(rewriteScanArgs(["scan", "--target", "https://example.com", "--depth", "quick"])).toEqual(["scan", "web", "--target", "https://example.com", "--depth", "quick"]);
    expect(rewriteScanArgs(["scan", "npm:left-pad"])?.slice(0, 3)).toEqual(["scan", "package", "left-pad"]);
  });
  it("leaves explicit modules, help and other commands alone", () => {
    expect(rewriteScanArgs(["scan", "source", "."])).toBeUndefined();
    expect(rewriteScanArgs(["scan", "--help"])).toBeUndefined();
    expect(rewriteScanArgs(["scan"])).toBeUndefined();
    expect(rewriteScanArgs(["fix", "."])).toBeUndefined();
  });
});
