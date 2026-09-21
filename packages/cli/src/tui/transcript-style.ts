/**
 * Transcript visual styles for the chat surface — pure style resolution and
 * layout.
 *
 * The operator already has `composerStyle: "border" | "rail" | "plain"`, which
 * changes the whole character of the composer, and asked for the same richness
 * in the transcript instead of the single `density` knob. This module is the
 * answer: it turns three orthogonal choices —
 *
 *   - `transcriptStyle`  — how a *speaking turn* is framed
 *   - `roleLabelStyle`   — how the "who said this" label is drawn
 *   - `toolCardStyle`    — how a tool/subagent call is drawn
 *
 * — into concrete, integer cell budgets that `chat-screen.tsx` renders without
 * doing a single subtraction of its own.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE ARITHMETIC LIVES HERE, NOT IN THE COMPONENT
 * ─────────────────────────────────────────────────────────────────────────────
 * OpenTUI lays rows out with Yoga, which shrinks siblings rather than clipping
 * them: two auto-width `<text>` nodes that want more cells than the row has are
 * squeezed and paint over one another (`Showpavailableenslash commands`). And
 * `width="100%"` does NOT make a box unshrinkable — `@opentui/core` sets
 * `flexShrink = (hasExplicitNumericWidth || hasExplicitNumericHeight) ? 0 : 1`,
 * and a percentage string is not a number, so a bordered box under column
 * pressure collapses and paints its own border through its content (the
 * bordered Messenger style has exactly that shape). The cure is to compute
 * every width as a pure function swept by a
 * test — "a row never claims more cells than its container" becomes a unit
 * test instead of a code review. `PRIMITIVES.md` is the long version.
 *
 * Everything here is total and pure: no React, no opentui, no clock, no env
 * except what a caller hands in. Every returned width is a non-negative
 * integer, and every row's claimed cells provably fit the width it was given —
 * `transcript-style.test.ts` sweeps that across widths 0..200, every style and
 * every entry kind.
 */

import { sanitizeTuiText } from "./text.js";

// ---------------------------------------------------------------------------
// The three knobs
// ---------------------------------------------------------------------------

/**
 * How a speaking turn (user / assistant / error / reasoning / notice) is
 * framed. These are genuinely different shapes, not tints:
 *
 *  - `minimal`  — the OpenCode / oh-my-pi flat look and the default: NO bubble
 *                 or box anywhere. The operator's turn is marked only by a thin
 *                 coloured accent rail down its left; the answer flows as plain
 *                 body text flush against the pane. Minimal chrome, maximal read.
 *  - `bubble` — right-aligned operator messages and left-aligned answers.
 *  - `balanced` — a half-and-half of `bubble` and `plain`: ONLY the operator's
 *                 own turns are drawn as a bordered bubble (identical geometry
 *                 to `bubble`'s user framing); every other voice — the answer,
 *                 tools, reasoning, notices, errors — is flat, full-width plain.
 *  - `rail`     — a 1-cell coloured rail down the left of each turn.
 *  - `plain`    — no rails, no borders; the role is a short coloured prefix
 *                 and the content gets every remaining cell. Densest reading.
 *  - `compact`  — one row per turn wherever the content allows; the label is
 *                 inlined rather than given its own row.
 *  - `document` — generous whitespace and full-width markdown so a long
 *                 analysis reads like a document rather than a chat log.
 */
export const TRANSCRIPT_STYLES = ["minimal", "bubble", "balanced", "rail", "plain", "compact", "document"] as const;
export type TranscriptStyle = (typeof TRANSCRIPT_STYLES)[number];

/**
 * How the "who is speaking" label is drawn, independent of the frame:
 *  - `full`  — `▌ operator` / `▌ 0` (today's label; the default)
 *  - `short` — `op` / `0`
 *  - `glyph` — `▌` only
 *  - `off`   — no label row at all
 */
export const ROLE_LABEL_STYLES = ["full", "short", "glyph", "off"] as const;
export type RoleLabelStyle = (typeof ROLE_LABEL_STYLES)[number];

/**
 * How a tool / subagent call is drawn, independent of the frame:
 *  - `rail`    — today's toned rail + `evidence / tool · state · name` header
 *                and a detail line (the default).
 *  - `inline`  — no rail; a single header line plus its detail, flush left.
 *  - `compact` — one line only (`icon name · state`); detail shown only on
 *                failure, because a failure with no detail is not actionable.
 *  - `hidden`  — successful and running calls are omitted entirely, but a
 *                FAILURE is never hidden — it always renders (as `compact`).
 */
export const TOOL_CARD_STYLES = ["rail", "inline", "compact", "hidden"] as const;
export type ToolCardStyle = (typeof TOOL_CARD_STYLES)[number];

