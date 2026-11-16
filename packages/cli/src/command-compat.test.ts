import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { formatMovedNotice, legacyNotice, LEGACY, resolveInvocation, rewriteNewForms } from "./command-compat.js";
import { shouldPrintMovedNotice } from "./command-aliases.js";
import { registerCommandTree } from "./commands/tree.js";
import { VISIBLE_SUBCOMMANDS } from "./commands/manifest.js";

const OLD_COMMANDS = readFileSync(fileURLToPath(new URL("./commands/__tests__/__fixtures__/legacy-commands.txt", import.meta.url)), "utf8")
  .split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(" "));

const program = new Command("0");
registerCommandTree(program);
const isHidden = (command: Command): boolean => (command as unknown as { _hidden?: boolean })._hidden === true;
function node(path: readonly string[]): Command | undefined {
  let current: Command | undefined = program;
  for (const word of path) current = current?.commands.find((c) => c.name() === word || c.aliases().includes(word));
  return current;
}
function isVisible(path: readonly string[]): boolean {
  let current: Command = program;
  for (const word of path) {
    const next = current.commands.find((c) => c.name() === word);
    if (!next || isHidden(next)) return false;
    current = next;
  }
  return true;
}
function leadingWords(args: readonly string[]): string[] {
  const words: string[] = [];
  for (const arg of args) { if (arg.startsWith("-")) break; words.push(arg); }
  return words;
}
async function help(args: readonly string[]): Promise<{ code: string; exitCode: number }> {
  const root = new Command("0");
  registerCommandTree(root);
  const configure = (command: Command): void => {
    command.exitOverride();
    command.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    command.commands.forEach(configure);
  };
  configure(root);
  try { await root.parseAsync([...args], { from: "user" }); } catch (error) {
    const e = error as { code: string; exitCode: number };
    return { code: e.code, exitCode: e.exitCode };
  }
  return { code: "none", exitCode: 0 };
}

describe("the 0.35 surface", () => {
  const visibleChildren = (command: Command): Command[] => command.commands.filter((c) => !isHidden(c) && c.name() !== "help");
  const topLevel = visibleChildren(program);

  it("has nine top-level commands", () => {
    expect(topLevel.map((c) => c.name()).sort()).toEqual(["agents", "computers", "config", "findings", "memory", "models", "scan", "skills", "threads"]);
  });

  it("shows at most three subcommands under each, and nothing below them", () => {
    for (const command of topLevel) {
      const subs = visibleChildren(command);
      expect(subs.map((c) => c.name()), command.name()).toEqual([...(VISIBLE_SUBCOMMANDS[command.name()] ?? [])]);
      expect(subs.length).toBeLessThanOrEqual(3);
      for (const sub of subs) expect(visibleChildren(sub), `${command.name()} ${sub.name()}`).toEqual([]);
    }
  });
});

/** Old nodes that are deliberately silent: the hidden developer group and the permanent `doctor`/`api` aliases. */
const SILENT = (path: readonly string[]): boolean => path[0] === "lab" || path[0] === "api" || (path.length === 1 && path[0] === "doctor") || path.slice(0, 2).join(" ") === "agents webhook";

describe("alias table: every 0.34 command still resolves", () => {
  it("lists the whole old tree", () => expect(OLD_COMMANDS.length).toBeGreaterThan(280));

  it.each(OLD_COMMANDS.map((path) => [path.join(" "), path] as const))("`0 %s`", async (_name, path) => {
    const resolved = resolveInvocation([...path, "--help"]);
    expect(node(leadingWords(resolved.args)), `${path.join(" ")} -> ${resolved.args.join(" ")}`).toBeDefined();
    const result = await help(resolved.args);
    expect(result.code).toBe("commander.helpDisplayed");
    expect(result.exitCode).toBe(0);
    // Still-current commands are silent; every moved one says where it went.
    if (isVisible(path) || SILENT(path)) expect(resolved.notice, "no notice").toBe("");
    else expect(resolved.notice, "a moved line").toMatch(/^moved: use /);
  });

  it("only has rows for commands that exist", () => {
    for (const row of LEGACY) expect(node(row.old.split(" ")), row.old).toBeDefined();
  });

  it("every row points at 0 ..., the extension flow or the docs", () => {
    for (const row of LEGACY) expect(row.use, row.old).toMatch(/^(0( |$)|the |git |docs)/);
  });
});

