/**
 * The one slash-command registry, shared by the chat composer and the CLI docs.
 *
 * Every command is defined once. A command that mirrors the CLI is named like it
 * (`/threads list` is `0 threads list`) and carries the visible CLI path in `cli`, so a parity
 * test can prove the two never drift. Commands that exist only in chat have no `cli`.
 *
 * Portable: no React, no @0/engine imports.
 *
 * A "slash command" is any input starting with `/`. Unknown slash commands produce
 * `{ isSlash: true, isUnknown: true }` so consumers can show a local notice and never
 * send them to the model.
 */

export type SlashGroup =
  | "Threads"
  | "Findings"
  | "Agents"
  | "Automation"
  | "Computers"
  | "Models"
  | "Skills"
  | "Memory"
  | "Plugins"
  | "Settings"
  | "Chat";

export interface SlashCommand {
  /** Canonical path without the leading `/`: `threads list`, or one word for chat-only commands. */
  readonly name: string;
  readonly group: SlashGroup;
  /** One-line description. */
  readonly description: string;
  /** Usage hint, e.g. "/models default [model]". */
  readonly usage?: string;
  /** The CLI command this mirrors, without the leading `0 `, e.g. `threads list` or `threads list --export` (a visible command path, then any flag it needs). Absent for chat-only commands. */
  readonly cli?: string;
  /** Web page route this command opens. */
  readonly destination?: string;
  /** Alternate names that stay visible in the menu match. */
  readonly aliases: readonly string[];
  /** Old names kept so muscle memory works; resolved but never listed. */
  readonly legacy: readonly string[];
}

export interface ParsedSlashInput {
  /** True when the raw input starts with `/`. */
  readonly isSlash: boolean;
  /** Canonical command name when the input resolves to a known command. */
  readonly command: string | undefined;
  /** The name as typed (one or two words), or the first word for unknown input. */
  readonly rawName: string;
  /** Everything after the command (trimmed). Empty when there are no arguments. */
  readonly args: string;
  readonly isKnown: boolean;
  readonly isUnknown: boolean;
}

const cmd = (
  name: string,
  group: SlashGroup,
  description: string,
  extra: Partial<Omit<SlashCommand, "name" | "group" | "description">> = {},
): SlashCommand => ({ aliases: [], legacy: [], ...extra, name, group, description });

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  // Threads
  cmd("threads start", "Threads", "Start a new thread", {
    cli: "threads send",
    aliases: ["new"],
    legacy: ["new-mission", "new-chat", "threads new", "threads create", "onboard", "launcher", "run", "home"],
  }),
  cmd("threads list", "Threads", "Switch between threads", {
    cli: "threads list",
    legacy: ["threads", "chats", "sessions", "history", "runs", "ops", "chat", "back"],
  }),
  cmd("threads export", "Threads", "Export this thread", { cli: "threads list --export" }),
  cmd("threads close", "Threads", "Close this thread", { cli: "threads list --close", legacy: ["exit", "quit"] }),
  cmd("clear", "Threads", "Clear this thread", { cli: "threads list --clear" }),

  // Findings
  cmd("findings list", "Findings", "Review findings", {
    cli: "findings list",
    destination: "/findings",
    aliases: ["finds"],
    legacy: ["findings"],
  }),
  cmd("findings export", "Findings", "Export findings and reports", {
    cli: "findings list --format",
    destination: "/findings",
  }),
  cmd("fix", "Findings", "Write and test a fix; you approve any pull request", {
    cli: "scan fix",
    destination: "/fix",
    usage: "/fix [finding-id] | /fix publish <finding-id> | /fix cancel",
  }),

  // Agents, automation, computers
  cmd("agents list", "Agents", "Browse your agents", {
    cli: "agents list",
    destination: "/agents",
    legacy: ["agents"],
  }),
  cmd("agents create", "Agents", "Create an agent", { cli: "agents set --create", destination: "/agents" }),
  cmd("automation list", "Automation", "Browse automations", {
    cli: "agents list",
    destination: "/automations",
    legacy: ["automation", "automations"],
  }),
  cmd("automation run", "Automation", "Run an automation (you confirm first)", {
    cli: "agents run",
    destination: "/automations",
  }),
  cmd("computers list", "Computers", "Browse your computers", {
    cli: "computers list",
    destination: "/computers",
    legacy: ["computers"],
  }),

  // Models
  cmd("models list", "Models", "Models from your connected providers", {
    cli: "models list",
    destination: "/models",
    legacy: ["models"],
  }),
  cmd("models default", "Models", "Show the default model, or set this thread's", {
    cli: "models set",
    usage: "/models default [model]",
    legacy: ["model"],
  }),
  cmd("models connections", "Models", "Add an API key or sign in", {
    cli: "models connect",
    destination: "/connections",
    legacy: ["connect", "connections"],
  }),
  cmd("models usage", "Models", "Tokens, cost and context", {
    cli: "models list --usage",
    aliases: ["usage"],
    legacy: ["cost", "tokens"],
  }),

  // Skills, memory, plugins
  cmd("skills list", "Skills", "Browse your skills", {
    cli: "skills list",
    destination: "/plugins/skills",
    legacy: ["skills"],
  }),
  cmd("memory list", "Memory", "What 0 remembers", {
    cli: "memory list",
    destination: "/memory",
    legacy: ["memory"],
  }),
  cmd("plugin list", "Plugins", "Browse and enable plugins", {
    cli: "skills list",
    destination: "/plugins",
    aliases: ["plugins"],
    legacy: ["plugin", "hackstore", "store", "market", "marketplace"],
  }),
  cmd("plugin browse", "Plugins", "Explore plugins to install", {
    cli: "skills list --catalog",
    destination: "/plugins/explore",
  }),

  // Settings
  cmd("config list", "Settings", "Open settings", {
    cli: "config get --all",
    destination: "/settings",
    aliases: ["settings"],
    legacy: ["config", "prefs"],
  }),
  cmd("config get", "Settings", "Look up one setting", {
    cli: "config get",
    destination: "/settings",
    usage: "/config get <key>",
  }),
  cmd("config set", "Settings", "Change a setting", {
    cli: "config set",
    destination: "/settings",
    usage: "/config set <key> <value>",
  }),
  cmd("doctor", "Settings", "Check your setup", { cli: "config doctor", destination: "/doctor" }),

  // Chat only
  cmd("help", "Chat", "List commands", { aliases: ["commands"], legacy: ["?"], usage: "/help" }),
  cmd("status", "Chat", "Status of this thread"),
  cmd("tools", "Chat", "What 0 can do and what needs approval", {
    destination: "/tools",
    aliases: ["capabilities"],
    legacy: ["caps"],
  }),
  cmd("explain", "Chat", "Explain simply", { usage: "/explain [topic]", legacy: ["eli5"] }),
  cmd("copy", "Chat", "Copy this thread", { legacy: ["export", "dump"] }),
  cmd("feedback", "Chat", "Send feedback", {
    usage: "/feedback <message> | /feedback submit <message> | /feedback send | /feedback cancel",
  }),
  cmd("theme", "Chat", "Change appearance", { destination: "/settings", usage: "/theme [light|dark]", legacy: ["themes"] }),
  cmd("shortcuts", "Chat", "Keyboard shortcuts", { destination: "/settings", legacy: ["keybindings", "keys", "keymap"] }),
];

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/** Every canonical name, alias and legacy name → canonical name. */
const NAME_INDEX = new Map<string, string>();
for (const command of SLASH_COMMANDS) {
  for (const name of [command.name, ...command.aliases, ...command.legacy]) NAME_INDEX.set(name, command.name);
}
/** First words of two-word commands (`threads`, `models`...): typing one alone with extra text is not a command. */
const NOUNS = new Set(SLASH_COMMANDS.filter((c) => c.name.includes(" ")).map((c) => c.name.split(" ")[0]!));