export const DEFAULT_TRANSCRIPT_STYLE: TranscriptStyle = "minimal";
export const DEFAULT_ROLE_LABEL_STYLE: RoleLabelStyle = "full";
export const DEFAULT_TOOL_CARD_STYLE: ToolCardStyle = "rail";

// ---------------------------------------------------------------------------
// Transcript detail (collapse planning)
// ---------------------------------------------------------------------------

/**
 * "collapsed" folds each turn's successful tool calls and reasoning into a
 * single one-line summary so the transcript reads as operator input + the
 * model's answer, rather than a wall of tool output. "expanded" shows every
 * entry in full. Modelled on OpenCode's collapsible ToolPart/ReasoningPart,
 * which are hidden-when-successful outside detail mode.
 */
export const TRANSCRIPT_DETAILS = ["collapsed", "expanded"] as const;
export type TranscriptDetail = (typeof TRANSCRIPT_DETAILS)[number];
export const DEFAULT_TRANSCRIPT_DETAIL: TranscriptDetail = "collapsed";

/**
 * The subset of a transcript entry the collapse planner reasons about. Kept
 * structural (not the full `ChatEntry`) so the planning is a pure, unit-tested
 * function independent of the render layer.
 */
export interface CollapseEntryLike {
  kind: "user" | "assistant" | "reasoning" | "tool" | "subagent" | "notice" | "panel" | "error" | "peer";
  /** Tool result success, when known. `false` marks a failed tool. */
  success?: boolean;
  /** Subagent outcome, when this is a subagent entry. */
  subagentOutcome?: "completed" | "failed";
  /** The turn this entry belongs to; a fold never spans two turns. */
  turn: number;
  /** Tool/entry name, used to caption the fold summary. */
  text?: string;
}

/**
 * Whether an entry's detail may be folded in collapsed mode.
 *
 * Failures are the hard exception the operator relies on: a failed tool, a
 * failed subagent and an error entry always render in full, so a problem is
 * never hidden behind a summary. Reasoning always folds (it is working-out, not
 * a conclusion); a successful or still-running tool/subagent folds too.
 */
export function isCollapsibleEntry(entry: CollapseEntryLike): boolean {
  switch (entry.kind) {
    case "tool":
      return entry.success !== false;
    case "subagent":
      return entry.subagentOutcome !== "failed";
    case "reasoning":
      return true;
    default:
      return false;
  }
}

/** One caption token for an entry in a fold summary. */
function foldToken(entry: CollapseEntryLike): string {
  if (entry.kind === "reasoning") return "thinking";
  if (entry.kind === "subagent") return "subagent";
  const name = entry.text?.trim();
  return name && name.length > 0 ? name : entry.kind;
}

/**
 * A one-line caption for a folded run: the single step's name when there is
 * one, otherwise a count plus the first few distinct names ("3 steps ·
 * run_command, read_file"). Pure; the caller owns the leading glyph and colour.
 */
export function foldSummary(
  entries: readonly CollapseEntryLike[],
  opts?: { dropReasoningLabel?: boolean },
): string {
  if (entries.length === 0) return "";
  const names: string[] = [];
  for (const entry of entries) {
    // When the turn has already shown its one "thinking" label, a later fold in
    // the same turn omits the reasoning token so the label is not repeated. The
    // step still counts toward "N steps"; only the caption word is dropped.
    if (opts?.dropReasoningLabel && entry.kind === "reasoning") continue;
    const token = foldToken(entry);
    if (!names.includes(token)) names.push(token);
  }
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` +${names.length - 3}` : "";
  if (entries.length === 1) return shown; // may be "" for a lone suppressed reasoning fold
  return names.length === 0
    ? `${entries.length} steps` // pure-reasoning fold, label already shown
    : `${entries.length} steps · ${shown}${more}`;
}

/** A planned transcript row: a normal entry, or a folded run of collapsibles. */
export type TranscriptPlanItem<E> =
  | { type: "entry"; entry: E }
  | { type: "fold"; turn: number; entries: E[]; summary: string };

/**
 * Turn a flat entry list into an ordered render plan.
 *
 * In "expanded" every entry renders as itself. In "collapsed" each maximal run
 * of consecutive collapsible entries WITHIN one turn becomes a single `fold`
 * item; anything non-collapsible (operator input, the answer, and every
 * failure) breaks the run and renders in full. A turn present in
 * `expandedTurns` is treated as expanded, so a future per-turn toggle drops in
 * without touching the planner.
 */
