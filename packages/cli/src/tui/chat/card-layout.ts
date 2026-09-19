/**
 * Pure geometry and derivation for the transcript's rich cards (tool + image).
 *
 * Everything in this module answers the same question: *what do we actually
 * know about this entry, and how many cells may we spend saying it?* Nothing
 * here invents a value. Every helper returns `undefined`/`null`/`[]` when the
 * datum it would render is absent, and the renderer omits the element rather
 * than printing a plausible-looking placeholder in its place. That discipline
 * is the point of splitting these out: a badge, a title, a duration and an
 * image dimension are all derived here, in one testable place, from fields
 * that genuinely exist on `ChatEntry` / `ToolPreview`.
 *
 * It is also where the no-overflow arithmetic lives. OpenTUI does not clip, so
 * a card wider or taller than the transcript column paints straight through
 * its neighbours. Every function that returns a width or a row count is
 * clamped to the budget it was handed.
 */

import { fitTuiText, sanitizeTuiText } from "../text.js";
import type { ToolPreview } from "../tool-format.js";
import type { ChatEntry, ChatImageAttachment } from "./types.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Longest a border badge may be, chip padding included. Truncates below this. */
export const MAX_BADGE_CELLS = 14;

/** Rows a card's output region may occupy before it scrolls instead of grows. */
export const MAX_OUTPUT_ROWS = 20;

/** Rows an inline image may occupy. Keeps one attachment off a whole screen. */
export const MAX_IMAGE_ROWS = 20;

/**
 * Terminal cells are roughly twice as tall as they are wide. Used ONLY to pick
 * how many rows a picture is drawn into — never reported to the operator as a
 * dimension, because it is an approximation of the *cell*, not of the image.
 */
const CELL_ASPECT = 2;

// ---------------------------------------------------------------------------
// Tool state — derived, never assumed
// ---------------------------------------------------------------------------

/**
 * The three states a tool row can truthfully be in.
 *
 * "running" is the state of a call with NO recorded outcome — it is not a
 * success and must never be painted as one. A card reaches "ok" only when the
 * record says `success === true` and nothing else contradicts it.
 */
export type ToolState = "running" | "ok" | "failed";

/**
 * Read the entry's real outcome. A non-zero exit code or a wallclock timeout
 * is a failure even when `success` was optimistically recorded true, and an
 * absent `success` is "still running", never "fine".
 */
export function toolState(entry: ChatEntry): ToolState {
  if (
    entry.success === false ||
    entry.timedOut === true ||
    (typeof entry.exitCode === "number" && entry.exitCode !== 0)
  ) {
    return "failed";
  }
  if (entry.success === undefined) return "running";
  return "ok";
}

/** Glyph and word for a state. Mirrors `toolGlyphState`'s vocabulary. */
export function toolStateLabel(state: ToolState): { glyph: string; word: string } {
  if (state === "failed") return { glyph: "×", word: "failed" };
  if (state === "running") return { glyph: "◌", word: "running" };
  return { glyph: "✓", word: "complete" };
}

// ---------------------------------------------------------------------------
// The top-border badge
// ---------------------------------------------------------------------------

/**
 * Short, upper-case labels for the languages our preview projector can
 * actually name. Anything outside the map falls back to the language's own
 * name upper-cased — which is still the real language, just unabbreviated.
 */
const LANG_BADGE: Record<string, string> = {
  typescript: "TS",
  tsx: "TSX",
  javascript: "JS",
  jsx: "JSX",
  json: "JSON",
  python: "PY",
  bash: "SH",
  yaml: "YAML",
  rust: "RS",
  go: "GO",
  c: "C",
  cpp: "C++",
  css: "CSS",
  html: "HTML",
};

/** The real file extension of a path, lower-cased, or "" when it has none. */
export function pathExtension(path: string | undefined): string {
  const clean = sanitizeTuiText(path ?? "");
  if (!clean) return "";
  const base = clean.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9+#]{1,8}$/.test(ext) ? ext : "";
}

/**
 * The badge that sits on the card's top border: the language the body is in,
 * or — when the body has no language — the tool kind that produced it.
 *
 * Every branch is sourced from a field that exists:
 *   - a command card's body IS a shell transcript             → "SH"
 *   - a web card was produced by the web-search tool          → "WEB"
 *   - an edit card's language is the edited file's extension  → "TS", "PY", …
 *   - a projected preview that carries a language             → that language
 *   - anything else is named by the tool that ran             → e.g. "READ_FILE"
 *
 * Never returns an empty string: `entry.text` is the tool name and is always
 * present on a tool entry, so the worst case is an honest tool name.
 */