export function getCommandByName(name: string): SlashCommand | undefined {
  const canonical = NAME_INDEX.get(name.trim().replace(/\s+/g, " "));
  return canonical ? SLASH_COMMANDS.find((c) => c.name === canonical) : undefined;
}

const NOT_SLASH: ParsedSlashInput = {
  isSlash: false,
  command: undefined,
  rawName: "",
  args: "",
  isKnown: false,
  isUnknown: false,
};

/**
 * Parse a raw input line. Longest name wins: `/models default gpt-5` is `models default`
 * with args `gpt-5`; `/sessions` resolves through a legacy name.
 */
export function findCommand(input: string): ParsedSlashInput {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return NOT_SLASH;
  const body = trimmed.slice(1);
  const words = body.trim().split(/\s+/).filter(Boolean);
  const unknown = (): ParsedSlashInput => ({
    isSlash: true,
    command: undefined,
    rawName: words[0] ?? "",
    args: words.slice(1).join(" "),
    isKnown: false,
    isUnknown: true,
  });
  for (const count of [2, 1]) {
    if (words.length < count) continue;
    const key = words.slice(0, count).join(" ").toLowerCase();
    const canonical = NAME_INDEX.get(key);
    if (!canonical) continue;
    const args = body.trimStart().split(/\s+/).slice(count).join(" ").trim();
    // `/threads bogus` is a mistake, not `/threads list` with an argument.
    if (count === 1 && NOUNS.has(key) && args) return unknown();
    return { isSlash: true, command: canonical, rawName: key, args, isKnown: true, isUnknown: false };
  }
  return unknown();
}

/**
 * Does `command` match the text typed after `/`? Word-by-word prefix match against the
 * name and visible aliases; legacy names only match exactly. Text with more words than
 * the command has means the arguments have started.
 */
export function matchesSlashQuery(command: SlashCommand, query: string): boolean {
  const typed = query.toLowerCase().replace(/^\s+/, "");
  if (!typed) return true;
  const tokens = typed.split(/\s+/);
  const prefix = (name: string) => {
    const parts = name.split(" ");
    return tokens.length <= parts.length && tokens.every((token, i) => parts[i]!.startsWith(token));
  };
  return prefix(command.name) || command.aliases.some(prefix) || command.legacy.includes(typed.trim());
}

/** Commands matching the text typed after `/`, in registry order. All commands for an empty query. */
export function filterCommands(query: string): SlashCommand[] {
  return SLASH_COMMANDS.filter((command) => matchesSlashQuery(command, query));
}