export function planTranscript<E extends CollapseEntryLike>(
  entries: readonly E[],
  detail: TranscriptDetail,
  expandedTurns?: ReadonlySet<number>,
): TranscriptPlanItem<E>[] {
  if (detail === "expanded") {
    return entries.map((entry) => ({ type: "entry", entry }));
  }
  const out: TranscriptPlanItem<E>[] = [];
  let run: E[] = [];
  let runTurn = Number.NaN;
  const flush = (): void => {
    if (run.length === 0) return;
    // Even a lone collapsible folds: a single reasoning block still reduces to
    // "thinking", and a single successful tool to its name, so collapsed mode
    // is uniformly one line per fold. Expanding the turn restores full detail.
    out.push({ type: "fold", turn: runTurn, entries: run, summary: foldSummary(run) });
    run = [];
  };
  for (const entry of entries) {
    const foldable = isCollapsibleEntry(entry) && !expandedTurns?.has(entry.turn);
    if (!foldable) {
      flush();
      out.push({ type: "entry", entry });
      continue;
    }
    if (run.length > 0 && entry.turn !== runTurn) flush();
    runTurn = entry.turn;
    run.push(entry);
  }
  flush();
  return out;
}

/** The kinds framed as speech (everything that is not a tool/subagent/panel). */
export type SpeechKind = "user" | "assistant" | "error" | "reasoning" | "notice";

// ---------------------------------------------------------------------------
// Settings resolution (tolerant + env override)
// ---------------------------------------------------------------------------

export interface TranscriptStyleSettings {
  transcriptStyle: TranscriptStyle;
  roleLabelStyle: RoleLabelStyle;
  toolCardStyle: ToolCardStyle;
}

/** Environment override keys, so a style can be pinned for a preview or a capture. */
export const TRANSCRIPT_STYLE_ENV = "OSEC_TRANSCRIPT_STYLE";
export const ROLE_LABEL_STYLE_ENV = "OSEC_ROLE_LABEL_STYLE";
export const TOOL_CARD_STYLE_ENV = "OSEC_TOOL_CARD_STYLE";

