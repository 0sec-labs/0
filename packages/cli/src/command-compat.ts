/**
 * The 0.35 command surface: nine top-level commands, at most three visible subcommands each.
 *
 * Two layers live here, both applied to argv before commander parses it:
 *
 *  1. `rewriteNewForms`: the new grammar (`findings update <id> --status accepted`,
 *     `threads send new <prompt>`, `agents set <id> --state paused`, ...) is translated to the
 *     implementation commands, which stay registered but hidden. Silent.
 *  2. `legacyNotice`: an old invocation (`findings accept <id>`, `plugin install x`, `web`) keeps
 *     working unchanged and gets one `moved:` line on stderr, interactive use only.
 *
 * `LEGACY` is the only deprecation table for this release. Delete its rows with the
 * implementation commands they point at when the grace period ends (see
 * docs/src/content/docs/changelog.md for the same table in prose).
 */
import { statSync } from "node:fs";
import { rewriteMovedCommand } from "./command-aliases.js";
import { CONSOLE_FLAGS } from "./surface.js";

type Args = readonly string[];

/** Remove `--name value` / `--name=value` (or a bare boolean `--name`). */
function pull(args: Args, name: string, withValue: boolean): { found: boolean; value?: string; rest: string[] } {
  const rest: string[] = [];
  let found = false;
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { rest.push(...args.slice(i)); break; }
    if (arg === name) {
      found = true;
      if (withValue && args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) value = args[++i];
    } else if (withValue && arg.startsWith(`${name}=`)) { found = true; value = arg.slice(name.length + 1); }
    else rest.push(arg);
  }
  return value === undefined ? { found, rest } : { found, value, rest };
}

const isWord = (value: string | undefined): value is string => value !== undefined && !value.startsWith("-");

const STATUS_TO_COMMAND: Readonly<Record<string, readonly string[]>> = {
  accepted: ["findings", "accept"], suppressed: ["findings", "suppress"], open: ["findings", "reopen"], "false-positive": ["findings", "triage", "mark-fp"],
};
const AGENT_STATE: Readonly<Record<string, string>> = { active: "resume", paused: "pause", acknowledged: "acknowledge", archived: "archive", deleted: "delete" };
const THREAD_FLAGS = ["events", "export", "archive", "close", "delete", "clear", "set"] as const;

function findings(a: Args): string[] | undefined {
  const rest = a.slice(2);
  if (a[1] === "update" && isWord(a[2])) {
    const status = pull(rest.slice(1), "--status", true);
    const target = status.value ? STATUS_TO_COMMAND[status.value] : undefined;
    return target ? [...target, a[2], ...status.rest] : undefined;
  }
  if (a[1] === "list") {
    const imported = pull(rest, "--import", true);
    if (imported.value) return ["findings", "reports", "import", imported.value, ...imported.rest];
    if (rest.some((x) => x === "--format" || x.startsWith("--format="))) return ["findings", "export", ...rest];
  }
  return undefined;
}

function threads(a: Args): string[] | undefined {
  if (a[1] === "list" && isWord(a[2])) {
    const id = a[2];
    const tail = a.slice(3);
    const rename = pull(tail, "--rename", true);
    if (rename.found) return ["threads", "rename", id, ...(rename.value ? [rename.value] : []), ...rename.rest];
    for (const flag of THREAD_FLAGS) {
      const hit = pull(tail, `--${flag}`, false);
      if (hit.found) return ["threads", flag, id, ...hit.rest];
    }
    return ["threads", "show", id, ...tail];
  }
  if (a[1] === "send" && a[2] === "new") return ["threads", "start", ...a.slice(3)];
  if (a[1] === "send" && isWord(a[2])) {
    const id = a[2];
    const tail = a.slice(3);
    const retry = pull(tail, "--retry", false);
    if (retry.found) return ["threads", "retry", id, ...retry.rest];
    const resume = pull(tail, "--resume", false);
    if (resume.found) return ["threads", "resume", id, ...resume.rest];
    const decide = pull(tail, "--decide", true);
    if (decide.found && decide.value) return ["threads", "decide", id, decide.value, ...decide.rest];
  }
  return undefined;
}