export function toolBadgeLabel(entry: ChatEntry, preview?: ToolPreview): string {
  if (entry.metaKind === "command") return "SH";
  if (entry.metaKind === "web") return "WEB";
  if (entry.metaKind === "edit") {
    const ext = pathExtension(entry.editPath);
    const mapped = ext ? LANG_BADGE[ext] : undefined;
    if (mapped) return mapped;
    if (ext) return ext.toUpperCase();
    return "EDIT";
  }
  const language = preview?.language;
  if (language) return LANG_BADGE[language.toLowerCase()] ?? language.toUpperCase();
  // A recognised tool's badge is its verb ("READ", "GREP") rather than the raw
  // snake_case name ("READ_FILE"), matching the identity carried in the title.
  const identity = toolKindIdentity(entry.text);
  if (identity) return identity.verb.toUpperCase();
  const name = sanitizeTuiText(entry.text).trim();
  return name ? name.toUpperCase() : "TOOL";
}

/**
 * Wrap a badge as a chip for a border title (` JS `) and fit it to the cells
 * the border can pay for. Returns "" when there is no room at all, and the
 * caller then draws a bare border — a clipped half-badge is worse than none.
 */
export function badgeChip(label: string, borderCells: number): string {
  const room = Math.min(MAX_BADGE_CELLS, Math.max(0, Math.floor(borderCells)));
  // Two pad cells plus at least two characters of label, or it is not a chip.
  if (room < 4) return "";
  const text = fitTuiText(label, room - 2);
  return text ? ` ${text} ` : "";
}

// ---------------------------------------------------------------------------
// Per-tool identity (verb + glyph)
// ---------------------------------------------------------------------------

/** A tool kind's display identity: an imperative verb and a header glyph. */
export interface ToolIdentity {
  /** The imperative verb the title leads with ("Read", "Grep", "Write"). */
  verb: string;
  /** A single glyph drawn in the card headline, distinct per kind. */
  glyph: string;
}

/**
 * Verb + glyph for the tools that have no dedicated `metaKind` card
 * (command / edit / web / task each have their own branch and glyph). This is
 * what turns the old flat `read_file · path=…` line into a real operation —
 * "Read <path>", "Grep <query>", "Write <path>" — the way OMP gives every tool
 * its own identity. Keyed by the canonical tool name and common aliases; a name
 * outside the table keeps the generic `name · args` fallback rather than being
 * mislabelled.
 */
export const TOOL_IDENTITY: Record<string, ToolIdentity> = {
  // Filesystem / source
  read_file: { verb: "Read", glyph: "▤" },
  read: { verb: "Read", glyph: "▤" },
  list_files: { verb: "List", glyph: "☰" },
  list: { verb: "List", glyph: "☰" },
  search_files: { verb: "Grep", glyph: "⌕" },
  grep: { verb: "Grep", glyph: "⌕" },
  glob: { verb: "Glob", glyph: "⌕" },
  write_file: { verb: "Write", glyph: "✎" },
  write: { verb: "Write", glyph: "✎" },
  str_replace: { verb: "Edit", glyph: "✎" },
  apply_patch: { verb: "Patch", glyph: "✎" },
  run_command: { verb: "Run", glyph: "▷" },
  bash: { verb: "Run", glyph: "▷" },
  python_exec: { verb: "Python", glyph: "⚙" },
  // Network / recon
  fetch: { verb: "Fetch", glyph: "⚓" },
  http_request: { verb: "HTTP", glyph: "⚓" },
  crawl: { verb: "Crawl", glyph: "⌘" },
  submit_form: { verb: "Submit", glyph: "⏎" },
  browser: { verb: "Browser", glyph: "◈" },
  web_search: { verb: "Search", glyph: "⌕" },
  // Findings ledger / planning
  save_finding: { verb: "Finding", glyph: "⚑" },
  update_finding: { verb: "Finding", glyph: "⚑" },
  query_findings: { verb: "Findings", glyph: "⚑" },
  use_loot: { verb: "Loot", glyph: "❖" },
  plan: { verb: "Plan", glyph: "☑" },
  update_todos: { verb: "Plan", glyph: "☑" },
  write_todos: { verb: "Plan", glyph: "☑" },
  done: { verb: "Done", glyph: "✓" },
  update_target: { verb: "Target", glyph: "◇" },
  // Intelligence
  intel: { verb: "Intel", glyph: "❋" },
  // Scanners / orchestration
  run_scanner: { verb: "Scan", glyph: "◎" },
  start_scan: { verb: "Scan", glyph: "◎" },
  analyze_binary: { verb: "Analyze", glyph: "⚙" },
  spawn_agent: { verb: "Spawn", glyph: "⚉" },
  spawn_agents: { verb: "Spawn", glyph: "⚉" },
  ask_operator: { verb: "Ask", glyph: "?" },
};

