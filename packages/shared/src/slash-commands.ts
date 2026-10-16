/**
 * Shared pure slash-command registry, parser, and filter.
 *
 * Portable — no React, OpenTUI, or @0/core imports. Usable by both
 * the Bun TUI (ChatScreen) and the Node readline console.
 *
 * A "slash command" is any input starting with `/` followed by a name
 * (alphanumeric, digits, hyphens, underscores). The parser detects
 * whether the input is a slash invocation, extracts the name and
 * argument string, and resolves it against the built-in vocabulary.
 *
 * Unknown slash commands produce `{ isSlash: true, isUnknown: true }`
 * so consumers can show a local notice — they MUST NOT reach the LLM.
 * Non-slash input is left for the engine as a normal operator message.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandCategory =
  | "navigation"
  | "session"
  | "info"
  | "system";

export interface SlashCommand {
  /** Canonical name (without leading `/`). */
  readonly name: string;
  /** Alternate names (without leading `/`). */
  readonly aliases: readonly string[];
  readonly category: CommandCategory;
  /** One-line description for help output. */
  readonly description: string;
  /** Usage hint, e.g. "/model <id>". Omitted when blank. */
  readonly usage?: string;
  /**
   * Commands that require the Bun TUI's interaction or routing surfaces.
   * The readline console explains that the TUI is required.
   */
  readonly tuiOnly?: boolean;
}

export interface ParsedSlashInput {
  /** True when the raw input starts with `/`. */
  readonly isSlash: boolean;
  /**
   * The canonical command name when the slash input resolves to a known
   * command. `undefined` for unknown slash commands or non-slash input.
   */
  readonly command: string | undefined;
  /**
   * The raw name extracted from input: everything between the leading `/`
   * and the first space (or end of string). E.g. "/model gpt-5.5" → "model".
   */
  readonly rawName: string;
  /**
   * Everything after the first space following the command name (trimmed).
   * Empty string when there are no arguments.
   */
  readonly args: string;
  /** True when a known command was matched. */
  readonly isKnown: boolean;
  /** True when input starts with `/` but does NOT match a known command. */
  readonly isUnknown: boolean;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  // ── info ────────────────────────────────────────────────────────────────
  {
    name: "help",
    aliases: ["?", "commands"],
    category: "info",
    description: "List commands",
    usage: "/help [command]",
  },
  {
    name: "capabilities",
    aliases: ["caps"],
    category: "info",
    description: "What 0 can do and what needs approval",
    usage: "/capabilities",
    tuiOnly: true,
  },
  {
    name: "status",
    aliases: [],
    category: "info",
    description: "Session status",
  },
  {
    name: "tools",
    aliases: [],
    category: "info",
    description: "List available tools",
  },

  {
    name: "new-chat",
    aliases: ["new"],
    category: "navigation",
    description: "Start a fresh audit",
    tuiOnly: true,
  },
  {
    name: "onboard",
    aliases: [],
    category: "navigation",
    description: "Run setup again",
    tuiOnly: true,
  },

  // ── session ─────────────────────────────────────────────────────────────
  {
    name: "clear",
    aliases: [],
    category: "session",
    description: "Clear the conversation",
  },
  {
    name: "history",
    aliases: [],
    category: "session",
    description: "Past scans",
    tuiOnly: true,
  },
  {
    name: "findings",
    aliases: ["finds"],
    category: "session",
    description: "Show findings",
    tuiOnly: true,
  },
  {
    name: "fix",
    aliases: [],
    category: "session",
    description: "Write and test a fix; you approve any PR",
    usage: "/fix [finding-id] | /fix publish <finding-id> | /fix cancel",
    tuiOnly: true,
  },
  {
    name: "copy",
    aliases: ["export", "dump"],
    category: "session",
    description: "Copy the conversation",
    usage: "/copy",
    tuiOnly: true,
  },

  {
    name: "sessions",
    aliases: [],
    category: "session",
    description: "Switch or resume a conversation",
    usage: "/sessions",
    tuiOnly: true,
  },
  {
    name: "explain",
    aliases: ["eli5"],
    category: "session",
    description: "Explain simply",
    usage: "/explain [topic]",
    tuiOnly: true,
  },
  {
    name: "feedback",
    aliases: [],
    category: "system",
    description: "Send feedback",
    usage: "/feedback <message> | /feedback submit <message> | /feedback send | /feedback cancel",
    tuiOnly: true,
  },
  {
    name: "settings",
    aliases: ["config", "prefs"],
    category: "system",
    description: "Open settings",
    usage: "/settings",
    tuiOnly: true,
  },
  {
    name: "keybindings",
    aliases: ["keys", "keymap"],
    category: "system",
    description: "Keyboard shortcuts",
    usage: "/keybindings",
    tuiOnly: true,
  },
  {
    name: "theme",
    aliases: ["themes"],
    category: "system",
    description: "Change the colour theme",
    usage: "/theme [name]",
    tuiOnly: true,
  },
  {
    name: "model",
    aliases: ["models"],
    category: "session",
    description: "Choose a model",
    usage: "/model [id]",
    tuiOnly: true,
  },

