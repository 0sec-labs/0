/**
 * The command grammar: `findings update <id> --status accepted`, `threads send new <prompt>`,
 * `sentinels set <id> --state paused`, ... Each form is rewritten to the implementation command
 * (registered but hidden) before commander parses argv.
 */
import { statSync } from "node:fs";
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
  accepted: ["findings", "accept"], suppressed: ["findings", "suppress"], open: ["findings", "reopen"], "false-positive": ["findings", "suppress"],
};
const SENTINEL_STATE: Readonly<Record<string, string>> = { active: "resume", paused: "pause", acknowledged: "acknowledge", archived: "archive", deleted: "delete" };
const THREAD_FLAGS = ["events", "export", "archive", "close", "delete", "clear", "set"] as const;

function findings(a: Args): string[] | undefined {
  if (a.length === 1) return ["findings", "--help"]; // like every command group, bare `findings` shows its help
  const rest = a.slice(2);
  if (a[1] === "update" && isWord(a[2])) {
    const status = pull(rest.slice(1), "--status", true);
    const target = status.value ? STATUS_TO_COMMAND[status.value] : undefined;
    if (!target) return undefined;
    // A false positive is a suppression whose reason is the note kept with the finding.
    if (status.value === "false-positive") {
      const reason = pull(status.rest, "--reason", true);
      if (!reason.value) return undefined;
      const note = pull(reason.rest, "--note", true);
      return [...target, a[2], ...note.rest, "--note", reason.value];
    }
    return [...target, a[2], ...status.rest];
  }
  if (a[1] === "list") {
    const imported = pull(rest, "--import", true);
    if (imported.value) return ["findings", "reports", "import", imported.value, ...imported.rest];
    // `--json` is `--format json`; `--format text` is the plain list.
    const json = pull(rest, "--json", false);
    const format = pull(json.rest, "--format", true);
    const wanted = format.found ? format.value : json.found ? "json" : undefined;
    if (wanted === undefined && !format.found) return undefined;
    if (wanted === "text") return ["findings", "list", ...format.rest];
    return ["findings", "export", ...format.rest, ...(wanted ? ["--format", wanted] : [])];
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

/** `sentinels ... --automation`: the saved automations that Sentinels absorb, with the arguments they always had. */
function automations(a: Args): string[] | undefined {
  // `sentinels set <id> --trigger add --automation <automation-id>` uses --automation as a value, not as the switch.
  if (a.includes("--trigger") || a.includes("--files") || a.includes("--state")) return undefined;
  const flagged = pull(a.slice(2), "--automation", false);
  if (!flagged.found) return undefined;
  const rest = flagged.rest;
  if (a[1] === "list") return isWord(rest[0]) ? ["automation", "show", ...rest] : rest.includes("--template") ? ["automation", "show", ...rest] : ["automation", "list", ...rest];
  if (a[1] === "set" && isWord(rest[0])) return ["automation", ...rest];
  return undefined;
}

function sentinels(a: Args): string[] | undefined {
  const automation = automations(a);
  if (automation) return automation;
  const tail = a.slice(2);
  if (a[1] === "list") {
    const presets = pull(tail, "--presets", false);
    if (presets.found) return ["sentinels", "presets", ...presets.rest];
    if (isWord(a[2])) return ["sentinels", "show", ...tail];
  }
  if (a[1] === "run" && isWord(a[2])) {
    const history = pull(tail, "--history", false);
    if (history.found) return ["sentinels", "activations", ...history.rest];
  }
  if (a[1] === "set") {
    const create = pull(tail, "--create", false);
    if (create.found) return ["sentinels", "create", ...create.rest];
    const id = tail[0];
    if (!isWord(id)) return undefined;
    const more = tail.slice(1);
    const state = pull(more, "--state", true);
    if (state.value && SENTINEL_STATE[state.value]) return ["sentinels", SENTINEL_STATE[state.value]!, id, ...state.rest];
    for (const [flag, group] of [["--trigger", "triggers"], ["--files", "files"]] as const) {
      const sub = pull(more, flag, true);
      if (sub.value) {
        return ["sentinels", group, sub.value, id, ...sub.rest];
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
      for (const [flag, command] of [["--enable", ["skills", "extensions", "enable"]], ["--disable", ["skills", "extensions", "disable"]], ["--info", ["skills", "extensions", "info"]], ["--mcp-remove", ["skills", "extensions", "remove"]], ["--edit", ["skills", "edit"]], ["--export", ["skills", "export"]], ["--copy", ["skills", "copy"]], ["--delete", ["skills", "delete"]], ["--unlink", ["skills", "unlink"]]] as const) {
        const hit = pull(more, flag, false);
        if (hit.found) return [...command, id, ...hit.rest];
      }
      return ["skills", "show", ...tail];
    }
  }
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
    const validate = pull(tail, "--validate", false);
    if (validate.found && isWord(validate.rest[0])) return ["skills", "extensions", "add", ...validate.rest, "--preview"];
    const plugin = pull(tail, "--plugin", false);
    if (plugin.found) return ["skills", "extensions", "add", ...plugin.rest];
    const local = pull(tail, "--local", false);
    if (local.found && isWord(local.rest[0])) return ["skills", "extensions", "add", ...local.rest];
    const remove = pull(tail, "--remove", true);
    if (remove.value) return ["skills", "remove", remove.value, ...remove.rest];
    const source = tail[0];
    const extensionFlow = /@[0-9a-f]{40}$/.test(source ?? "") || tail.some(word => ["--preview", "--yes", "--enable", "--project"].includes(word));
    if (isWord(source) && looksLikePath(source) && !extensionFlow) return ["skills", isDirectory(source) ? "link" : "import", ...tail];
  }
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

const NEW_FORMS: Readonly<Record<string, (a: Args) => string[] | undefined>> = { findings, threads, sentinels, skills, models, computers, config };

/** The implementation argv for a new-grammar invocation, or undefined when `args` is not one. */
export function rewriteNewForms(args: Args): string[] | undefined {
  const first = args[0];
  if (first === undefined || !Object.hasOwn(NEW_FORMS, first)) return undefined;
  // `--help` asks about the command as typed, except where the flag picks the command: `sentinels list --automation --help`, `config doctor --help`.
  if (args.includes("--help") || args.includes("-h")) {
    if (first === "sentinels") {
      // `sentinels set <id> --trigger add --help` describes `triggers add`.
      for (const [flag, group] of [["--trigger", "triggers"], ["--files", "files"]] as const) {
        const at = args.indexOf(flag);
        if (at >= 0 && isWord(args[at + 1]) && !args.includes("--automation")) return ["sentinels", group, args[at + 1]!, "--help"];
      }
      return automations(args);
    }
    // `threads send new --help` describes starting a thread (its flags: --folder, --wait, --cost-ceiling), not sending to one.
    if (first === "threads" && args[1] === "send" && args[2] === "new") return threads(args);
    return first === "config" && args[1] === "doctor" ? config(args) : undefined;
  }
  return NEW_FORMS[first]!(args);
}


/** The flags of the web console. `0 --headless`, `0 --port 8080` and the rest mean `0 web ...`; bare `0` with none of them opens the console. */
export function rewriteBareConsoleFlags(args: Args): string[] | undefined {
  const first = args[0]?.split("=")[0];
  return first !== undefined && CONSOLE_FLAGS.has(first) ? ["web", ...args] : undefined;
}

/** The implementation argv that commander parses for `args`. */
export function resolveInvocation(args: Args): string[] {
  return rewriteBareConsoleFlags(args) ?? rewriteNewForms(args) ?? [...args];
}