/** `agents ... --automation`: the saved automations that Agents absorb, with the arguments they always had. */
function automations(a: Args): string[] | undefined {
  // `agents set <id> --trigger add --automation <automation-id>` uses --automation as a value, not as the switch.
  if (a.includes("--trigger") || a.includes("--files") || a.includes("--state")) return undefined;
  const flagged = pull(a.slice(2), "--automation", false);
  if (!flagged.found) return undefined;
  const rest = flagged.rest;
  if (a[1] === "list") return isWord(rest[0]) ? ["automation", "show", ...rest] : rest.includes("--template") ? ["automation", "show", ...rest] : ["automation", "list", ...rest];
  if (a[1] === "run") return ["automation", "run", ...rest];
  if (a[1] === "set" && isWord(rest[0])) return ["automation", ...rest];
  return undefined;
}

function agents(a: Args): string[] | undefined {
  const automation = automations(a);
  if (automation) return automation;
  const tail = a.slice(2);
  if (a[1] === "list") {
    const presets = pull(tail, "--presets", false);
    if (presets.found) return ["agents", "presets", ...presets.rest];
    if (isWord(a[2])) return ["agents", "show", ...tail];
  }
  if (a[1] === "run" && isWord(a[2])) {
    const history = pull(tail, "--history", false);
    if (history.found) return ["agents", "activations", ...history.rest];
  }
  if (a[1] === "set") {
    const create = pull(tail, "--create", false);
    if (create.found) return ["agents", "create", ...create.rest];
    const id = tail[0];
    if (!isWord(id)) return undefined;
    const more = tail.slice(1);
    const state = pull(more, "--state", true);
    if (state.value && AGENT_STATE[state.value]) return ["agents", AGENT_STATE[state.value]!, id, ...state.rest];
    const budget = pull(more, "--budget", false);
    if (budget.found) return ["agents", "budget", id, ...budget.rest];
    for (const [flag, group] of [["--trigger", "triggers"], ["--files", "files"]] as const) {
      const sub = pull(more, flag, true);
      if (sub.value) {
        return ["agents", group, sub.value, id, ...sub.rest];
      }
    }
  }
  return undefined;
}

