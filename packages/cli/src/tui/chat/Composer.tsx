/** @jsxImportSource @opentui/react */
import React from "react";
import stringWidth from "string-width";
import type { BorderSides } from "@opentui/core";
import type { Theme } from "../theme-context.js";
import type { TuiSettings } from "../settings.js";
import { fitLegend, fitTuiText, sanitizeComposerText } from "../text.js";

/** Horizontal rules frame input without turning it into another card. */
const RAIL_SIDES: BorderSides[] = ["top", "bottom"];

/**
 * A comfortable empty composer is a small card, not a single cramped line:
 * the rail frame reserves at least this many rows so the prompt has room to
 * breathe before anything is typed. The input still grows past it with content
 * and shrinks back to it when cleared.
 */
export const COMPOSER_MIN_ROWS = 3;

/**
 * The composer grows to at most this many visual rows; past it the oldest rows
 * scroll out of view so the input can never crowd out the transcript. Shared
 * by the input renderer and the rail-rule height so the two always agree.
 */
export const COMPOSER_MAX_ROWS = 8;


const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Paste chips ({@link ../chat/paste-store}) are literal text in the composer
 * buffer, but reading them as distinct helps: this matches a WHOLE chip marker
 * that falls within a single visual row. A marker split across a soft-wrap
 * boundary simply renders plain — correctness never depends on the colour.
 */
const COMPOSER_CHIP_RE = /\[Pasted text #\d+ · [^\]]*\]|\[Image #\d+\]/g;

/**
 * Split one visual row into spans, colouring any complete chip marker with
 * `chipColor` and leaving the rest as `textColor`. Returns a single plain span
 * when the row holds no marker, so the common case is untouched.
 */
function renderComposerRow(line: string, textColor: string, chipColor: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  COMPOSER_CHIP_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMPOSER_CHIP_RE.exec(line)) !== null) {
    if (match.index > last) parts.push(<span key={key++} fg={textColor}>{line.slice(last, match.index)}</span>);
    parts.push(<span key={key++} fg={chipColor}>{match[0]}</span>);
    last = match.index + match[0].length;
  }
  if (last < line.length) parts.push(<span key={key++} fg={textColor}>{line.slice(last)}</span>);
  return parts;
}

/**
 * Clamp ghost (autosuggestion) text to at most `cells` display columns, cutting
 * only between graphemes so a CJK glyph or joined emoji is never split down the
 * middle. Returns "" when there is no room. The user's own text is NEVER passed
 * here — only the suggested suffix is truncated, so the real input can never be
 * clipped or shifted by a suggestion that does not fit.
 */
export function truncateGhostText(text: string, cells: number): string {
  if (cells <= 0 || text.length === 0) return "";
  let out = "";
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    const w = stringWidth(segment);
    if (used + w > cells) break;
    out += segment;
    used += w;
  }
  return out;
}

/**
 * The block-cursor glyph. Standard terminal behaviour: a FILLED block when the
 * composer is focused/active, a HOLLOW outline when it is not — so an operator
 * can tell at a glance whether keystrokes land in the composer or elsewhere.
 */
export function composerCursorGlyph(active: boolean): string {
  return active ? "█" : "▯";
}

/**
 * Word-wrap the composer buffer into visual rows.
 *
 * Explicit `\n` (from Shift+Enter) split first; each logical line then
 * soft-wraps to `width` cells on word boundaries, exactly like a message
 * composer. A word wider than the whole row is hard-split rather than
 * overflowing. Whitespace is the operator's content, so nothing is trimmed:
 * rows always concatenate back to the logical line, allowing the visible
 * caret to be placed at a real character boundary.
 *
 * Pure and total — every input, width included, yields an array of rows.
 */
