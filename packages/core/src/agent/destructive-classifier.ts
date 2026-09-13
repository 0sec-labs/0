/**
 * Conservative, presentation-only classification of a pending tool call as a
 * DESTRUCTIVE operation, so the approval surface can mark it (a distinct tone,
 * a glyph, a deny-first selection) BEFORE the operator decides.
 *
 * WHAT THIS IS NOT. Not a sandbox, not an authorization gate, not a safety
 * guarantee. It never changes whether a call is gated, what is authorized, or
 * the scope — the standard-mode approval still fires exactly as before; this
 * only decides how that prompt is dressed. A `"destructive"` result is a cue to
 * look carefully, never a claim that every destructive command is detected.
 *
 * DESIGN: A WHITELISTED SYNTAX SUBSET, NOT PATTERN MATCHING. The only lever we
 * have is the lossy {@link shellTokens} splitter, which does not model quotes'
 * origin, backslash escapes, comments, substitutions, redirection, heredocs, or
 * grouping. Rather than chase each of those with special cases (a losing game —
 * a quoted / escaped / commented / heredoc'd `rm -rf` all defeat naive
 * splitting), we FIRST reject any command that uses syntax outside a tiny,
 * fully-understood subset, returning `"unknown"`. What remains is only: literal
 * words, separated by whitespace and by the operators `; | &` (and newlines).
 * In THAT subset, and only there, shellTokens is faithful: separators are real
 * and every token is a literal word. We then recognize a small set of
 * unambiguous destructive command heads.
 *
 * BOUNDS, STATED HONESTLY. This detects destructive intent ONLY for directly
 * invoked, recognized commands written in the accepted subset. It deliberately
 * does NOT model, and returns `"unknown"` for: wrapper/prefix programs
 * (`sudo`, `env`, `command -v`, `xargs`, …), shell/interpreter `-c` bodies,
 * aliases, shell functions, custom or renamed executables, `git` with any
 * global/terminating option, and anything using escaping, comments,
 * substitution, expansion, redirection, heredocs, or grouping. There is NO
 * universal no-false-positive guarantee beyond this stated subset — an
 * environment where `rm` is an alias for something harmless, or a custom `rm`
 * on PATH, is not modeled. Command names are matched CASE-SENSITIVELY (POSIX).
 * Under-flagging costs only a missing glyph (the gate still fires and the
 * operator still sees the full command); a false danger erodes the signal, so
 * we bias hard toward `"unknown"`.
 */
import type { ToolCall, ToolRisk, DestructiveCategory } from "./types.js";
import { shellTokens } from "./shell-tokens.js";

/**
 * Metacharacters that put a command OUTSIDE the accepted subset. Their presence
 * means shellTokens can no longer be trusted to identify command boundaries or
 * heads, so the command is classified `"unknown"` rather than guessed. Covers:
 * quotes (`' "`), backslash escaping (`\`), comments (`#`), substitution and
 * expansion (`$` and backticks), redirection / heredocs (`< >`), and grouping /
 * control (`( ) { } !`). Glob characters (`* ? [ ]`) are intentionally NOT here:
 * they are ordinary arguments that neither hide the head nor create a boundary.
 */