function pick<T extends string>(
  value: unknown,
  choices: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (choices as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function rawKey(raw: unknown, key: string): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return (raw as Record<string, unknown>)[key];
}

/**
 * Resolve the three style knobs from the settings object, tolerating an object
 * that does not yet carry these keys (the settings table is owned elsewhere and
 * may add them independently) and letting an environment variable override any
 * of them. `env` is passed in so this function stays pure and testable — it
 * never reads `process.env` itself.
 *
 * Precedence: env override → settings value → default.
 */
export function resolveTranscriptStyleSettings(
  settings: unknown,
  env: Record<string, string | undefined> = {},
): TranscriptStyleSettings {
  return {
    transcriptStyle: pick(
      env[TRANSCRIPT_STYLE_ENV] ?? rawKey(settings, "transcriptStyle"),
      TRANSCRIPT_STYLES,
      DEFAULT_TRANSCRIPT_STYLE,
    ),
    roleLabelStyle: pick(
      env[ROLE_LABEL_STYLE_ENV] ?? rawKey(settings, "roleLabelStyle"),
      ROLE_LABEL_STYLES,
      DEFAULT_ROLE_LABEL_STYLE,
    ),
    toolCardStyle: pick(
      env[TOOL_CARD_STYLE_ENV] ?? rawKey(settings, "toolCardStyle"),
      TOOL_CARD_STYLES,
      DEFAULT_TOOL_CARD_STYLE,
    ),
  };
}

// ---------------------------------------------------------------------------
// Small width primitives (integers only, never negative)
// ---------------------------------------------------------------------------

/** A width can never be negative, fractional, NaN or Infinite. */
function clampWidth(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const floored = Math.floor(n);
  return floored > 0 ? floored : 0;
}

// ---------------------------------------------------------------------------
// Role labels
// ---------------------------------------------------------------------------

/**
 * The text of a role label, before fitting, or `null` when the style suppresses
 * it. `age` is a pre-formatted relative age ("12s"); an empty string omits the
 * separator entirely rather than leaving a dangling ` · `.
 *
 * `full` and `short` show You / 0 with the optional age; `glyph` keeps the
 * bare name and `off` suppresses it. Placement belongs to the renderer: bubble
 * cards use a top-border title rather than a separate heading row.
 */
export function roleLabelText(
  kind: "user" | "assistant",
  style: RoleLabelStyle,
  age = "",
): string | null {
  if (style === "off") return null;
  const name = kind === "user" ? "You" : "0";
  const suffix = age ? ` · ${age}` : "";
  if (style === "glyph") return name;
  if (style === "short") return `${name}${suffix}`;
  return `${name}${suffix}`;
}

/**
 * The documented cell width of a role label at a given style, for the label's
 * own row. `null` label (style `off`) is 0. This is `String.length`, matching
 * the rest of the module's measurement (see the CJK note in PRIMITIVES.md).
 */
export function roleLabelWidth(
  kind: "user" | "assistant",
  style: RoleLabelStyle,
  age = "",
): number {
  const text = roleLabelText(kind, style, age);
  return text === null ? 0 : text.length;
}

// ---------------------------------------------------------------------------
// Speech framing
// ---------------------------------------------------------------------------

export type RailKind = "solid" | "dotted" | "marker" | "none";

export interface SpeechFrame {
  /** The turn sits in its own bordered box (needs an explicit width + flexShrink=0). */
  bordered: boolean;
  /** Kind of left rail: a solid coloured cell, a dotted gutter, a single marker, or none. */
  railKind: RailKind;
  /** Cells the rail/marker itself occupies (0 or 1). */
  railWidth: number;
  /** Cells between the rail and the content (a real gap, never a padded literal). */
  contentGap: number;
  /** Extra rows of top margin the style adds, on top of the density spacing. */
  extraMarginTop: number;
  /** Whether the role label gets its own row above the content (false = inline). */
  labelOwnRow: boolean;
  /** Usable width for the turn's content (wrapped text / body). */
  contentWidth: number;
  /** Width to hand `renderMarkdown` for this turn. */
  markdownWidth: number;
}

/** Markdown is never rendered below this width; matches the current `Math.max(8, …)`. */
const MIN_MARKDOWN_WIDTH = 8;
/** A bordered box spends this many cells on chrome: two borders + one pad each side. */
const BORDER_CHROME = 4;

/**
 * Geometry for a speaking turn under a given style.
 *
 * `rail` reproduces today's numbers exactly for every width at which today's
 * code did not already overflow: a 1-cell rail, a 1-cell gap, content taking
 * the rest, and markdown at `max(8, width - 2)`.
 */
export function speechFrame(
  style: TranscriptStyle,
  kind: SpeechKind,
  maxWidth: number,
): SpeechFrame {
  const width = clampWidth(maxWidth);

  // reasoning is always the quiet voice: a dotted gutter, never a border,
  // regardless of the surrounding style. It reads as working-out, not answer.
  const isReasoning = kind === "reasoning";
  const isNotice = kind === "notice";

  // A bordered block needs at least one inner cell; on a pane too narrow to
  // hold the border chrome it degrades to the plain framing rather than paint
  // a border with nothing inside it.
  if (style === "bubble" && !isReasoning && !isNotice && width - BORDER_CHROME >= 1) {
    // Inner content is width - (2 borders + 2 padding).
    const inner = clampWidth(width - BORDER_CHROME);
    return {
      bordered: true,
      railKind: "none",
      railWidth: 0,
      contentGap: 0,
      extraMarginTop: 0,
      labelOwnRow: true,
      contentWidth: inner,
      markdownWidth: Math.max(MIN_MARKDOWN_WIDTH, inner),
    };
  }

  // balanced: ONLY the operator's own turn is a bordered bubble (byte-identical
  // to the `bubble` branch's bubble geometry); every other voice — the answer,
  // errors, and the quiet reasoning/notice voices — is flat, full-width plain
  // (byte-identical to the `plain` branch). A user turn on a pane too narrow to
  // hold the border chrome degrades to the same flat framing.
  if (style === "balanced" && kind === "user" && !isReasoning && !isNotice && width - BORDER_CHROME >= 1) {
    // Inner content is width - (2 borders + 2 padding).
    const inner = clampWidth(width - BORDER_CHROME);
    return {
      bordered: true,
      railKind: "none",
      railWidth: 0,
      contentGap: 0,
      extraMarginTop: 0,
      labelOwnRow: true,
      contentWidth: inner,
      markdownWidth: Math.max(MIN_MARKDOWN_WIDTH, inner),
    };
  }

  if (style === "balanced") {
    // Everything that is not the operator's bubble is flat and full-width,
    // exactly like the `plain` branch.
    const content = width;
    return {
      bordered: false,
      railKind: "none",
      railWidth: 0,
      contentGap: 0,
      extraMarginTop: 0,
      labelOwnRow: true,
      contentWidth: content,
      markdownWidth: Math.max(MIN_MARKDOWN_WIDTH, content),
    };
  }

  if (style === "minimal" && !isReasoning && !isNotice) {
    // OpenCode / oh-my-pi flat look: NO bordered bubble or box. The operator's
    // turn carries a 1-cell coloured accent rail (a subtle left gutter) plus a
    // 1-cell gap so it reads as "yours"; the assistant answer — and an error —
    // is flush and full-width, plain body text. `railKind: "solid"` on the user
    // turn is what both the chat surface and the settings preview draw the bar
    // from, so the two never disagree.
    const isUser = kind === "user";
    const railWidth = isUser && width >= 2 ? 1 : 0;
    const contentGap = isUser && width >= 2 ? 1 : 0;
    const content = clampWidth(width - railWidth - contentGap);
    return {
      bordered: false,
      railKind: isUser ? "solid" : "none",
      railWidth,
      contentGap,
      extraMarginTop: 0,
      labelOwnRow: true,
      contentWidth: content,
      markdownWidth: Math.max(MIN_MARKDOWN_WIDTH, content),
    };
  }

  if (style === "plain" || style === "compact") {
    // No rail, no border: the content gets every cell. `compact` inlines the
    // label onto the first row; `plain` keeps it on its own (thin) row.
    const content = width;
    return {
      bordered: false,
      railKind: "none",
      railWidth: 0,
      contentGap: 0,
      extraMarginTop: 0,
      labelOwnRow: style === "plain",
      contentWidth: content,
      markdownWidth: Math.max(MIN_MARKDOWN_WIDTH, content),
    };
  }

  if (style === "document" && !isReasoning && !isNotice) {
    // Generous: no rail, full-width markdown so headings breathe, and an extra
    // blank row above each turn so a long analysis is not wall-to-wall text.
    return {
      bordered: false,
      railKind: "none",
      railWidth: 0,
      contentGap: 0,
      extraMarginTop: 1,
      labelOwnRow: true,
      contentWidth: width,
      markdownWidth: Math.max(MIN_MARKDOWN_WIDTH, width),
    };
  }

  // rail (default) — and the reasoning/notice fallbacks for every style, which
  // deliberately keep the rail treatment so the quiet voices look identical
  // everywhere.
  //
  // User and assistant speech turns NO LONGER carry a left spine ("inside
  // author rail") — the role label is positioned externally (0 upper-left,
  // You upper-right) so the content area is flush against the pane edge,
  // matching OpenCode's clean transcript. Reasoning and notice keep their
  // quiet rails (dotted and marker respectively) since they are not "authors".
  const hasRail = isReasoning || isNotice;
  const railWidth = hasRail && width >= 1 ? 1 : 0;
  const contentGap = hasRail && width >= 2 ? 1 : 0;
  const content = clampWidth(width - railWidth - contentGap);
  const railKind: RailKind = isReasoning ? "dotted" : isNotice ? "marker" : "none";
  return {
    bordered: false,
    railKind,
    railWidth,
    contentGap,
    extraMarginTop: 0,
    labelOwnRow: true,
    contentWidth: content,
    markdownWidth: Math.max(MIN_MARKDOWN_WIDTH, width - 2),
  };
}

// ---------------------------------------------------------------------------
// Tool / subagent cards
// ---------------------------------------------------------------------------

export type ToolKind = "tool" | "subagent";

export interface ToolFrame {
  /** Whether the card renders at all (hidden style drops successes). */
  render: boolean;
  /** Left rail treatment. */
  railKind: RailKind;
  railWidth: number;
  /** Cells before the rail (the `rail` style indents tools when the pane is wide). */
  outerMarginLeft: number;
  /** Gap between rail and content. */
  contentGap: number;
  /** Usable content width. */
  contentWidth: number;
  /** Whether the detail/output line(s) render. */
  showDetail: boolean;
  /** Whether the header collapses state and name onto the single icon row. */
  singleLine: boolean;
}

/** Below this pane width the `rail` tool card is not indented (matches today). */
const TOOL_INDENT_MIN_WIDTH = 56;
/** Indent applied to a `rail` tool card on a wide pane (matches today). */
const TOOL_INDENT = 2;

/**
 * Geometry for a tool/subagent card.
 *
 * `success` drives the `hidden` style: a failure always renders (as a compact
 * one-liner), a success or a still-running call is dropped. Everything else is
 * width arithmetic. `rail` reproduces today's numbers: a wide pane indents the
 * card by 2, a 1-cell rail and a 1-cell gap follow, content takes the rest.
 */
export function toolFrame(
  style: ToolCardStyle,
  maxWidth: number,
  success: boolean | undefined,
): ToolFrame {
  const width = clampWidth(maxWidth);
  const failed = success === false;

  if (style === "hidden") {
    // Never hide an error. A hidden failure renders as the compact one-liner.
    if (!failed) {
      return {
        render: false,
        railKind: "none",
        railWidth: 0,
        outerMarginLeft: 0,
        contentGap: 0,
        contentWidth: 0,
        showDetail: false,
        singleLine: true,
      };
    }
    return {
      render: true,
      railKind: "none",
      railWidth: 0,
      outerMarginLeft: 0,
      contentGap: 0,
      contentWidth: width,
      showDetail: true,
      singleLine: true,
    };
  }

  if (style === "compact") {
    // One line; detail only when it failed (a failure needs its reason).
    return {
      render: true,
      railKind: "none",
      railWidth: 0,
      outerMarginLeft: 0,
      contentGap: 0,
      contentWidth: width,
      showDetail: failed,
      singleLine: true,
    };
  }

  if (style === "inline") {
    // No rail, flush left, full detail.
    return {
      render: true,
      railKind: "none",
      railWidth: 0,
      outerMarginLeft: 0,
      contentGap: 0,
      contentWidth: width,
      showDetail: true,
      singleLine: false,
    };
  }

  // rail (default) — byte-identical to today for every width >= 2; below that
  // the rail and gap collapse rather than overrun the pane.
  const outerMarginLeft = width < TOOL_INDENT_MIN_WIDTH ? 0 : TOOL_INDENT;
  const afterMargin = clampWidth(width - outerMarginLeft);
  const railWidth = afterMargin >= 1 ? 1 : 0;
  const contentGap = afterMargin >= 2 ? 1 : 0;
  const contentWidth = clampWidth(width - outerMarginLeft - railWidth - contentGap);
  return {
    render: true,
    railKind: "solid",
    railWidth,
    outerMarginLeft,
    contentGap,
    contentWidth,
    showDetail: true,
    singleLine: false,
  };
}

// ---------------------------------------------------------------------------
// The tool header row: icon + prefix + name (three siblings on one row)
// ---------------------------------------------------------------------------

export interface ToolHeaderColumns {
  /** The icon cell (always 1). */
  iconWidth: number;
  /** Cells for the muted prefix (`evidence / tool · state · `). */
  prefixWidth: number;
  /** Cells for the tool name, budgeted so the row never overruns the content. */
  nameWidth: number;
}

/**
 * The `evidence / tool …` detail width — `max(20, width - 8)` historically,
 * but clamped to what the content column can actually pay for so a tiny pane
 * cannot make the header overrun (the fix that lets the rail style pass the
 * sweep it previously would have failed below width 28).
 */
export function toolDetailWidth(contentWidth: number, maxWidth: number): number {
  const width = clampWidth(maxWidth);
  const content = clampWidth(contentWidth);
  return Math.min(Math.max(20, width - 8), content);
}

/**
 * Allocate the three siblings of the `rail`/`inline` tool header so their cells
 * (icon + prefix + name) never exceed the content width. The icon is one cell,
 * the prefix keeps its natural length while it fits, and the name takes what is
 * left — which reproduces today's `Math.max(1, detailWidth - prefix.length - 1)`
 * whenever today's code did not already overflow.
 */
export function toolHeaderColumns(
  contentWidth: number,
  prefixLength: number,
  detailWidth: number,
): ToolHeaderColumns {
  const content = clampWidth(contentWidth);
  const prefixLen = clampWidth(prefixLength);
  const detail = clampWidth(detailWidth);
  const iconWidth = content >= 1 ? 1 : 0;
  // The prefix may not push past the content width once the icon is paid for.
  const prefixWidth = Math.min(prefixLen, clampWidth(content - iconWidth));
  // Historical name budget: detailWidth - prefix - icon, floored at 1, then
  // clamped to whatever cells actually remain in the content column.
  const remaining = clampWidth(content - iconWidth - prefixWidth);
  const historical = Math.max(1, detail - prefixLen - 1);
  const nameWidth = Math.min(historical, remaining);
  return { iconWidth, prefixWidth, nameWidth };
}

/** The muted prefix for a tool header, e.g. ` evidence / tool · complete · `. */
export function toolHeaderPrefix(state: string): string {
  return ` evidence / tool · ${state} · `;
}

/** Icon and state word for a tool card, from its success flag. */
export function toolGlyphState(success: boolean | undefined): { icon: string; state: string } {
  if (success === false) return { icon: "×", state: "failed" };
  if (success) return { icon: "✓", state: "complete" };
  return { icon: "◌", state: "running" };
}

/**
 * A compact one-line tool summary: `icon name · state`, fitted to width.
 * Used by the `compact` and `hidden` tool styles. The separator is inside the
 * string here because this is a single text node (no sibling to fuse with), so
 * `sanitizeTuiText`'s trimming cannot split a label from its value.
 */
export function toolCompactLine(
  icon: string,
  name: string,
  state: string,
  width: number,
  duration?: string,
): string {
  const w = clampWidth(width);
  if (w <= 0) return "";
  const cleanName = sanitizeTuiText(name);
  const cleanState = sanitizeTuiText(state);
  // The execution time rides the end of the one-liner too, for parity with the
  // card's top-of-border duration. It is the FIRST thing dropped under width
  // pressure (before the state, then the name), so the identity always survives.
  // Omitting `duration` reproduces the historical `icon name · state` exactly.
  const cleanDur = duration ? sanitizeTuiText(duration) : "";
  const durPart = cleanDur ? ` · (${cleanDur})` : "";
  const full = `${icon} ${cleanName} · ${cleanState}${durPart}`;
  if (full.length <= w) return full;
  const withoutDur = `${icon} ${cleanName} · ${cleanState}`;
  if (withoutDur.length <= w) return withoutDur;
  // Drop the state first, then truncate the name, so the identity survives.
  const withoutState = `${icon} ${cleanName}`;
  if (withoutState.length <= w) return withoutState;
  const prefix = `${icon} `;
  if (prefix.length >= w) return `${icon} `.slice(0, w);
  const nameRoom = w - prefix.length;
  const trimmed = cleanName.length > nameRoom
    ? `${cleanName.slice(0, Math.max(1, nameRoom - 1))}…`
    : cleanName;
  return `${prefix}${trimmed}`.slice(0, w);
}

// ---------------------------------------------------------------------------
// Rich command / edit cards (OMP-style bordered tool cards)
// ---------------------------------------------------------------------------

/**
 * Geometry for a bordered rich tool card (command or edit). Mirrors the
 * Messenger speech-frame discipline: the card is a bordered box that spends
 * {@link BORDER_CHROME} cells on chrome (two borders + one pad each side), so
 * its INNER width is `maxWidth - 4`, floored at 0. Below the chrome cost the
 * card cannot render and degrades to the caller's fallback (the plain line).
 *
 * `outerWidth` is the explicit width the bordered box MUST be given (with
 * `flexShrink={0}`), and `innerWidth` is the budget every child text must be
 * fitted to so the row never overruns the border.
 */
export interface CardFrame {
  /** Whether the card can render at this width (false → caller falls back). */
  render: boolean;
  /** Explicit outer width for the bordered box (needs flexShrink=0). */
  outerWidth: number;
  /** Usable inner width for every child (outer - border - padding). */
  innerWidth: number;
}

/** Minimum inner width below which a card is not worth drawing (degrades to a line). */
const MIN_CARD_INNER = 8;

function cardFrame(maxWidth: number): CardFrame {
  const width = clampWidth(maxWidth);
  const inner = clampWidth(width - BORDER_CHROME);
  if (inner < MIN_CARD_INNER) {
    return { render: false, outerWidth: 0, innerWidth: 0 };
  }
  return { render: true, outerWidth: width, innerWidth: inner };
}

/** Geometry for a command card (`$ cmd` / output / footer). */
export function commandCardFrame(maxWidth: number): CardFrame {
  return cardFrame(maxWidth);
}

/** Geometry for an edit card (`✎ Edit: path` / diff). */
export function editCardFrame(maxWidth: number): CardFrame {
  return cardFrame(maxWidth);
}

/** Geometry for a web-search card (`⌕ Web Search` / query / answer / sources). */
export function webCardFrame(maxWidth: number): CardFrame {
  return cardFrame(maxWidth);
}

/**
 * The display host for a source url — `example.com` from
 * `https://example.com/a/b?q=1`, with a leading `www.` dropped. Pure and
 * total: an unparseable url falls back to the raw string (trimmed of scheme)
 * so a malformed result still shows *something* rather than nothing.
 */
export function webSourceHost(url: string): string {
  const raw = (url ?? "").trim();
  if (raw.length === 0) return "";
  try {
    const host = new URL(raw).host;
    return host.replace(/^www\./, "");
  } catch {
    // Not an absolute url: strip any scheme and take the first path segment.
    return raw.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0] ?? raw;
  }
}