export function wrapComposerInput(text: string, width: number): string[] {
  const w = Math.max(1, Math.trunc(width) || 1);
  const rows: string[] = [];
  for (const logical of String(text ?? "").split("\n")) {
    if (logical.length === 0) {
      rows.push("");
      continue;
    }
    // Runs of non-space and runs of space, so a word wraps as a unit while
    // every character survives.
    const tokens = logical.match(/\s+|\S+/g) ?? [];
    let row = "";
    let rowW = 0;
    const pushRow = (): void => {
      rows.push(row);
      row = "";
      rowW = 0;
    };
    for (const tok of tokens) {
      const tw = stringWidth(tok);
      if (tw <= w) {
        if (rowW + tw > w) pushRow();
        row += tok;
        rowW += tw;
        continue;
      }
      // Split long tokens only between graphemes. CJK and emoji occupy two
      // cells; combining marks and joined emoji must stay with their base.
      for (const { segment } of GRAPHEMES.segment(tok)) {
        const cells = stringWidth(segment);
        if (rowW + cells > w && row) pushRow();
        row += segment;
        rowW += cells;
      }
    }
    pushRow();
  }
  return rows;
}

/**
 * The visual rows the composer body renders, bounded to COMPOSER_MAX_ROWS.
 *
 * A trailing empty row is appended when the last wrapped row is full, so the
 * end-of-buffer cursor spills onto a fresh row instead of overrunning the
 * column — the same reason a terminal wraps the caret. Never empty.
 */
export function composerContentRows(text: string, width: number): string[] {
  const w = Math.max(1, Math.trunc(width) || 1);
  const wrapped = wrapComposerInput(text, w);
  const rows = wrapped.length === 0 ? [""] : wrapped;
  const last = rows[rows.length - 1] ?? "";
  if (stringWidth(last) >= w) rows.push("");
  return rows.length > COMPOSER_MAX_ROWS ? rows.slice(rows.length - COMPOSER_MAX_ROWS) : rows;
}

/**
 * Rows the rail rule must span so it matches the frame exactly.
 *
 * Clamped to [COMPOSER_MIN_ROWS, COMPOSER_MAX_ROWS]: an empty composer still
 * reads as the min-height card, and a long one stops growing at the max. Kept
 * here (not inline in the screen) so the rail and the frame's min-height are
 * driven by one rule.
 */
export function composerRailRows(text: string, width: number, composing: boolean): number {
  const content = composing ? composerContentRows(text, width).length : 1;
  return Math.min(COMPOSER_MAX_ROWS, Math.max(COMPOSER_MIN_ROWS, content));
}

/**
 * The composer's editable body: wrapped input rows and a focus-aware block
 * cursor at the requested character boundary, or the muted placeholder when
 * idle. An interior cursor occupies one cell of its own; wrapping includes
 * that cell, and the visible window follows the row containing the caret.
 */