const looksLikePath = (value: string): boolean => /^(\.{0,2}\/|~\/|\.\.?$)/.test(value);
function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function skills(a: Args): string[] | undefined {
  const tail = a.slice(2);
  if (a[1] === "list") {
    const catalog = pull(tail, "--catalog", false);
    if (catalog.found) return ["skills", "catalog", ...catalog.rest];
    const connectors = pull(tail, "--connectors", false);
    if (connectors.found) return ["skills", "extensions", "list", ...connectors.rest];
    const mcp = pull(tail, "--mcp", false);
    if (mcp.found) return ["skills", "extensions", "list", ...mcp.rest];
    if (isWord(a[2])) {
      const id = a[2];
      const more = a.slice(3);
      for (const [flag, command] of [["--enable", ["skills", "extensions", "enable"]], ["--disable", ["skills", "extensions", "disable"]], ["--info", ["skills", "extensions", "info"]], ["--mcp-test", ["plugin", "mcp", "test"]], ["--mcp-remove", ["skills", "extensions", "remove"]], ["--edit", ["skills", "edit"]], ["--export", ["skills", "export"]], ["--copy", ["skills", "copy"]], ["--delete", ["skills", "delete"]], ["--unlink", ["skills", "unlink"]]] as const) {
        const hit = pull(more, flag, false);
        if (hit.found) return [...command, id, ...hit.rest];
      }
      return ["skills", "show", ...tail];
    }
  }
  if (a[1] === "run") return ["plugin", "run", ...tail];
  if (a[1] === "add") {
    const mcp = pull(tail, "--mcp", true);
    if (mcp.found) {
      if (mcp.value && /^https?:\/\//.test(mcp.value)) {
        const name = pull(mcp.rest, "--name", true);
        let host = "mcp";
        try { host = new URL(mcp.value).hostname.replace(/[^a-z0-9-]/gi, "-"); } catch { /* keep default */ }
        return ["skills", "extensions", "mcp", name.value ?? host, "--url", mcp.value, ...name.rest];
      }
      return ["skills", "extensions", "mcp", ...(mcp.value ? [mcp.value] : []), ...mcp.rest];
    }
    const created = pull(tail, "--new", true);
    if (created.value) return ["plugin", "init", created.value, ...created.rest];
    const validate = pull(tail, "--validate", false);
    if (validate.found && isWord(validate.rest[0])) return ["skills", "extensions", "add", ...validate.rest, "--preview"];
    const submit = pull(tail, "--submit", false);
    if (submit.found && isWord(submit.rest[0])) return ["plugin", "submit", ...submit.rest];
    const plugin = pull(tail, "--plugin", false);
    if (plugin.found) return ["skills", "extensions", "add", ...plugin.rest];
    const local = pull(tail, "--local", false);
    if (local.found && isWord(local.rest[0])) return ["skills", "extensions", "add", ...local.rest];
    const connect = pull(tail, "--connect", true);
    if (connect.value) return ["plugin", "connect", connect.value, ...connect.rest];
    const disconnect = pull(tail, "--disconnect", true);
    if (disconnect.value) return ["plugin", "disconnect", disconnect.value, ...disconnect.rest];
    const remove = pull(tail, "--remove", true);
    if (remove.value) return ["skills", "remove", remove.value, ...remove.rest];
    const source = tail[0];
    const extensionFlow = /@[0-9a-f]{40}$/.test(source ?? "") || tail.some(word => ["--preview", "--yes", "--enable", "--project"].includes(word));
    if (isWord(source) && looksLikePath(source) && !extensionFlow) return ["skills", isDirectory(source) ? "link" : "import", ...tail];
  }
  return undefined;
}

function memory(a: Args): string[] | undefined {
  if (a[1] === "list") {
    const triage = pull(a.slice(2), "--triage", false);
    if (triage.found) return ["findings", "triage", "memory", "list", ...triage.rest];
  }
  if (a[1] !== "set") return undefined;
  const tail = a.slice(2);
  const add = pull(tail, "--add", false);
  if (add.found) return ["findings", "triage", "memory", "add", ...add.rest];
  const remove = pull(tail, "--remove", false);
  if (remove.found && isWord(remove.rest[0])) return ["findings", "triage", "memory", "remove", ...remove.rest];
  const imported = pull(tail, "--import", true);
  if (imported.value) return ["memory", "import", imported.value, ...imported.rest];
  const state = tail[1];
  if (isWord(tail[0]) && (state === "on" || state === "off")) return ["memory", state === "on" ? "enable" : "disable", tail[0], ...tail.slice(2)];
  return undefined;
}

function models(a: Args): string[] | undefined {
  const tail = a.slice(2);
  if (a[1] === "set") return ["models", "default", ...tail];
  if (a[1] === "list") {
    const usage = pull(tail, "--usage", false);
    if (usage.found) return ["models", "usage", ...usage.rest];
    const recommended = pull(tail, "--recommended", false);
    if (recommended.found) return ["models", "recommended", ...recommended.rest];
  }
  if (a[1] === "connect") {
    for (const [flag, sub] of [["--test", "test"], ["--remove", "remove"]] as const) {
      const hit = pull(tail, flag, false);
      if (hit.found) return ["models", "connections", sub, ...hit.rest];
    }
    const list = pull(tail, "--list", false);
    if (list.found || tail.length === 0) return ["models", "connections", "list", ...list.rest];
    return ["models", "connections", "add", ...tail];
  }
  return undefined;
}