/**
 * The footer line for a command card: `(Wall Xs | Timeout Ys | Exit: N)`.
 * Segments are omitted when their datum is unknown so a restored card (which
 * carries only the exit code) still renders a clean footer. Pure; fitted by
 * the caller to the card inner width.
 */
export function commandCardFooter(opts: {
  wallMs?: number;
  timeoutMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
}): string {
  const parts: string[] = [];
  if (typeof opts.wallMs === "number" && Number.isFinite(opts.wallMs)) {
    parts.push(`Wall ${(Math.max(0, opts.wallMs) / 1000).toFixed(2)}s`);
  }
  if (typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)) {
    parts.push(`Timeout ${Math.round(opts.timeoutMs / 1000)}s`);
  }
  if (opts.timedOut) {
    parts.push("TIMED OUT");
  } else if (typeof opts.exitCode === "number") {
    parts.push(`Exit: ${opts.exitCode}`);
  }
  return parts.length > 0 ? `(${parts.join(" | ")})` : "";
}

/**
 * Split a body into at most `maxLines` display lines with a middle-out fold:
 * the head and tail survive and the elided middle collapses to a single
 * `… N more lines` marker, matching the transcript's existing fold idiom. Pure.
 */
export function foldBodyLines(body: string, maxLines: number): string[] {
  const lines = body.replace(/\n+$/, "").split("\n");
  if (maxLines <= 0) return [];
  if (lines.length <= maxLines) return lines;
  // Reserve one line for the fold marker; split the rest head/tail.
  const budget = Math.max(1, maxLines - 1);
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  const hidden = lines.length - head - tail;
  const out = lines.slice(0, head);
  out.push(`… ${hidden} more line${hidden === 1 ? "" : "s"}`);
  if (tail > 0) out.push(...lines.slice(lines.length - tail));
  return out;
}