/**
 * Verb maps for the tools whose REAL operation lives in a discriminator
 * argument (`action` / `tool`) rather than the tool name. `formatToolArgs`
 * leads these tools' argument summary with the raw discriminator token, and
 * `toolActionTitle` promotes it to a proper verb here — so `intel
 * search_advisories go:…` reads as `Advisories go:…`, matching OMP's
 * per-operation titles rather than a single flat `Intel …`.
 */
const DISCRIMINATED_VERBS: Record<string, Record<string, string>> = {
  intel: {
    search_advisories: "Advisories",
    advisory_sweep: "Sweep",
    search_public_reports: "Reports",
    lookup_cve: "CVE",
    search_similar: "Similar",
    build_dossier: "Dossier",
    search_target_history: "History",
  },
  run_scanner: {
    nmap: "Nmap",
    nuclei: "Nuclei",
    sqlmap: "SQLMap",
    ffuf: "Ffuf",
  },
  browser: {
    navigate: "Navigate",
    click: "Click",
    fill: "Fill",
    evaluate: "Evaluate",
    content: "Content",
    screenshot: "Screenshot",
  },
};

/** The display identity for a tool name, or `undefined` when it has none. */
export function toolKindIdentity(name: string | undefined): ToolIdentity | undefined {
  const key = sanitizeTuiText(name ?? "").trim().toLowerCase();
  return key ? TOOL_IDENTITY[key] : undefined;
}

// ---------------------------------------------------------------------------
// The true action title
// ---------------------------------------------------------------------------

/**
 * The REAL operation this card describes, assembled only from recorded fields.
 *
 * There is no generic fallback text here. A command card is titled by the
 * command that ran, an edit by the path that changed, a web search by its
 * provider, and every other tool by its own name plus the one-line argument
 * summary the formatter already produced. If a field is missing the title
 * simply gets shorter.
 */
export function toolActionTitle(entry: ChatEntry): string {
  if (entry.metaKind === "command") {
    const command = sanitizeTuiText(entry.command ?? "").trim();
    if (command) return `$ ${command}`;
  }
  if (entry.metaKind === "edit") {
    const path = sanitizeTuiText(entry.editPath ?? "").trim();
    if (path) return `Edit ${path}`;
  }
  if (entry.metaKind === "web") {
    const provider = sanitizeTuiText(entry.webProvider ?? "").trim();
    return provider ? `Web Search · ${provider}` : "Web Search";
  }
  const name = sanitizeTuiText(entry.text).trim();
  const args = sanitizeTuiText(entry.toolArgs ?? "").trim();
  // A recognised tool reads as its operation: verb + the already-formatted
  // primary argument summary — "Read a/b.ts @120", "Grep \"foo\" in src". The
  // arg string `formatToolArgs` produces is already a clean one-liner, so it is
  // appended whole rather than re-parsed. A tool with no identity keeps the
  // honest `name · args` form; nothing renders as a bare tool name alone.
  const identity = toolKindIdentity(name);
  if (identity) {
    // Discriminated tools (`intel`, `run_scanner`, `browser`) carry the real
    // operation in the FIRST argument token; promote it to the verb so the
    // title reads `Advisories go:…` / `Nmap host` rather than `Intel
    // search_advisories …`. When the token is unknown, the identity verb + the
    // whole (still leading-token) args is an honest fallback.
    const verbs = DISCRIMINATED_VERBS[name.toLowerCase()];
    if (verbs && args) {
      const sp = args.indexOf(" ");
      const token = sp === -1 ? args : args.slice(0, sp);
      const rest = sp === -1 ? "" : args.slice(sp + 1);
      const verb = verbs[token];
      if (verb) return rest ? `${verb} ${rest}` : verb;
    }
    return args ? `${identity.verb} ${args}` : identity.verb;
  }
  if (name && args) return `${name} · ${args}`;
  return name || args;
}

// ---------------------------------------------------------------------------
// The result summary
// ---------------------------------------------------------------------------