function computers(a: Args): string[] | undefined {
  const tail = a.slice(2);
  if (a[1] === "list") {
    const hosts = pull(tail, "--hosts", false);
    if (hosts.found) return ["computers", "hosts", ...hosts.rest];
  }
  if (a[1] === "add") {
    const repair = pull(tail, "--repair", true);
    if (repair.found) return ["computers", "repair", ...(repair.value ? [repair.value] : []), ...repair.rest];
  }
  return undefined;
}

/** `config get|set <namespace>` reaches the groups that used to be separate commands. */
const GET_NAMESPACE: Readonly<Record<string, readonly string[]>> = {
  audit: ["config", "audit-log"], team: ["config", "team", "list"], github: ["config", "github", "status"], "api.keys": ["findings", "keys", "list"],
};
function config(a: Args): string[] | undefined {
  const tail = a.slice(2);
  if (a[1] === "doctor") {
    const fix = pull(tail, "--fix", false);
    if (fix.found) return ["config", "db", "repair", ...fix.rest];
    return ["doctor", ...tail];
  }
  if (a[1] === "get") {
    if (isWord(tail[0]) && (tail[0] === "team" || tail[0] === "github") && isWord(tail[1])) return ["config", ...tail];
    if (isWord(tail[0]) && Object.hasOwn(GET_NAMESPACE, tail[0])) return [...GET_NAMESPACE[tail[0]]!, ...tail.slice(1)];
    const all = pull(tail, "--all", false);
    if (all.found) return ["config", "list", ...all.rest];
    const exported = pull(tail, "--export", false);
    if (exported.found) return ["config", "export", ...exported.rest];
    if (!isWord(tail[0])) return ["config", "show", ...tail];
  }
  if (a[1] === "set") {
    const from = pull(tail, "--from-file", true);
    if (from.value) return ["config", "import", from.value, ...from.rest];
    const reset = pull(tail, "--reset", false);
    if (reset.found) return ["config", "reset", ...reset.rest];
    if (tail[0] === "api.key") {
      const revoke = pull(tail.slice(1), "--revoke", true);
      if (revoke.value) return ["findings", "keys", "revoke", revoke.value, ...revoke.rest];
      return ["findings", "keys", "create", ...tail.slice(1)];
    }
    if (isWord(tail[0]) && (tail[0] === "team" || tail[0] === "db" || tail[0] === "github")) return ["config", ...tail];
  }
  return undefined;
}

const SCAN_MODULES = ["web", "source", "package", "deep", "repair", "campaign", "fix", "verify", "deps", "eval", "agent-assure", "disclose"];

/** `scan <target> --module deep|repair|campaign|deps|deps-fix` reaches the modules that have no target-detecting form; `scan disclose --pack|--track|--review`. */
function scan(a: Args): string[] | undefined {
  if (isWord(a[1]) && !SCAN_MODULES.includes(a[1])) {
    const tail = a.slice(2);
    const module = pull(tail, "--module", true);
    const target = a[1];
    switch (module.value) {
      case "deep": case "repair": return ["scan", module.value, target, ...module.rest];
      case "campaign": return ["scan", "campaign", "--target", target, ...module.rest];
      case "deps": return ["scan", "deps", "scan", "--cwd", target, ...module.rest];
      case "deps-fix": return ["scan", "deps", "fix", "--cwd", target, ...module.rest];
      default: return undefined;
    }
  }
  if (a[1] !== "disclose") return undefined;
  const tail = a.slice(2);
  for (const [flag, sub] of [["--pack", "evidence-pack"], ["--track", "track"], ["--review", "review"]] as const) {
    const hit = pull(tail, flag, true);
    if (hit.found) return ["scan", "disclose", sub, ...(hit.value ? [hit.value] : []), ...hit.rest];
  }
  return undefined;
}

/**
 * The retired `plugin` group: verbs that still have an equivalent run it under `0 skills extensions`; the rest reach a
 * stub in commands/plugin-moved.ts that says what replaced them. `--help` is left alone so it describes the stub.
 */