// ---------------------------------------------------------------------------
// Rounded bordered cards (OMP-style: ╭──╮ top with inset title)
// ---------------------------------------------------------------------------

/** Rounded box-drawing characters for the card border. */
export const ROUND_CORNER_TL = "╭";
export const ROUND_CORNER_TR = "╮";
export const ROUND_CORNER_BL = "╰";
export const ROUND_CORNER_BR = "╯";
/** The horizontal line character used in rounded borders. */
export const ROUND_HORIZ = "─";
/** The vertical bar character for rounded card sides. */
export const ROUND_VERT = "│";

/**
 * Geometry for a rounded bordered card with an inset title in the top border.
 * Shares the same chrome budget as `CardFrame` (4 cells) but the top row has
 * a 3-cell ─── cap prefix before the label text, so the label sits inset.
 */
export interface RoundedCardFrame {
  /** Whether the card can render at this width (false → falls back to plain line). */
  render: boolean;
  /** Explicit outer width for the bordered box (needs flexShrink=0). */
  outerWidth: number;
  /** Usable inner width for content lines (between ││ bars and padding). */
  innerWidth: number;
}

/**
 * Geometry for a rounded card. Below the chrome cost the card cannot render
 * and degrades to the caller's fallback.
 *
 * The top row layout is: `╭─── label fill───╮` where `╭` (1) + `───` (3) +
 * label + fill + `╮` (1) = outerWidth. The caller provides the label text;
 * this function only reports the geometry.
 */
