/**
 * Commands that moved into a noun group keep working for one release: the old
 * first word is rewritten to its new path and a one-line notice goes to stderr
 * only for interactive use (see `shouldPrintMovedNotice`).
 * This is the only deprecation table; delete rows when the grace period ends.
 */
/** `hackstore <sub>` becomes `plugin <sub>`, except where the subcommand was renamed. */
const RENAMED_SUBCOMMANDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  hackstore: { "prepare-submission": "submit" },
};

const MOVED: Readonly<Record<string, readonly string[]>> = {
  // → findings / plugin
  triage: ["findings", "triage"],
  hackstore: ["plugin"],
  // → automation / chats
  workflow: ["automation"], sessions: ["threads"],
  // Vocabulary renames: the old names keep working silently, with the same arguments.
  chats: ["threads"], missions: ["threads"], sentinels: ["agents"],
};

/** Renamed for vocabulary only: no moved notice, the old word is simply an alias. */
const SILENT = new Set(["chats", "missions", "sentinels"]);

/**
 * Top-level commands that now live under another group (mirrors NEW_HOME in
 * commands/tree.ts, which a test keeps in sync). The old name still works,
 * silently, with identical arguments and behaviour: `0 console` runs `0 lab console`.
 */
const NEW_HOME: Readonly<Record<string, string>> = {
  reports: "findings",
  connections: "models", usage: "models",
  "audit-log": "config", team: "config", db: "config", github: "config",
  upgrade: "doctor", workbench: "doctor",
  console: "lab", "mcp-server": "lab",
};

/** Put a path under its new group when its first word moved. */
function rehome(path: readonly string[]): string[] {
  const group = Object.hasOwn(NEW_HOME, path[0]!) ? NEW_HOME[path[0]!] : undefined;
  return group ? [group, ...path] : [...path];
}

interface AliasRewrite { args: string[]; notice: string }

export function rewriteMovedCommand(args: readonly string[]): AliasRewrite | undefined {
  const first = args[0];
  if (first === undefined) return undefined;
  if (!Object.hasOwn(MOVED, first)) {
    // Regroup-only rename: silent, no notice.
    return Object.hasOwn(NEW_HOME, first) ? { args: [...rehome([first]), ...args.slice(1)], notice: "" } : undefined;
  }
  const target = rehome(MOVED[first]!);
  const rest = args.slice(1);
  const renamed = rest[0] === undefined ? undefined : RENAMED_SUBCOMMANDS[first!]?.[rest[0]];
  if (renamed) rest[0] = renamed;
  return {
    args: [...target, ...rest],
    notice: SILENT.has(first!) ? "" : `moved: use \`0 ${target.join(" ")}\``,
  };
}

/** Notice only when a human is watching: never when piped, in CI, or with --json. */
export function shouldPrintMovedNotice(args: readonly string[], stdoutIsTTY: boolean | undefined): boolean {
  return stdoutIsTTY === true && !args.some(arg => arg === "--json" || arg.startsWith("--json="));
}