function plugin(a: Args): string[] | undefined {
  const tail = a.slice(2);
  switch (a[1]) {
    case "list": case "search": return ["skills", "extensions", "list", ...tail];
    case "browse": return ["skills", "catalog", ...tail];
    case "info": case "enable": case "disable": return ["skills", "extensions", a[1], ...tail];
    case "install": return ["skills", "extensions", "add", ...pull(tail, "--local", false).rest];
    case "mcp":
      if (a[2] === "list") return ["skills", "extensions", "list", ...a.slice(3)];
      if (a[2] === "add") return ["skills", "extensions", "mcp", ...a.slice(3)];
      if (a[2] === "remove") return ["skills", "extensions", "remove", ...a.slice(3)];
      return undefined;
    default: return undefined;
  }
}

const NEW_FORMS: Readonly<Record<string, (a: Args) => string[] | undefined>> = { findings, threads, agents, skills, memory, models, computers, config, scan };

/** The implementation argv for a new-grammar invocation, or undefined when `args` is not one. */
export function rewriteNewForms(args: Args): string[] | undefined {
  const first = args[0];
  if (first === undefined || !Object.hasOwn(NEW_FORMS, first)) return undefined;
  // `--help` asks about the command as typed, except where the flag picks the command: `agents list --automation --help`, `config doctor --help`.
  if (args.includes("--help") || args.includes("-h")) {
    if (first === "agents") return automations(args);
    return first === "config" && args[1] === "doctor" ? config(args) : undefined;
  }
  return NEW_FORMS[first]!(args);
}

/** The flags of the web console. `0 --headless`, `0 --port 8080` and the rest mean `0 web ...`; bare `0` with none of them opens the console. */
export function rewriteBareConsoleFlags(args: Args): string[] | undefined {
  const first = args[0]?.split("=")[0];
  return first !== undefined && CONSOLE_FLAGS.has(first) ? ["web", ...args] : undefined;
}

/** One old command and what to run instead. `old` matches the leading words of the invocation. */
export interface LegacyRow { readonly old: string; readonly use: string }

const rows = (pairs: readonly (readonly [string, string])[]): LegacyRow[] => pairs.map(([old, use]) => ({ old, use }));