export function ComposerInput({
  composing,
  active,
  text,
  textWidth,
  cursorIndex = text.length,
  placeholder,
  placeholderTone,
  theme,
  suggestion,
}: {
  composing: boolean;
  /** Focused/active — drives the filled vs hollow cursor block. */
  active: boolean;
  text: string;
  /** Cells available for the input, excluding the "› " prefix. */
  textWidth: number;
  /** UTF-16 boundary in the draft; keyboard movement keeps it grapheme-aligned. */
  cursorIndex?: number;
  placeholder: string;
  /** Colour for the placeholder (e.g. ERROR for a startup failure). */
  placeholderTone?: string;
  theme: Theme;
  /**
   * fish-style inline autosuggestion, shown only at end-of-input. The caller
   * suppresses it when the caret is inside the draft.
   */
  suggestion?: string | null;
}) {
  const { TEXT, MUTED, PRIMARY } = theme;
  if (composing) {
    const displayed = sanitizeComposerText(text).replace(/\t/g, "    ");
    const interior = cursorIndex < text.length;
    // A private-use, one-cell placeholder makes the wrap algorithm account for
    // the cursor itself, including when its row was otherwise exactly full.
    const mark = "\uE000";
    const prefixLength = sanitizeComposerText(text.slice(0, cursorIndex)).replace(/\t/g, "    ").length;
    const marked = interior ? `${displayed.slice(0, prefixLength)}${mark}${displayed.slice(prefixLength)}` : displayed;
    const wrapped = interior ? wrapComposerInput(marked, textWidth) : composerContentRows(marked, textWidth);
    const caretRow = interior ? wrapped.findIndex((row) => row.includes(mark)) : wrapped.length - 1;
    const start = interior ? Math.min(Math.max(0, caretRow), Math.max(0, wrapped.length - COMPOSER_MAX_ROWS)) : 0;
    const rows = interior ? wrapped.slice(start, start + COMPOSER_MAX_ROWS) : wrapped;
    const cursor = composerCursorGlyph(active);
    return (
      <box flexDirection="column" minWidth={0}>
        {rows.map((line, i) => {
          const markAt = interior ? line.indexOf(mark) : -1;
          if (markAt >= 0) {
            return (
              <text key={`composer-line-${i}`} fg={TEXT} wrapMode="none">
                {renderComposerRow(line.slice(0, markAt), TEXT, PRIMARY)}
                <span fg={TEXT}>{cursor}</span>
                {renderComposerRow(line.slice(markAt + mark.length), TEXT, PRIMARY)}
              </text>
            );
          }
          const isLast = i === rows.length - 1;
          // Paste chips are coloured where present; the interior caret was
          // already rendered in its own row, so no extra tail cursor is drawn.
          if (!isLast || interior) {
            return (
              <text key={`composer-line-${i}`} fg={TEXT}>
                {renderComposerRow(line, TEXT, PRIMARY)}
              </text>
            );
          }
          // The last row carries the block cursor and, when present, the ghost
          // suggestion after it. The ghost is clamped to whatever cells remain
          // on the row so the real input is never clipped or wrapped.
          const remaining = textWidth - stringWidth(line) - stringWidth(cursor);
          const ghost = suggestion ? truncateGhostText(suggestion, remaining) : "";
          return (
            <text key={`composer-line-${i}`} fg={TEXT} wrapMode="none">
              {renderComposerRow(line, TEXT, PRIMARY)}
              <span fg={TEXT}>{cursor}</span>
              {ghost ? <span fg={MUTED}>{ghost}</span> : null}
            </text>
          );
        })}
      </box>
    );
  }
  return <text fg={placeholderTone ?? MUTED}>{fitLegend(textWidth, placeholder)}</text>;
}

/**
 * Composer chrome, selected by the `composerStyle` setting.
 *
 * Deliberately three distinct elements instead of one box with toggled
 * props: opentui renders a frame whenever `border` is present at all, so a
 * falsy value does not remove it.
 */
export function ComposerFrame({
  style,
  active,
  theme,
  padY = 0,
  children,
}: {
  style: TuiSettings["composerStyle"];
  active: boolean;
  theme: Theme;
  /**
   * Extra rows of vertical padding inside the frame. Used ONLY by the centered
   * hero composer, so the start-screen input reads as a comfortable card rather
   * than a thin sliver; the pinned chat composer leaves it at 0 so its height
   * matches the COMPOSER_ROWS the column reserves.
   */
  padY?: number;
  children: React.ReactNode;
}) {
  const { PRIMARY, BORDER, PANEL_ALT } = theme;
  if (style === "border") {
    return (
      <box flexDirection="column" flexGrow={1} minWidth={0} flexShrink={0} border borderColor={active ? PRIMARY : BORDER} backgroundColor={PANEL_ALT} paddingX={1} paddingTop={padY} paddingBottom={padY}>
        {children}
      </box>
    );
  }
  if (style === "rail") {
    // Two border rows replace the old vertical padding, preserving the
    // composer's height budget. Input keeps its existing four-cell inset.
    return (
      <box
        flexDirection="column"
        flexGrow={1}
        minWidth={0}
        flexShrink={0}
        border={RAIL_SIDES}
        borderColor={active ? PRIMARY : BORDER}
        backgroundColor={theme.CANVAS}
        paddingLeft={2}
        paddingRight={0}
        paddingTop={padY}
        paddingBottom={padY}
      >
        {children}
      </box>
    );
  }
  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} flexShrink={0} paddingTop={padY} paddingBottom={padY}>
      {children}
    </box>
  );
}
