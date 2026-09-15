/** @jsxImportSource @opentui/react */
import React from "react";
import { fitTuiText } from "../text.js";
import { computeLogoFrame, finalLogoFrame, logoCellGlyph, logoRowRuns } from "../logo-animation.js";
import {
  TERMINAL_BLOCK_LOGO_COMPACT,
  TERMINAL_BLOCK_LOGO_FULL_WIDTH,
  TERMINAL_BLOCK_LOGO_WIDTH,
  logoRunStyle,
} from "./logo.js";
import { MASCOT_WIDTH, mascotBand, mascotToneStyle } from "./mascot.js";
import type { Theme } from "../theme-context.js";

/**
 * The compact "0SEC" mark as a settled (static) frame. Painted verbatim as the
 * graceful fallback when the content column can hold a block mark but not the
 * full "0SECURITY" word (see the width tiers below). Computed once — the grid is
 * constant and `finalLogoFrame` is pure.
 */
const COMPACT_LOGO_FRAME = finalLogoFrame(TERMINAL_BLOCK_LOGO_COMPACT);

/**
 * What the masthead is allowed to say about the engagement, and nothing more.
 *
 * Every field is optional and every one of them is rendered ONLY when the host
 * actually holds it. There is no default target, no default scope and no
 * default session state: an engagement whose scope has not been declared shows
 * no scope line rather than a reassuring-looking "full scope", and a session
 * whose state is not yet known shows no state rather than "ready". A masthead
 * is the first thing an operator reads before pointing a tool at someone
 * else's estate, so a plausible invention here is the most expensive kind.
 */
export interface MastheadEngagement {
  /** The declared target of this engagement, verbatim from the host. */
  target?: string;
  /** The declared scope, verbatim. Omitted entirely when undeclared. */
  scope?: string;
  /** The session's own state word (e.g. "connected", "offline"), verbatim. */
  sessionState?: string;
}

/**
 * The centered empty-state hero: a muted EYEBROW (the lab name) above the 0sec
 * block mark, then the tagline, then — when and only when the host supplies
 * them — the engagement facts. The caller still gates the whole unit behind
 * `showMasthead`.
 *
 * Every line is fitted to `contentWidth`, including the no-logo fallback, so
 * the hero cannot paint past the content column in a narrow terminal.
 */
export function Masthead({
  showTerminalMark,
  showTagline,
  contentWidth,
  logoFrameGrid,
  engagement,
  theme,
}: {
  showTerminalMark: boolean;
  showTagline: boolean;
  contentWidth: number;
  logoFrameGrid: ReturnType<typeof computeLogoFrame>;
  /** Real engagement facts from the host; anything absent is simply not drawn. */
  engagement?: MastheadEngagement;
  theme: Theme;
}) {
  const { MUTED, TEXT } = theme;
  // Only facts that exist. `filter(Boolean)` after trimming is the whole
  // truthfulness policy: an empty or whitespace value is an absent value.
  const facts: Array<{ label: string; value: string }> = [
    { label: "Target", value: String(engagement?.target ?? "").trim() },
    { label: "Scope", value: String(engagement?.scope ?? "").trim() },
    { label: "Session", value: String(engagement?.sessionState ?? "").trim() },
  ].filter((fact) => fact.value.length > 0);
  // The brand band — a short orange rule drawn directly below the wordmark.
  const band = mascotBand();
  // Which block wordmark to paint. The caller only sets `showTerminalMark` once
  // the column can hold the COMPACT mark (>= TERMINAL_BLOCK_LOGO_WIDTH); from
  // there we show the full animated "0SECURITY" once the column is wide enough
  // for it (>= TERMINAL_BLOCK_LOGO_FULL_WIDTH) and otherwise fall back to the
  // static compact "0SEC" block. Both frames are painted cell-exact into a box
  // sized to their own width, so neither can overflow the content column.
  const showFullWord = contentWidth >= TERMINAL_BLOCK_LOGO_FULL_WIDTH;
  const blockFrame = showFullWord ? logoFrameGrid : COMPACT_LOGO_FRAME;
  const blockWidth = showFullWord ? TERMINAL_BLOCK_LOGO_FULL_WIDTH : TERMINAL_BLOCK_LOGO_WIDTH;
  return (
    <>
      {showTerminalMark ? (
        <text fg={MUTED} marginBottom={1}>{fitTuiText("Swiss Applied AI Cybersecurity Research Lab", contentWidth, { mode: "middle" })}</text>
      ) : null}
      {showTerminalMark ? (
        <box flexDirection="column" width={blockWidth} minWidth={blockWidth} flexShrink={0}>
          {/*
            * 0sec block wordmark: a slashed zero — a white "0" outline with an
            * orange diagonal slash through its hollow — followed by white
            * "SECURITY" (or "SEC" in the compact fallback). The per-cell frame
            * is the full-word intro animation / settled frame when the column is
            * wide enough (see `blockFrame`), and the static compact "0SEC" mark
            * otherwise. logoRowRuns coalesces each row into (tone,visible,ch)
            * runs whose widths sum to `blockWidth`, so no run overflows and each
            * tone keeps its own token; chamfer corner cells keep their quadrant
            * glyph via `logoCellGlyph`. Rendered verbatim — the row widths are
            * exact, so no fitTuiText/trim is needed.
            */}
          {blockFrame.map((row, index) => (
            <box key={`logo-${index}`} flexDirection="row" width={blockWidth} flexShrink={0} minWidth={0}>
              {logoRowRuns(row).map((run, runIndex) => {
                const style = logoRunStyle(run.tone, theme);
                const glyph = run.visible ? logoCellGlyph(run.ch) : " ";
                return (
                  <text
                    key={`logo-${index}-${runIndex}`}
                    width={run.length}
                    flexShrink={0}
                    fg={style.fg}
                    attributes={style.attributes}
                  >{glyph.repeat(run.length)}</text>
                );
              })}
            </box>
          ))}
        </box>
      ) : (
        <box flexDirection="row" width={contentWidth} flexShrink={0} minWidth={0}>
          <text width={contentWidth} height={1} wrapMode="none" truncate fg={TEXT}>
            {fitTuiText("0SEC · OPERATOR CONSOLE", contentWidth, { mode: "middle" })}
          </text>
        </box>
      )}
      {/*
        * The brand band — a short orange (PRIMARY) rule directly under the
        * wordmark, echoing the site's wordmark-over-band lockup (the brand's
        * old red band, retired to orange). Same gate as the block wordmark.
        */}
      {showTerminalMark ? (
        <box flexDirection="row" width={MASCOT_WIDTH} flexShrink={0} minWidth={0} marginTop={1}>
          <text width={band.length} flexShrink={0} fg={mascotToneStyle(band.tone, theme).fg}>
            {band.glyph.repeat(band.length)}
          </text>
        </box>
      ) : null}
      {showTagline ? (
        <text fg={TEXT} marginTop={1}>{fitTuiText("Make software secure itself.", contentWidth, { mode: "middle" })}</text>
      ) : null}
      {facts.length > 0 ? (
        <box flexDirection="column" width={contentWidth} flexShrink={0} minWidth={0} marginTop={1} alignItems="center">
          {facts.map((fact) => (
            <text key={fact.label} width={contentWidth} height={1} wrapMode="none" truncate fg={MUTED}>
              {fitTuiText(`${fact.label}: ${fact.value}`, contentWidth, { mode: "middle" })}
            </text>
          ))}
        </box>
      ) : null}
    </>
  );
}
