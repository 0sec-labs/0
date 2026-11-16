import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { rewriteMovedCommand, shouldPrintMovedNotice } from "./command-aliases.js";
import { configureGroupedHelp, NEW_HOME, registerCommandTree } from "./commands/tree.js";
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
  it("keeps nine visible top-level commands plus the hidden old names and `lab`", () => {
    const program = tree();
    const visible = program.commands.filter((command) => !(command as unknown as { _hidden: boolean })._hidden).map((command) => command.name());
    expect(visible.sort()).toEqual(["agents", "computers", "config", "findings", "memory", "models", "scan", "skills", "threads"]);
    expect(program.commands.map((command) => command.name()).sort()).toEqual([...visible, "api", "automation", "doctor", "lab", "plugin", "web"].sort());
  });

  it("groups the root help by purpose and hides lab and the old names", () => {
    const program = tree();
    configureGroupedHelp(program);
    const help = program.helpInformation();
    expect(help).toMatch(/Work:\n\s+scan[\s\S]*Setup:\n\s+skills/);
    for (const hidden of ["lab", "web", "doctor", "plugin", "automation", "api"]) expect(help).not.toMatch(new RegExp(`^\\s+${hidden}\\b`, "m"));
  });

  it("registers the nested groups", () => {
    const program = tree();
    for (const path of [
      ["lab", "research", "kernel"], ["lab", "research", "hunt"], ["lab", "runs", "history"], ["lab", "runs", "relaunch"],
      ["findings", "triage"], ["automation", "list"], ["threads", "list"], ["lab", "improve", "bench"], ["plugin", "init"], ["plugin", "validate"], ["plugin", "submit"], ["plugin", "mcp", "add"], ["skills", "list"], ["memory", "list"], ["agents", "list"], ["threads", "start"], ["models", "connections", "list"], ["scan", "fix"], ["findings", "reports", "import"], ["config", "github", "status"], ["doctor", "upgrade"], ["doctor", "workbench", "status"],
      ["scan", "web"], ["scan", "source"], ["scan", "package"], ["scan", "deep"], ["scan", "repair"], ["scan", "campaign"],
    ]) expect(resolves(program, path), path.join(" ")).toBe(true);
  });
});