/**
 * The completed call's RESULT summary — the "what it found" line an OMP tool
 * row carries after its title (`Findings (limit 20) · 20 findings · (1.2s)`).
 *
 * It is `entry.detail` — but ONLY once the call has settled. While a call is
 * still running, `detail` holds the ARGUMENT summary (the producer stamps
 * `formatToolArgs` there so the running row still says what it is doing), which
 * is emphatically not a result. So a summary is offered only when an outcome
 * has actually been recorded (`success` is no longer undefined), and never for
 * the metaKind cards that render their own result region and would only be
 * duplicating it in the headline (command output, edit diff, web answer). Every
 * other completed tool row gets its one bounded, already-redacted line.
 */
export function toolResultLine(entry: ChatEntry): string | undefined {
  if (entry.success === undefined) return undefined;
  if (entry.metaKind === "command" || entry.metaKind === "edit" || entry.metaKind === "web") {
    return undefined;
  }
  const detail = sanitizeTuiText(entry.detail ?? "").trim();
  return detail || undefined;
}

// ---------------------------------------------------------------------------
// The input region
// ---------------------------------------------------------------------------

/** The card's INPUT: what was asked of the tool, plus the language to lex it as. */
export interface ToolInputSection {
  /** Heading shown above the block ("Command", "Query", "Arguments"). */
  label: string;
  /** A language `highlightCode` understands, or undefined for flat text. */
  language?: string;
  lines: readonly string[];
}

/**
 * Project the call's input for display, or `null` when the entry retained no
 * input at all (a restored transcript often has not), OR when the input would
 * merely restate what the headline / body already shows.
 *
 * The card headline IS the operation that ran, so an input section that repeats
 * it is dead weight — the "command shown twice" bug. It is therefore suppressed
 * for every metaKind whose distinctive content already lives elsewhere on the
 * card:
 *   - command → the `$ cmd` headline already IS the command; body is its output
 *   - edit    → the headline carries the path; the body is the diff
 *   - web     → the headline names the search; the body carries query/answer/sources
 * Only a generic tool — whose header is a bounded, possibly-truncated verb line
 * and whose body is just its output — keeps an Arguments section, because that
 * is the one place its full recorded input is shown.
 */
export function toolInputSection(entry: ChatEntry, maxLines = 12): ToolInputSection | null {
  const cap = Math.max(1, Math.floor(maxLines));
  const split = (text: string): string[] =>
    text.replace(/\s+$/, "").split("\n").slice(0, cap).map((line) => sanitizeTuiText(line));

  // command / edit / web all render their input in the headline or the body,
  // so a raw input section here would only duplicate it.
  if (entry.metaKind === "command" || entry.metaKind === "edit" || entry.metaKind === "web") {
    return null;
  }
  const args = (entry.toolArgs ?? "").trim();
  if (!args) return null;
  // `formatToolArgs` emits `key=value` fragments; JSON lexing colours the
  // punctuation and literals in them without ever mis-claiming a language.
  return { label: "Arguments", language: "json", lines: split(args) };
}

// ---------------------------------------------------------------------------
// The status region
// ---------------------------------------------------------------------------

/**
 * Human duration for a measured wallclock, or `undefined` when nothing was
 * measured. There is no estimation path: an entry with no `wallMs` renders no
 * duration anywhere on the card.
 */
export function formatDurationMs(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
}

/**
 * Compact a count for a per-agent status line: `842`, `12.4k`, `3.1M`. Mirrors
 * OMP's `formatNumber` compaction (there is no such helper in the TUI yet). A
 * non-finite or negative input reads `0` rather than throwing — the caller only
 * ever prints this for a value it has already confirmed is present.
 */