export function roundedCardFrame(maxWidth: number): RoundedCardFrame {
  const width = clampWidth(maxWidth);
  // Same chrome as cardFrame: 2 border cells + 2 padding cells.
  const inner = clampWidth(width - BORDER_CHROME);
  if (inner < MIN_CARD_INNER) {
    return { render: false, outerWidth: 0, innerWidth: 0 };
  }
  return { render: true, outerWidth: width, innerWidth: inner };
}

/**
 * Build the top border line of a rounded card with an inset label.
 * Returns a single string: `╭─── label ─────────────────╮`.
 * The label is fitted to fit within available space; when it overflows, the
 * label is ellipsised.
 */
export function roundedCardTopBorder(
  label: string,
  outerWidth: number,
): string {
  const w = clampWidth(outerWidth);
  // ╭(1) + ───(3) + label + fill + ╮(1) = w
  const leftCap = `${ROUND_CORNER_TL}${ROUND_HORIZ.repeat(3)}`;
  const rightCap = ROUND_CORNER_TR;
  const leftLen = leftCap.length; // 4
  const rightLen = rightCap.length; // 1
  const maxLabel = w - leftLen - rightLen;
  if (maxLabel <= 0) return `${ROUND_CORNER_TL}${ROUND_HORIZ.repeat(Math.max(0, w - 2))}${ROUND_CORNER_TR}`;
  const cleanLabel = sanitizeTuiText(label);
  const trimmedLabel = cleanLabel.length > maxLabel
    ? `${cleanLabel.slice(0, Math.max(1, maxLabel - 1))}…`
    : cleanLabel;
  const fill = Math.max(0, w - leftLen - trimmedLabel.length - rightLen);
  return `${leftCap}${trimmedLabel}${ROUND_HORIZ.repeat(fill)}${rightCap}`;
}

/**
 * Build the bottom border line of a rounded card.
 * Returns: `╰──────────────────────╯`
 */
export function roundedCardBottomBorder(outerWidth: number): string {
  const w = clampWidth(outerWidth);
  const inner = Math.max(0, w - 2);
  return `${ROUND_CORNER_BL}${ROUND_HORIZ.repeat(inner)}${ROUND_CORNER_BR}`;
}
