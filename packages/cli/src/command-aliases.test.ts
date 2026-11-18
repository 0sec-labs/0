import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { rewriteMovedCommand, shouldPrintMovedNotice } from "./command-aliases.js";
import { configureGroupedHelp, NEW_HOME, registerCommandTree } from "./commands/tree.js";

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
  it("keeps eight visible top-level commands plus the hidden old names and `lab`", () => {
    const program = tree();
    const visible = program.commands.filter((command) => !(command as unknown as { _hidden: boolean })._hidden).map((command) => command.name());
    expect(visible.sort()).toEqual(["agents", "computers", "config", "findings", "memory", "models", "skills", "threads"]);
    expect(program.commands.map((command) => command.name()).sort()).toEqual([...visible, "api", "automation", "doctor", "lab", "plugin", "web"].sort());
  });

  it("groups the root help by purpose and hides lab and the old names", () => {
    const program = tree();
    configureGroupedHelp(program);
    const help = program.helpInformation();
    expect(help).toMatch(/Work:\n\s+findings[\s\S]*Setup:\n\s+skills/);
    for (const hidden of ["lab", "web", "doctor", "plugin", "automation", "api"]) expect(help).not.toMatch(new RegExp(`^\\s+${hidden}\\b`, "m"));
  });

  it("registers the nested groups", () => {
    const program = tree();
    for (const path of [
      ["lab", "console"], ["lab", "mcp-server"],
      ["findings", "triage"], ["automation", "list"], ["threads", "list"], ["plugin", "init"], ["plugin", "validate"], ["plugin", "submit"], ["plugin", "mcp", "add"], ["skills", "list"], ["memory", "list"], ["agents", "list"], ["threads", "start"], ["models", "connections", "list"], ["findings", "reports", "import"], ["config", "github", "status"], ["doctor", "upgrade"], ["doctor", "workbench", "status"],
    ]) expect(resolves(program, path), path.join(" ")).toBe(true);
  });
});

describe("moved-command aliases", () => {
  it("keeps the old thread names as silent aliases", () => {
    for (const old of ["chats", "missions", "sessions"]) expect(rewriteMovedCommand([old, "list", "--saved"])?.args).toEqual(["threads", "list", "--saved"]);
    expect(rewriteMovedCommand(["chats", "list"])?.notice).toBe("");
  });

  it("rewrites an old first word and preserves the rest", () => {
    expect(rewriteMovedCommand(["console", "--help"])?.args).toEqual(["lab", "console", "--help"]);
    expect(rewriteMovedCommand(["triage", "abc"])?.args).toEqual(["findings", "triage", "abc"]);
  });

  it("maps the retired hackstore command onto plugin", () => {
    expect(rewriteMovedCommand(["hackstore", "init", "x"])?.args).toEqual(["plugin", "init", "x"]);
    expect(rewriteMovedCommand(["hackstore", "validate", "."])?.args).toEqual(["plugin", "validate", "."]);
    expect(rewriteMovedCommand(["hackstore", "prepare-submission", "."])?.args).toEqual(["plugin", "submit", "."]);
  });

  it("maps workflow and sessions onto automation and chats", () => {
    expect(rewriteMovedCommand(["workflow", "list"])?.args).toEqual(["automation", "list"]);
    expect(rewriteMovedCommand(["sessions", "list"])?.args).toEqual(["threads", "list"]);
  });

  it("leaves current commands and inherited object keys alone", () => {
    expect(rewriteMovedCommand(["findings"])).toBeUndefined();
    expect(rewriteMovedCommand(["constructor"])).toBeUndefined();
    expect(rewriteMovedCommand([])).toBeUndefined();
  });

  it("only points at paths that exist in the tree", () => {
    const program = tree();
    for (const old of ["triage", "hackstore", "workflow", "sessions"]) {
      const moved = rewriteMovedCommand([old])!;
      expect(resolves(program, moved.args), old).toBe(true);
    }
  });
});

/** The top-level commands of the old tree that still exist. Every one must keep working. */
const OLD_TOP_LEVEL = [
  "reports", "findings", "automation", "threads",
  "agents", "web", "console", "api", "mcp-server", "computers", "team", "doctor", "upgrade", "db",
  "config", "connections", "models", "github", "usage", "audit-log", "workbench", "plugin", "skills", "memory",
] as const;
const HOME_AFTER = {
  reports: "findings",
  connections: "models", usage: "models", "audit-log": "config", team: "config", db: "config", github: "config",
  upgrade: "doctor", workbench: "doctor", console: "lab", "mcp-server": "lab",
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
  it("covers every remaining old name", () => expect(new Set(OLD_TOP_LEVEL).size).toBe(OLD_TOP_LEVEL.length));
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

  it("spot check: `0 usage --help` shows the moved command's own options", async () => {
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

  it("keeps the old first word working with its arguments", () => {
    expect(rewriteMovedCommand(["upgrade", "--check"])?.args).toEqual(["doctor", "upgrade", "--check"]);
    expect(rewriteMovedCommand(["console", "x"])?.args).toEqual(["lab", "console", "x"]);
  });

  it("no longer knows the removed scan, research, runs and improve commands", () => {
    for (const gone of ["scan", "fix", "verify", "disclose", "hunt", "kernel", "h1", "bench", "evolve", "orchestrate", "history", "resume", "review", "audit", "secure", "deep-review", "campaign", "research", "improve", "runs", "checks"]) {
      expect(rewriteMovedCommand([gone, "x"]), gone).toBeUndefined();
    }
  });
});

describe("shouldPrintMovedNotice", () => {
  it("prints only on a TTY and never in --json mode", () => {
    expect(shouldPrintMovedNotice(["triage", "x"], true)).toBe(true);
    expect(shouldPrintMovedNotice(["triage", "x"], false)).toBe(false);
    expect(shouldPrintMovedNotice(["triage", "x"], undefined)).toBe(false);
    expect(shouldPrintMovedNotice(["triage", "--json"], true)).toBe(false);
    expect(shouldPrintMovedNotice(["triage", "--json=1"], true)).toBe(false);
  });
});
