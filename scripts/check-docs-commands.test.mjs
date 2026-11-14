import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkConfigNames, checkEnvVars, checkInvocation, checkLinks, extractCommands, tokenize } from "./check-docs-commands.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { Command, Option } = createRequire(resolve(root, "packages/cli/package.json"))("commander");

function tree() {
  const program = new Command().name("0");
  const scan = program.command("scan");
  scan.command("web").requiredOption("--target <target>", "t")
    .addOption(new Option("--depth <depth>").choices(["quick", "default", "deep"]))
    .option("-m, --model <model>").option("--no-guided").option("--scope <path>");
  scan.command("source").argument("<repo>").option("--profile <p>");
  program.command("doctor").option("--json");
  program.command("runs").command("history");
  return program;
}
const moved = (args) => (args[0] === "review" ? "0 scan source" : undefined);
const check = (text) => checkInvocation(tree(), text, moved);

test("extracts fenced lines, prompts, continuations and inline spans", () => {
  const md = [
    "Run `0 scan web --target x` now and `not 0 scan`.", "", "```bash", "$ 0 doctor", "0 scan web \\", "  --target x", "echo hi", "```",
    "```json", "0 scan nope", "```",
  ].join("\n");
  const found = extractCommands(md);
  assert.deepEqual(found.map((f) => f.text), ["0 scan web --target x", "0 doctor", "0 scan web  --target x"]);
  assert.equal(found[1].line, 4);
});

test("tokenizer honours quotes and stops at pipes and redirects", () => {
  assert.deepEqual(tokenize(`0 scan web --auth '{"a": 1}' > out.json`), ["0", "scan", "web", "--auth", '{"a": 1}']);
});

test("accepts a correct invocation including short flags and negations", () => {
  assert.deepEqual(check("0 scan web --target https://x -m gpt --no-guided --depth deep --help"), []);
});

test("flags unknown commands, subcommands and options with a suggestion", () => {
  assert.match(check("0 nope")[0], /unknown command/);
  assert.match(check("0 runs nope")[0], /unknown subcommand/);
  assert.match(check("0 scan web --target x --runtime api")[0], /unknown option --runtime.*did you mean/);
  assert.match(check("0 scan web --target x -z")[0], /unknown option -z/);
});

test("rejects deprecated aliases", () => {
  assert.match(check("0 review ./repo")[0], /deprecated command `0 review`; use `0 scan source`/);
});

test("validates enumerated choices but not placeholders", () => {
  assert.match(check("0 scan web --target x --depth extreme")[0], /choices: quick, default, deep/);
  assert.match(check("0 scan web --target x --depth=extreme")[0], /invalid value "extreme"/);
  assert.deepEqual(check("0 scan web --target x --depth <depth>"), []);
});

test("requires mandatory options only on complete-looking examples", () => {
  assert.match(check("0 scan web --scope s")[0], /missing required option --target/);
  assert.deepEqual(check("0 scan web"), [], "bare command names are mentions");
  assert.deepEqual(check("0 scan web --help"), []);
  assert.deepEqual(check("0 scan web --scope <path> ..."), [], "placeholder lines skip the required check");
  assert.deepEqual(check("0 scan source ./repo --profile app"), []);
});

function fixtureRoot(files) {
  const dir = mkdtempSync(join(tmpdir(), "docs-check-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

test("finds broken links and stale anchors, accepts valid ones", () => {
  const dir = fixtureRoot({
    "docs/src/content/docs/a.md": "# A\n\n## Real heading\n",
    "docs/src/content/docs/b.md": "[ok](/a/#real-heading) [ok2](../a/) [bad](/missing/) [stale](/a/#nope) [self](#gone) `[x](/skipped/)`\n",
  });
  const file = join(dir, "docs/src/content/docs/b.md");
  const problems = checkLinks(file, "[ok](/a/#real-heading) [ok2](../a/) [bad](/missing/) [stale](/a/#nope) [self](#gone) `[x](/skipped/)`\n", dir);
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.match(problems.join("\n"), /broken link \/missing\//);
  assert.match(problems.join("\n"), /stale anchor \/a\/#nope/);
  assert.match(problems.join("\n"), /stale anchor #gone/);
});

test("reports env vars no source reads, honouring the allowlist", () => {
  const dir = fixtureRoot({ "docs/src/content/docs/e.md": "Set `ZERO_REAL` and `ZERO_GHOST` and `ZERO_CHOSEN`.\n" });
  const files = [join(dir, "docs/src/content/docs/e.md")];
  const problems = checkEnvVars(files, dir, (n) => n === "ZERO_REAL", new Map([["ZERO_CHOSEN", "operator chosen"]]));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ZERO_GHOST.*no source reads it/);
});

test("reports repo paths, workflow names and home config files that do not exist", () => {
  const dir = fixtureRoot({
    "docs/src/content/docs/c.md": "`scripts/real.json` `scripts/gone.json` `ci.yml` `lost.yml` `~/.0/known.json` `~/.0/ghost.json`\n",
    "scripts/real.json": "{}",
  });
  const files = [join(dir, "docs/src/content/docs/c.md")];
  const problems = checkConfigNames(files, dir, (n) => n === "known.json", (n) => n === "ci.yml");
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.match(problems.join("\n"), /scripts\/gone\.json/);
  assert.match(problems.join("\n"), /lost\.yml/);
  assert.match(problems.join("\n"), /ghost\.json/);
});

test("`0 scan <target>` is smart-routed: the target and its flags are accepted", () => {
  assert.deepEqual(check("0 scan https://app.example.com --depth quick"), []);
  assert.deepEqual(check("0 scan . --profile deep"), []);
  assert.deepEqual(check("0 scan npm:express"), []);
});

test("an explicit scan module still validates its flags", () => {
  assert.ok(check("0 scan web --target x --nope").length > 0);
});