export const LEGACY: readonly LegacyRow[] = rows([
  // scan
  ["scan web", "0 scan <target>"], ["scan source", "0 scan <target>"], ["scan package", "0 scan <target>"],
  ["scan deep", "0 scan <target> --module deep"], ["scan repair", "0 scan <target> --module repair"], ["scan campaign", "0 scan <target> --module campaign"],
  ["scan deps scan", "0 scan <dir> --module deps"], ["scan deps fix", "0 scan <dir> --module deps-fix"], ["scan deps", "0 scan <dir> --module deps"],
  ["scan eval", "the benchmark plugin (removed after 0.35)"], ["scan agent-assure", "the agent-assure plugin (removed after 0.35)"],
  ["scan disclose evidence-pack", "0 scan disclose --pack <finding.json>"], ["scan disclose track", "0 scan disclose --track <id>"], ["scan disclose review", "0 scan disclose --review <finding.json>"],
  // findings
  ["findings accept", "0 findings update <id> --status accepted"], ["findings suppress", "0 findings update <id> --status suppressed"],
  ["findings reopen", "0 findings update <id> --status open"], ["findings triage mark-fp", "0 findings update <id> --status false-positive"],
  ["findings triage memory add", "0 memory set --add"], ["findings triage memory list", "0 memory list --triage"], ["findings triage memory remove", "0 memory set --remove <id>"], ["findings triage memory", "0 memory list --triage"], ["findings triage", "0 findings update <id> --status ..."],
  ["findings export", "0 findings list --format sarif|json|md"], ["findings reports import", "0 findings list --import <report>"],
  ["findings reports export", "0 findings list --format md"], ["findings reports", "0 findings list"],
  ["findings keys list", "0 config get api.keys"], ["findings keys create", "0 config set api.key <name>"], ["findings keys revoke", "0 config set api.key --revoke <id>"], ["findings keys", "0 config get api.keys"],
  // threads
  ["threads show", "0 threads list <id>"], ["threads create", "0 threads send new <prompt>"], ["threads start", "0 threads send new <prompt>"],
  ["threads continue", "0 threads send <id> [text]"], ["threads resume", "0 threads send <id> --resume"], ["threads retry", "0 threads send <id> --retry"],
  ["threads decide", "0 threads send <id> --decide <decision-id>"], ["threads cancel", "0 threads stop <id>"], ["threads force-stop", "0 threads stop <id> --force"],
  ["threads events", "0 threads list <id> --events"], ["threads export", "0 threads list <id> --export"], ["threads set", "0 threads list <id> --set ..."],
  ["threads rename", "0 threads list <id> --rename <title>"], ["threads clear", "0 threads list <id> --clear"], ["threads close", "0 threads list <id> --close"],
  ["threads archive", "0 threads list <id> --archive"], ["threads delete", "0 threads list <id> --delete"],
  // agents and automations
  ["agents show", "0 agents list <id>"], ["agents presets", "0 agents list --presets"], ["agents create", "0 agents set --create"],
  ["agents pause", "0 agents set <id> --state paused"], ["agents resume", "0 agents set <id> --state active"], ["agents acknowledge", "0 agents set <id> --state acknowledged"],
  ["agents archive", "0 agents set <id> --state archived"], ["agents delete", "0 agents set <id> --state deleted"], ["agents budget", "0 agents set <id> --budget"],
  ["agents activations", "0 agents run <id> --history"], ["agents files", "0 agents set <id> --files list|get|put|rm"], ["agents triggers", "0 agents set <id> --trigger list|add|enable|disable|check|rm"],
  ["automation list", "0 agents list --automation"], ["automation show", "0 agents list <id> --automation"], ["automation run", "0 agents run <id> --automation"],
  ["automation create", "0 agents set --automation create"], ["automation edit", "0 agents set --automation edit <id>"], ["automation duplicate", "0 agents set --automation duplicate <id>"],
  ["automation delete", "0 agents set --automation delete <id>"], ["automation triggers", "0 agents set --automation triggers <list|enable|disable|remove>"],
  ["automation versions", "git history (this command is removed after 0.35)"], ["automation rollback", "git (this command is removed after 0.35)"],
  ["automation", "0 agents list --automation"],
  // models, plugins, computers
  ["models default", "0 models set <model>"], ["models recommended", "0 models list --recommended"], ["models connections", "0 models connect <provider>"], ["models usage", "0 models list --usage"],
  ["computers deploy", "0 computers add"], ["computers repair", "0 config doctor"], ["computers hosts", "0 computers list --hosts"],
  // skills and plugins
  ["skills show", "0 skills list <name>"], ["skills catalog", "0 skills list --catalog"],
  ["skills new", "0 skills add <file>"], ["skills edit", "0 skills list <name> --edit"], ["skills copy", "0 skills list <name> --copy"], ["skills import", "0 skills add <bundle>"],
  ["skills export", "0 skills list <name> --export"], ["skills link", "0 skills add <dir>"], ["skills unlink", "0 skills list <name> --unlink"], ["skills delete", "0 skills list <name> --delete"], ["skills remove", "0 skills add --remove <name>"],
  ["plugin list", "0 skills extensions list"], ["plugin search", "0 skills extensions list"], ["plugin browse", "0 skills list --catalog"], ["plugin info", "0 skills extensions info <name>"],
  ["plugin enable", "0 skills extensions enable <name>"], ["plugin disable", "0 skills extensions disable <name>"], ["plugin install", "0 skills add <repo>@<sha>"], ["plugin run", "the extension's scripts, run through bash"],
  ["plugin init", "the folder flow: extension.json or SKILL.md, then 0 skills add <folder> --preview"], ["plugin validate", "0 skills add <folder> --preview"], ["plugin submit", "the extension flow: 0 skills add <repo>@<sha> (registry submission was removed)"],
  ["plugin connectors", "0 skills extensions list"], ["plugin connect", "the Extensions page in the web app"], ["plugin disconnect", "the Extensions page in the web app"],
  ["plugin mcp add", "0 skills extensions mcp <name> --url <url>"], ["plugin mcp list", "0 skills extensions list"], ["plugin mcp test", "0 skills extensions info <name>"], ["plugin mcp remove", "0 skills extensions remove <name>"], ["plugin mcp", "0 skills extensions mcp <name> --url <url>"], ["plugin", "0 skills extensions"],
  // memory, config, doctor, web
  ["memory enable", "0 memory set <id> on"], ["memory disable", "0 memory set <id> off"], ["memory import", "0 memory set --import <file>"],
  ["config show", "0 config get"], ["config list", "0 config get --all"], ["config reset", "0 config set --reset"], ["config export", "0 config get --export"],
  ["config import", "0 config set --from-file <file>"], ["config audit-log", "0 config get audit"], ["config team list", "0 config get team"], ["config team", "0 config set team <init|add-user>"],
  ["config db repair", "0 config doctor --fix"], ["config db", "0 config set db reset"], ["config github status", "0 config get github"], ["config github", "0 config set github <connect|repos>"],
  ["doctor upgrade", "0 config doctor upgrade"], ["doctor workbench", "0 config doctor workbench"], ["doctor checks", "0 config doctor checks"],
  ["web", "0"],
]);