describe("moved-command aliases", () => {
  it("keeps the old thread names as silent aliases", () => {
    for (const old of ["chats", "missions", "sessions"]) expect(rewriteMovedCommand([old, "list", "--saved"])?.args).toEqual(["threads", "list", "--saved"]);
    expect(rewriteMovedCommand(["chats", "list"])?.notice).toBe("");
  });

  it("rewrites an old first word and preserves the rest", () => {
    expect(rewriteMovedCommand(["kernel", "--help"])?.args).toEqual(["lab", "research", "kernel", "--help"]);
    expect(rewriteMovedCommand(["resume", "abc"])?.args).toEqual(["lab", "runs", "relaunch", "abc"]);
  });

  it("maps the retired hackstore command onto plugin", () => {
    expect(rewriteMovedCommand(["hackstore", "init", "x"])?.args).toEqual(["plugin", "init", "x"]);
    expect(rewriteMovedCommand(["hackstore", "validate", "."])?.args).toEqual(["plugin", "validate", "."]);
    expect(rewriteMovedCommand(["hackstore", "prepare-submission", "."])?.args).toEqual(["plugin", "submit", "."]);
  });

  it("maps workflow and sessions onto automation and chats", () => {
    expect(rewriteMovedCommand(["workflow", "run", "x"])?.args).toEqual(["automation", "run", "x"]);
    expect(rewriteMovedCommand(["sessions", "list"])?.args).toEqual(["threads", "list"]);
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

/** The 35 top-level commands before the consolidation. Every one must keep working. */
const OLD_TOP_LEVEL = [
  "reports", "scan", "fix", "verify", "deps", "agent-assure", "eval", "disclose", "findings", "automation", "threads", "runs",
  "agents", "research", "improve", "web", "console", "api", "mcp-server", "computers", "team", "doctor", "upgrade", "db",
  "config", "connections", "models", "github", "usage", "audit-log", "workbench", "checks", "plugin", "skills", "memory",
] as const;
const HOME_AFTER = {
  fix: "scan", verify: "scan", deps: "scan", eval: "scan", "agent-assure": "scan", disclose: "scan", reports: "findings",
  connections: "models", usage: "models", "audit-log": "config", team: "config", db: "config", github: "config",
  upgrade: "doctor", workbench: "doctor", checks: "doctor", research: "lab", improve: "lab", console: "lab", "mcp-server": "lab", runs: "lab",
} as const;

async function parseHelp(program: Command, args: readonly string[]): Promise<{ code: string; exitCode: number; out: string }> {
  let out = "";
  program.exitOverride();
  const configure = (command: Command): void => {
    command.exitOverride();
    command.configureOutput({ writeOut: (text) => { out += text; }, writeErr: (text) => { out += text; } });
    command.commands.forEach(configure);
  };
  configure(program);
  try { await program.parseAsync([...args], { from: "user" }); } catch (error) {
    const e = error as { code: string; exitCode: number };
    return { code: e.code, exitCode: e.exitCode, out };
  }
  return { code: "none", exitCode: 0, out };
}

describe("every old top-level command still works", () => {
  it("covers all 35 old names", () => expect(new Set(OLD_TOP_LEVEL).size).toBe(35));
  it("keeps the in-source regroup table in sync with the tree", () => expect(HOME_AFTER).toEqual(NEW_HOME));

  it.each(OLD_TOP_LEVEL)("`0 %s --help` resolves to the same handler and exits 0", async (old) => {
    const rewritten = rewriteMovedCommand([old, "--help"]);
    const path = rewritten ? rewritten.args : [old, "--help"];
    expect(rewritten?.notice ?? "").toBe("");
    const program = tree();
    const words = path.slice(0, -1);
    expect(resolves(program, words), words.join(" ")).toBe(true);
    expect(words.at(-1)).toBe(old);
    const home = (HOME_AFTER as Record<string, string>)[old];
    expect(words).toEqual(home ? [home, old] : [old]);
    const result = await parseHelp(program, path);
    expect(result.code).toBe("commander.helpDisplayed");
    expect(result.exitCode).toBe(0);
  });

  it("prints identical help for an old name and its new path", async () => {
    for (const [old, group] of Object.entries(HOME_AFTER)) {
      const viaOld = await parseHelp(tree(), rewriteMovedCommand([old, "--help"])!.args);
      const viaNew = await parseHelp(tree(), [group, old, "--help"]);
      expect(viaOld.out, old).toBe(viaNew.out);
    }
  });

  it("spot check: `0 fix --help` and `0 usage --help` show the moved command's own options", async () => {
    const fix = await parseHelp(tree(), rewriteMovedCommand(["fix", "--help"])!.args);
    expect(fix.out).toMatch(/Usage: .*fix \[options\] <repo>/);
    const usage = await parseHelp(tree(), rewriteMovedCommand(["usage", "--help"])!.args);
    expect(usage.out).toMatch(/Usage: .*usage \[options\]/);
    expect(usage.out).toContain("--json");
  });

  it("spot check: `0 doctor` stays a top-level command with no rewrite", async () => {
    expect(rewriteMovedCommand(["doctor"])).toBeUndefined();
    const doctor = await parseHelp(tree(), ["doctor", "--help"]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.out).toContain("--discard-reports");
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => { lines.push(parts.join(" ")); });
    try { await tree().parseAsync(["doctor"], { from: "user" }); } finally { log.mockRestore(); }
    expect(lines.join("\n")).toContain("doctor");
    expect(lines.join("\n")).toContain("Node.js");
  });

  it("keeps the old first word working with its arguments and routes scan modules past the target router", () => {
    expect(rewriteMovedCommand(["fix", "repo", "--yes"])?.args).toEqual(["scan", "fix", "repo", "--yes"]);
    expect(rewriteMovedCommand(["upgrade", "--check"])?.args).toEqual(["doctor", "upgrade", "--check"]);
    expect(rewriteMovedCommand(["hunt", "x"])?.args).toEqual(["lab", "research", "hunt", "x"]);
    for (const module of ["fix", "verify", "deps", "eval", "agent-assure", "disclose"]) expect(rewriteScanArgs(["scan", module, "x"]), module).toBeUndefined();
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

describe("shouldPrintMovedNotice", () => {
  it("prints only on a TTY and never in --json mode", () => {
    expect(shouldPrintMovedNotice(["intel", "x"], true)).toBe(true);
    expect(shouldPrintMovedNotice(["intel", "x"], false)).toBe(false);
    expect(shouldPrintMovedNotice(["intel", "x"], undefined)).toBe(false);
    expect(shouldPrintMovedNotice(["intel", "--json"], true)).toBe(false);
    expect(shouldPrintMovedNotice(["intel", "--json=1"], true)).toBe(false);
  });
});
