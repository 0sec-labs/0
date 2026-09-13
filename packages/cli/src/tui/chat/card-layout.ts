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
  fetch: { verb: "Fetch", glyph: "⚓" },
  http_request: { verb: "HTTP", glyph: "⚓" },
  save_finding: { verb: "Finding", glyph: "⚑" },
  analyze_binary: { verb: "Analyze", glyph: "⚙" },
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
    return args ? `${identity.verb} ${args}` : identity.verb;
  }
  if (name && args) return `${name} · ${args}`;
  return name || args;
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
 * input at all (a restored transcript often has not). The diff on an edit card
 * is deliberately NOT treated as input — it is the result of the edit and
 * belongs in the output region.
 */
export function toolInputSection(entry: ChatEntry, maxLines = 12): ToolInputSection | null {
  const cap = Math.max(1, Math.floor(maxLines));
  const split = (text: string): string[] =>
    text.replace(/\s+$/, "").split("\n").slice(0, cap).map((line) => sanitizeTuiText(line));

  if (entry.metaKind === "command") {
    const command = (entry.command ?? "").trim();
    if (!command) return null;
    return { label: "Command", language: "bash", lines: split(command) };
  }
  if (entry.metaKind === "web") {
    const query = (entry.webQuery ?? "").trim();
    if (!query) return null;
    return { label: "Query", lines: split(query) };
  }
  if (entry.metaKind === "edit") {
    const path = (entry.editPath ?? "").trim();
    if (!path) return null;
    return { label: "Path", lines: split(path) };
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

/** A single structured status row. `tone` selects the theme colour, not text. */
export interface ToolStatusRow {
  label: string;
  value: string;
  tone: "state" | "error" | "muted";
}

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
 * The structured Status block. The state row is always present (it is always
 * known); every other row appears only when its field was recorded.
 */
export function toolStatusRows(
  entry: ChatEntry,
  state: ToolState,
  outputLines: number,
  outputTruncated: boolean,
): ToolStatusRow[] {
  const rows: ToolStatusRow[] = [];
  const { word } = toolStateLabel(state);
  rows.push({ label: "State", value: word, tone: state === "failed" ? "error" : "state" });

  if (entry.timedOut === true) {
    rows.push({ label: "Timeout", value: "killed at the wallclock ceiling", tone: "error" });
  }
  if (typeof entry.exitCode === "number") {
    rows.push({
      label: "Exit",
      value: String(entry.exitCode),
      tone: entry.exitCode === 0 ? "muted" : "error",
    });
  }
  // Duration is NOT a status row: it rides the top border headline (OMP-style,
  // ` · (<dur>)` after the title). See `formatDurationMs` — still exported and
  // used by `ToolCard`'s headline — and the headline construction in ToolCard.
  if (typeof entry.timeoutMs === "number" && Number.isFinite(entry.timeoutMs)) {
    rows.push({ label: "Ceiling", value: `${Math.round(entry.timeoutMs / 1000)}s`, tone: "muted" });
  }
  if (entry.metaKind === "edit" && (entry.editAdded !== undefined || entry.editRemoved !== undefined)) {
    const parts: string[] = [];
    if (entry.editAdded !== undefined) parts.push(`+${entry.editAdded}`);
    if (entry.editRemoved !== undefined) parts.push(`-${entry.editRemoved}`);
    rows.push({ label: "Changes", value: parts.join(" / "), tone: "muted" });
  }
  if (entry.metaKind === "web" && entry.webSources && entry.webSources.length > 0) {
    rows.push({
      label: "Sources",
      value: `${entry.webSources.length}`,
      tone: "muted",
    });
  }
  if (outputLines > 0) {
    rows.push({
      label: "Output",
      value: `${outputLines} line${outputLines === 1 ? "" : "s"}${outputTruncated ? " (capped)" : ""}`,
      tone: "muted",
    });
  }
  return rows;
}

/**
 * Column split for the status grid: a fixed label gutter sized to the widest
 * label present, and the remainder for values. Both are clamped so the two
 * columns plus the gap can never exceed the inner width.
 */
export function statusColumns(
  rows: readonly ToolStatusRow[],
  innerWidth: number,
): { labelWidth: number; gap: number; valueWidth: number } {
  const inner = Math.max(0, Math.floor(innerWidth));
  if (inner < 6 || rows.length === 0) return { labelWidth: 0, gap: 0, valueWidth: inner };
  const widest = rows.reduce((n, row) => Math.max(n, row.label.length), 0);
  const gap = 1;
  // Never let the gutter eat more than a third of the card.
  const labelWidth = Math.min(widest, Math.max(3, Math.floor(inner / 3)));
  const valueWidth = Math.max(1, inner - labelWidth - gap);
  return { labelWidth, gap, valueWidth };
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