const SORTED = [...LEGACY].sort((a, b) => b.old.split(" ").length - a.old.split(" ").length);
const ALIAS_WORD: Readonly<Record<string, string>> = { automations: "automation", worker: "computers" };

/** The leading subcommand words of an invocation, before the first flag. */
function leadingWords(args: Args): string[] {
  const words: string[] = [];
  for (const arg of args) { if (arg.startsWith("-")) break; words.push(arg); }
  if (words[0] !== undefined && Object.hasOwn(ALIAS_WORD, words[0])) words[0] = ALIAS_WORD[words[0]]!;
  return words;
}

/** The row for an old invocation. Only run it on argv that `rewriteNewForms` did not change. */
export function legacyRow(args: Args): LegacyRow | undefined {
  const words = leadingWords(args);
  return SORTED.find((row) => {
    const path = row.old.split(" ");
    return path.length <= words.length && path.every((word, index) => words[index] === word);
  });
}

export function legacyNotice(args: Args): string {
  const row = legacyRow(args);
  // `0 web --headless --port 0` is `0 --headless --port 0`: the flags carry over, only the word `web` goes.
  if (row?.old === "web" && args[0] === "web") {
    const flags = args.slice(1).filter((arg) => arg !== "--help" && arg !== "-h");
    if (flags.length) return `moved: use \`0 ${flags.join(" ")}\``;
  }
  return row ? `moved: use ${row.use.startsWith("0") ? `\`${row.use}\`` : row.use}` : "";
}

/**
 * The whole alias layer for one invocation: old-old names, then the new grammar, then the moved notice.
 * `args` is what commander parses; `notice` is empty for new forms, current commands and silent renames.
 */
export function resolveInvocation(args: Args): { args: string[]; notice: string } {
  const bare = rewriteBareConsoleFlags(args);
  if (bare) return { args: bare, notice: "" };
  const moved = rewriteMovedCommand(args);
  const staged = moved ? moved.args : [...args];
  const compat = rewriteNewForms(staged);
  if (compat) return { args: compat, notice: "" };
  if (staged[0] === "plugin" && !staged.includes("--help") && !staged.includes("-h")) {
    const resolved = plugin(staged);
    if (resolved) return { args: resolved, notice: legacyNotice(staged) || moved?.notice || "" };
  }
  return { args: staged, notice: legacyNotice(staged) || moved?.notice || "" };
}

/** Dim, one line, stderr: exactly what the notice looks like on a terminal. */
export function formatMovedNotice(notice: string, colour: boolean): string {
  return colour ? `\u001b[2m${notice}\u001b[22m\n` : `${notice}\n`;
}