describe("the notice", () => {
  it("is one dim line, only on a TTY and never with --json", () => {
    expect(formatMovedNotice(legacyNotice(["web"]), true)).toBe("\u001b[2mmoved: use `0`\u001b[22m\n");
    expect(formatMovedNotice("moved: use `0 x`", false)).toBe("moved: use `0 x`\n");
    expect(shouldPrintMovedNotice(["findings", "accept", "x"], false)).toBe(false);
    expect(shouldPrintMovedNotice(["findings", "accept", "x", "--json"], true)).toBe(false);
    expect(shouldPrintMovedNotice(["findings", "accept", "x"], true)).toBe(true);
  });

  it("names the new command for an old one and stays silent for new ones", () => {
    expect(resolveInvocation(["findings", "accept", "f1", "--yes"])).toEqual({ args: ["findings", "accept", "f1", "--yes"], notice: "moved: use `0 findings update <id> --status accepted`" });
    expect(resolveInvocation(["findings", "update", "f1", "--status", "accepted"]).notice).toBe("");
    expect(resolveInvocation(["automations", "list"]).notice).toBe("moved: use `0 agents list --automation`");
    expect(resolveInvocation(["doctor"]).notice).toBe("");
    expect(resolveInvocation(["--port", "8080"])).toEqual({ args: ["web", "--port", "8080"], notice: "" });
    expect(resolveInvocation(["--headless", "--ready-json"])).toEqual({ args: ["web", "--headless", "--ready-json"], notice: "" });
    expect(resolveInvocation(["--host=0.0.0.0", "--server-mode"]).args[0]).toBe("web");
    expect(resolveInvocation(["-p", "hello"]).args).toEqual(["-p", "hello"]);
    expect(resolveInvocation(["hunt", "x"]).notice).toBe("moved: use `0 lab research hunt`");
  });
});