const UNSUPPORTED_SYNTAX = /['"\\#$`<>(){}!]/;

/** A separator token emitted by {@link shellTokens} (a run of `; | &`, or a newline). */
function isSeparator(token: string): boolean {
  return token === "|" || token === "||" || token === "&" || token === "&&"
    || token === ";" || token === ";;" || token === "\n";
}

/**
 * Basename of a command token (`/usr/bin/rm` → `rm`). NOT lowercased — POSIX
 * command names are case-sensitive, so `RM` is a different program than `rm`.
 */
function programName(token: string): string {
  const cleaned = token.replace(/^\.\//, "");
  const slash = cleaned.lastIndexOf("/");
  return slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
}

/** A short flag cluster (single `-`, not `--`) containing the given letter. */
function shortFlagHas(token: string, letter: string): boolean {
  return /^-[^-]/.test(token) && token.includes(letter);
}

/** The option tokens of a window — everything up to a `--` end-of-options marker. */
function optionsOf(window: readonly string[]): string[] {
  const end = window.indexOf("--");
  return end >= 0 ? window.slice(0, end) : [...window];
}

/** A `--help` request — never a destructive execution. */
function isHelp(options: readonly string[]): boolean {
  return options.includes("--help");
}

/** A `--dry-run` / `-n` form — describes, does not perform. */
function isDryRun(options: readonly string[]): boolean {
  return options.includes("--dry-run") || options.includes("-n");
}

/** `rm`/`rmdir` recursion: `-r`, `-R`, a short cluster containing r/R, or `--recursive`. */
function hasRecursiveFlag(options: readonly string[]): boolean {
  return options.some((t) => t === "--recursive" || shortFlagHas(t, "r") || shortFlagHas(t, "R"));
}

/** A `kill` signal that is unambiguously a hard kill: `-9`, `-KILL`, `-SIGKILL`. */
function hasHardKillSignal(options: readonly string[]): boolean {
  return options.some((t) => t === "-9" || /^-s?(ig)?kill$/i.test(t));
}

/**
 * Classify a `git` invocation. Only the plainest form is modeled: the
 * subcommand must be the FIRST window token. Any leading global or terminating
 * option (`-C`, `-c`, `--version`, `--help`, …) means `"unknown"` — we do not
 * model git's global-option grammar.
 */
function classifyGit(window: readonly string[]): DestructiveCategory | undefined {
  const sub = window[0];
  if (sub === undefined || sub.startsWith("-")) return undefined;
  const opts = optionsOf(window.slice(1));
  if (isHelp(opts)) return undefined;
  if (sub === "reset" && opts.includes("--hard")) return "repo-history-rewrite";
  if (sub === "clean" && opts.some((t) => shortFlagHas(t, "f")) && !isDryRun(opts)) return "repo-history-rewrite";
  if (sub === "push"
    && (opts.includes("--force") || opts.includes("-f") || opts.includes("--force-with-lease"))
    && !isDryRun(opts)) return "repo-history-rewrite";
  return undefined;
}

/**
 * Classify one command HEAD plus its argument window (tokens up to the next
 * separator). Returns the destructive category, or `undefined` when not
 * recognized. Only DIRECTLY invoked, recognized commands are modeled — there is
 * no wrapper/prefix handling (see the file header).
 */
function classifyHead(program: string, window: readonly string[]): DestructiveCategory | undefined {
  const opts = optionsOf(window);
  if (isHelp(opts)) return undefined;
  if (program === "rm" || program === "rmdir") {
    return hasRecursiveFlag(opts) ? "recursive-delete" : undefined;
  }
  if (program === "shred") return "recursive-delete";
  if (program === "dd") {
    return opts.some((t) => /^of=/.test(t)) ? "disk-write" : undefined;
  }
  if (program === "mkfs" || program.startsWith("mkfs.") || program === "wipefs") {
    return "filesystem-format";
  }
  if (program === "killall" || program === "pkill") return "process-kill";
  if (program === "kill") return hasHardKillSignal(opts) ? "process-kill" : undefined;
  if (program === "git") return classifyGit(window);
  return undefined;
}

/**
 * Classify a raw `bash` command string. Rejects anything outside the accepted
 * syntax subset (→ unknown), then walks each `; | &`/newline-separated segment:
 * leading `NAME=value` env assignments are stepped over and the next token is
 * the command head. Returns the FIRST destructive match (left to right), else
 * unknown.
 */
export function classifyBashCommand(command: string): ToolRisk {
  if (UNSUPPORTED_SYNTAX.test(command)) return { level: "unknown" };
  const tokens = shellTokens(command);
  let atHead = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isSeparator(token)) { atHead = true; continue; }
    if (!atHead) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // FOO=bar assignment precedes the head
    atHead = false;
    const program = programName(token);
    const window: string[] = [];
    for (let j = i + 1; j < tokens.length && !isSeparator(tokens[j]!); j++) window.push(tokens[j]!);
    const category = classifyHead(program, window);
    if (category) return { level: "destructive", category };
  }
  return { level: "unknown" };
}

/**
 * Classify a pending {@link ToolCall} for the approval surface. Only the `bash`
 * tool's `command` string is analyzed; every other tool that reaches the prompt
 * is `"unknown"` (this pass does not model non-shell effects). Never throws.
 */
export function classifyToolRisk(call: ToolCall): ToolRisk {
  if (call.name !== "bash") return { level: "unknown" };
  const command = call.arguments?.command;
  if (typeof command !== "string" || command.trim() === "") return { level: "unknown" };
  return classifyBashCommand(command);
}

/**
 * The fixed, operator-facing label for a destructive category. Derived only
 * from the enum — never from the command text — so naming the danger cannot
 * leak a secret-bearing argument.
 */
export function describeDestructiveCategory(category: DestructiveCategory): string {
  switch (category) {
    case "recursive-delete": return "recursive file deletion";
    case "disk-write": return "raw disk / device write";
    case "filesystem-format": return "filesystem format";
    case "process-kill": return "process termination";
    case "repo-history-rewrite": return "git history rewrite";
  }
}