export function formatCompact(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  // One decimal in the k / M range (`12.4k`, `3.1M`), trailing `.0` stripped
  // so a round thousand reads `12k`, not `12.0k`.
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * Compact status fragment appended to the card HEADLINE, OMP-style. The old
 * multi-row State / Exit / Ceiling / Output block is gone: the run's STATE is
 * already carried by the border colour and the headline glyph, its DURATION
 * rides the border (` · (<dur>)`), and its output-line count is self-evident
 * from the Output region — so none of those earns a row of its own.
 *
 * What is left is the handful of facts a glance at the border cannot convey,
 * folded onto the header as ` · <fact>` segments, and ONLY when the field was
 * actually recorded:
 *   - a wallclock kill        → `timed out`
 *   - a non-zero exit code    → `exit N`   (a zero exit is the unremarkable case)
 *   - an edit's line delta     → `+A -R`
 *   - a web search's source count → `N sources`
 *
 * The running-only "Ceiling" (the timeout budget) is intentionally NOT here —
 * it belongs on the live running note (`toolRunningNote`) and disappears once
 * the call settles.
 */
export function toolHeaderStatus(entry: ChatEntry, state: ToolState): string {
  const parts: string[] = [];
  if (entry.timedOut === true) parts.push("timed out");
  if (typeof entry.exitCode === "number" && entry.exitCode !== 0) parts.push(`exit ${entry.exitCode}`);
  if (state === "failed" && !parts.length && entry.metaKind !== "edit" && entry.metaKind !== "web") {
    // A failure with no exit/timeout signal still says so once, so the header
    // is never a silent-looking success painted only by the border colour.
    parts.push("failed");
  }
  if (entry.metaKind === "edit" && (entry.editAdded !== undefined || entry.editRemoved !== undefined)) {
    const seg: string[] = [];
    if (entry.editAdded !== undefined) seg.push(`+${entry.editAdded}`);
    if (entry.editRemoved !== undefined) seg.push(`-${entry.editRemoved}`);
    if (seg.length) parts.push(seg.join(" "));
  }
  if (entry.metaKind === "web" && entry.webSources && entry.webSources.length > 0) {
    const n = entry.webSources.length;
    parts.push(`${n} source${n === 1 ? "" : "s"}`);
  }
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

/**
 * The single muted note drawn beneath a card while it is still RUNNING —
 * `◌ running`, plus the wallclock ceiling (the timeout budget) when one was
 * recorded, e.g. `running · ceiling 30s`. Returns `undefined` for a settled
 * call, which shows no note at all. `glyph` is the state glyph the caller
 * already computed.
 */
export function toolRunningNote(entry: ChatEntry, state: ToolState, glyph: string): string | undefined {
  if (state !== "running") return undefined;
  const ceiling =
    typeof entry.timeoutMs === "number" && Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0
      ? ` · ceiling ${Math.round(entry.timeoutMs / 1000)}s`
      : "";
  return `${glyph} running${ceiling}`;
}

// ---------------------------------------------------------------------------
// Image geometry
// ---------------------------------------------------------------------------

/**
 * The badge for an image card's top border: the marker, the 1-based index, and
 * the real decoded format when one was recorded. `#N` comes from the caller's
 * own attachment order, so it is a fact about the message, not a guess.
 */
export function imageBadgeLabel(image: ChatImageAttachment): string {
  const index = Number.isFinite(image.index) ? Math.max(1, Math.floor(image.index)) : 1;
  const format = sanitizeTuiText(image.format ?? "").trim();
  return format ? `IMG #${index} · ${format.toUpperCase()}` : `IMG #${index}`;
}

/**
 * The bottom-border label: the ACTUAL pixel dimensions, or `undefined` when
 * they were not decoded. There is no fallback — an image whose size we never
 * measured shows no size at all. Returned UNPADDED; the caller wraps it in the
 * chip spaces after fitting, because `fitTuiText` trims its argument.
 */
export function imageDimensionsLabel(image: ChatImageAttachment): string | undefined {
  const w = image.pixelWidth;
  const h = image.pixelHeight;
  if (typeof w !== "number" || typeof h !== "number") return undefined;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
  return `${Math.round(w)} × ${Math.round(h)} px`;
}

/** Cell box an inline image is drawn into. Always inside the budget handed in. */
export interface ImageCellBox {
  cols: number;
  rows: number;
}

/**
 * Fit a picture into the card's inner column.
 *
 * With real pixel dimensions the aspect ratio is honoured (corrected for the
 * 2:1 cell); without them the box falls back to a fixed, clearly-arbitrary
 * placeholder height — a layout choice, never rendered as a dimension.
 */
export function imageCellBox(
  innerWidth: number,
  image: ChatImageAttachment,
  maxRows = MAX_IMAGE_ROWS,
): ImageCellBox {
  const inner = Math.max(1, Math.floor(innerWidth));
  const rowCeiling = Math.max(1, Math.floor(maxRows));
  const w = image.pixelWidth;
  const h = image.pixelHeight;
  const known =
    typeof w === "number" && typeof h === "number" &&
    Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
  if (!known) {
    return { cols: inner, rows: Math.min(rowCeiling, 8) };
  }
  const ratio = (h as number) / (w as number);
  let cols = inner;
  let rows = Math.max(1, Math.round((cols * ratio) / CELL_ASPECT));
  if (rows > rowCeiling) {
    rows = rowCeiling;
    cols = Math.max(1, Math.min(inner, Math.round((rows * CELL_ASPECT) / ratio)));
  }
  return { cols, rows };
}