describe("the new grammar reaches the implementation commands", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["findings update f1 --status accepted --db-path x", "findings accept f1 --db-path x"],
    ["findings update f1 --status suppressed", "findings suppress f1"],
    ["findings update f1 --status open", "findings reopen f1"],
    ["findings update f1 --status false-positive", "findings triage mark-fp f1"],
    ["findings list --format sarif --output out.sarif", "findings export --format sarif --output out.sarif"],
    ["findings list --import r.json", "findings reports import r.json"],
    ["threads list t1", "threads show t1"],
    ["threads list t1 --events", "threads events t1"],
    ["threads list t1 --export --json", "threads export t1 --json"],
    ["threads list t1 --rename New", "threads rename t1 New"],
    ["threads list t1 --archive", "threads archive t1"],
    ["threads send new fix the build --yolo", "threads start fix the build --yolo"],
    ["threads send t1 --retry", "threads retry t1"],
    ["threads send t1 --resume", "threads resume t1"],
    ["threads send t1 --decide d1", "threads decide t1 d1"],
    ["agents list a1", "agents show a1"],
    ["agents list --automation --templates", "automation list --templates"],
    ["agents list x1 --automation", "automation show x1"],
    ["agents list --automation --template t", "automation show --template t"],
    ["agents run --automation --template t --target .", "automation run --template t --target ."],
    ["agents set --automation create --template t", "automation create --template t"],
    ["agents set --automation triggers list a1", "automation triggers list a1"],
    ["agents set --automation edit a1 --file d.json", "automation edit a1 --file d.json"],
    ["agents list --presets", "agents presets"],
    ["agents run a1 --history", "agents activations a1"],
    ["agents set --create --name N", "agents create --name N"],
    ["agents set a1 --state paused", "agents pause a1"],
    ["agents set a1 --state active", "agents resume a1"],
    ["agents set a1 --state deleted --yes", "agents delete a1 --yes"],
    ["agents set a1 --budget", "agents budget a1"],
    ["agents set a1 --trigger add --kind schedule", "agents triggers add a1 --kind schedule"],
    ["agents set a1 --trigger add --automation x1 --kind github-pr --repo o/r", "agents triggers add a1 --automation x1 --kind github-pr --repo o/r"],
    ["agents set a1 --files get notes.md", "agents files get a1 notes.md"],
    ["skills list s1", "skills show s1"],
    ["skills list --catalog", "skills catalog"],
    ["skills list --connectors", "skills extensions list"],
    ["skills list --mcp", "skills extensions list"],
    ["skills list p1 --enable", "skills extensions enable p1"],
    ["skills list p1 --disable", "skills extensions disable p1"],
    ["skills list p1 --info", "skills extensions info p1"],
    ["skills list m1 --mcp-test", "plugin mcp test m1"],
    ["skills list m1 --mcp-remove --yes", "skills extensions remove m1 --yes"],
    ["config get github repos", "config github repos"],
    ["config get team list", "config team list"],
    ["skills run x tool a=b", "plugin run x tool a=b"],
    ["skills add --mcp https://docs.example.com/mcp --yes", "skills extensions mcp docs-example-com --url https://docs.example.com/mcp --yes"],
    ["skills add --mcp docs -- npx some-server", "skills extensions mcp docs -- npx some-server"],
    ["skills add --connect github", "plugin connect github"],
    ["skills add --new my-plugin", "plugin init my-plugin"],
    ["skills add ./p --validate", "skills extensions add ./p --preview"],
    ["skills add ./p --submit --out o", "plugin submit ./p --out o"],
    ["skills add foxguard.scanner --plugin --yes", "skills extensions add foxguard.scanner --yes"],
    ["skills add ./p --local", "skills extensions add ./p"],
    ["skills list s1 --export -o x.json", "skills export s1 -o x.json"],
    ["skills list s1 --delete --yes", "skills delete s1 --yes"],
    ["skills add --remove s1", "skills remove s1"],
    ["memory set m1 on", "memory enable m1"],
    ["memory list --triage", "findings triage memory list"],
    ["memory set --add --finding f1 --reason r", "findings triage memory add --finding f1 --reason r"],
    ["memory set --remove t1", "findings triage memory remove t1"],
    ["memory set m1 off", "memory disable m1"],
    ["memory set --import m.json", "memory import m.json"],
    ["models set gpt-x --provider openai", "models default gpt-x --provider openai"],
    ["models list --usage", "models usage"],
    ["models connect", "models connections list"],
    ["models connect openai", "models connections add openai"],
    ["models connect openai --test", "models connections test openai"],
    ["computers list --hosts", "computers hosts"],
    ["computers add --repair b1", "computers repair b1"],
    ["config get", "config show"],
    ["config get --all", "config list"],
    ["config get --export out.json", "config export out.json"],
    ["config get audit --json", "config audit-log --json"],
    ["config get github", "config github status"],
    ["config get api.keys", "findings keys list"],
    ["config set --from-file c.json --yes", "config import c.json --yes"],
    ["config set --reset model", "config reset model"],
    ["config set api.key ci", "findings keys create ci"],
    ["config set api.key --revoke k1", "findings keys revoke k1"],
    ["config set team add-user bob", "config team add-user bob"],
    ["config set db reset", "config db reset"],
    ["config doctor", "doctor"],
    ["config doctor upgrade --check", "doctor upgrade --check"],
    ["config doctor --fix", "config db repair"],
    ["scan ./app --module deep --yes", "scan deep ./app --yes"],
    ["scan ./app --module repair", "scan repair ./app"],
    ["scan https://x.test --module campaign --scope s.json", "scan campaign --target https://x.test --scope s.json"],
    ["scan . --module deps --ecosystem npm", "scan deps scan --cwd . --ecosystem npm"],
    ["scan . --module deps-fix --yes", "scan deps fix --cwd . --yes"],
    ["scan disclose --pack f.json", "scan disclose evidence-pack f.json"],
    ["scan disclose --track g1", "scan disclose track g1"],
  ];
  it.each(cases)("0 %s", (input, expected) => {
    expect(rewriteNewForms(input.split(" "))?.join(" ")).toBe(expected);
    // The rewritten argv starts with a real command path (the rest are its arguments and flags).
    const words = expected.split(" ");
    const depth = words.findIndex((_, i) => node(words.slice(0, i + 1)) === undefined);
    expect(depth === -1 ? words.length : depth, expected).toBeGreaterThanOrEqual(Math.min(2, words.length));
  });

  it("leaves unchanged commands, partial input and help alone", () => {
    for (const same of ["findings list", "findings show f1", "threads list --saved", "threads send t1 hello", "threads stop t1 --force", "agents set a1 --name x", "config get model", "config set model x", "skills add owner/repo", "models list", "scan fix .", "scan ./app", "scan https://x.test --depth deep"]) {
      expect(rewriteNewForms(same.split(" ")), same).toBeUndefined();
    }
    expect(rewriteNewForms(["findings", "update", "f1", "--status", "bogus"])).toBeUndefined();
    expect(rewriteNewForms(["findings", "update", "--help"])).toBeUndefined();
    expect(rewriteNewForms(["models", "connect", "--help"])).toBeUndefined();
    expect(rewriteNewForms(["agents", "list", "--automation", "--help"])).toEqual(["automation", "list", "--help"]);
    expect(rewriteNewForms(["config", "doctor", "--help"])).toEqual(["doctor", "--help"]);
  });
});