  // ── navigation ──────────────────────────────────────────────────────────
  {
    name: "chat",
    aliases: [],
    category: "navigation",
    description: "Back to the conversation",
    tuiOnly: true,
  },
  {
    name: "launcher",
    aliases: ["run", "home"],
    category: "navigation",
    description: "Scan one target",
    tuiOnly: true,
  },
  {
    name: "ops",
    aliases: ["runs"],
    category: "navigation",
    description: "Running and recent scans",
    tuiOnly: true,
  },
  {
    name: "hackstore",
    aliases: ["store", "market", "marketplace"],
    category: "navigation",
    description: "Install extensions and themes",
    tuiOnly: true,
  },
  {
    name: "connect",
    aliases: [],
    category: "navigation",
    description: "Add an API key or sign in",
    usage: "/connect",
    tuiOnly: true,
  },
  {
    name: "usage",
    aliases: ["cost", "tokens"],
    category: "navigation",
    description: "Tokens, cost and context",
    usage: "/usage",
    tuiOnly: true,
  },
  {
    name: "back",
    aliases: [],
    category: "navigation",
    description: "Previous screen",
    tuiOnly: true,
  },
  {
    name: "scope",
    aliases: [],
    category: "navigation",
    description: "What 0 is allowed to test",
    tuiOnly: true,
  },

  // ── system ──────────────────────────────────────────────────────────────
  {
    name: "doctor",
    aliases: [],
    category: "system",
    description: "Check your setup",
    tuiOnly: true,
  },
  {
    name: "exit",
    aliases: ["quit"],
    category: "system",
    description: "Quit",
  },
];

// ---------------------------------------------------------------------------
// Index — static string-keyed lookup table
// ---------------------------------------------------------------------------

/** Maps every canonical name and alias → canonical name (lowercase). */
const NAME_INDEX: Record<string, string> = {};
for (const cmd of SLASH_COMMANDS) {
  NAME_INDEX[cmd.name] = cmd.name;
  for (const alias of cmd.aliases) {
    NAME_INDEX[alias] = cmd.name;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a command by canonical name or alias (case-sensitive, lower-case
 * only). Returns `undefined` when no match exists.
 */
export function getCommandByName(name: string): SlashCommand | undefined {
  const canonical = NAME_INDEX[name];
  if (!canonical) return undefined;
  // Linear scan over the small static array — fine at this scale.
  // Swap to a canonical-indexed Record if the list grows past ~50.
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.name === canonical) return cmd;
  }
  return undefined;
}

/**
 * Parse a raw input line and resolve it against the command vocabulary.
 *
 * Non-slash inputs return `{ isSlash: false, isKnown: false, isUnknown: false }`.
 * Unknown slash commands (e.g. "/blarg") return `{ isSlash: true, isUnknown: true }`.
 * Known commands populate `command`, `rawName`, and `args`.
 *
 * Consumers MUST check `isUnknown` before sending to the LLM — unknown
 * slash commands produce a local notice and MUST NOT reach the engine.
 */
export function findCommand(input: string): ParsedSlashInput {
  const trimmed = input.trimStart();

  if (!trimmed.startsWith("/")) {
    return {
      isSlash: false,
      command: undefined,
      rawName: "",
      args: "",
      isKnown: false,
      isUnknown: false,
    };
  }

  // Strip the leading "/" and split on first space
  const afterSlash = trimmed.slice(1);
  const spaceIndex = afterSlash.indexOf(" ");
  const rawName = spaceIndex >= 0 ? afterSlash.slice(0, spaceIndex) : afterSlash;
  const args = spaceIndex >= 0 ? afterSlash.slice(spaceIndex + 1).trim() : "";

  const canonical = NAME_INDEX[rawName];
  if (canonical) {
    return {
      isSlash: true,
      command: canonical,
      rawName,
      args,
      isKnown: true,
      isUnknown: false,
    };
  }

  return {
    isSlash: true,
    command: undefined,
    rawName,
    args,
    isKnown: false,
    isUnknown: true,
  };
}

/**
 * Filter the command vocabulary by a query string. Matches against
 * canonical names and aliases (case-insensitive prefix match).
 *
 * Returns all commands when query is empty. Commands are ordered by
 * category, then alphabetically by canonical name.
 */
export function filterCommands(query: string): SlashCommand[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [...SLASH_COMMANDS];

  return SLASH_COMMANDS.filter((cmd) => {
    if (cmd.name.startsWith(trimmed)) return true;
    return cmd.aliases.some((a) => a.startsWith(trimmed));
  });
}