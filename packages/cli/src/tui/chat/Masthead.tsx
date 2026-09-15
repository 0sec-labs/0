/** @jsxImportSource @opentui/react */
import React from "react";
import type { NativeImage } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { fitTuiText } from "../text.js";
import { finalLogoFrame, logoRowRuns, type LogoFrame } from "../logo-animation.js";
import {
  TERMINAL_BLOCK_LOGO_COMPACT,
  TERMINAL_BLOCK_LOGO_FULL_WIDTH,
  TERMINAL_BLOCK_LOGO_WIDTH,
  logoRunStyle,
} from "./logo.js";
import { createZeroImage, ZERO_ROWS } from "./mascot.js";
import { ZERO_WIDTH, ZERO_HEIGHT } from "./zero-art.js";
import type { Theme } from "../theme-context.js";

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
  showMascot = true,
  showTagline,
  contentWidth,
  logoFrameGrid,
  engagement,
  theme,
}: {
  showTerminalMark: boolean;
  showMascot?: boolean;
  showTagline: boolean;
  contentWidth: number;
  logoFrameGrid: LogoFrame;
  /** Real engagement facts from the host; anything absent is simply not drawn. */
  engagement?: MastheadEngagement;
  theme: Theme;
}) {
  const { MUTED, TEXT } = theme;
  const renderer = useRenderer();
  const graphics = Boolean(renderer.capabilities?.kitty_graphics || renderer.capabilities?.sixel);
  const [portrait, setPortrait] = React.useState<{ canvas: string; image: NativeImage }>();
  const showImage = graphics && showTerminalMark && showMascot;
  React.useEffect(() => {
    if (!showImage) {
      setPortrait(undefined);
      return;
    }
    const image = createZeroImage(theme.CANVAS);
    setPortrait({ canvas: theme.CANVAS, image });
    return () => image.dispose();
  }, [showImage, theme.CANVAS]);
  const portraitImage = showImage && portrait?.canvas === theme.CANVAS ? portrait.image : undefined;
  const fullWord = contentWidth >= TERMINAL_BLOCK_LOGO_FULL_WIDTH;
  const blockFrame = fullWord ? logoFrameGrid : COMPACT_LOGO_FRAME;
  const blockWidth = fullWord ? TERMINAL_BLOCK_LOGO_FULL_WIDTH : TERMINAL_BLOCK_LOGO_WIDTH;
  // Only facts that exist. `filter(Boolean)` after trimming is the whole
  // truthfulness policy: an empty or whitespace value is an absent value.
  const facts: Array<{ label: string; value: string }> = [
    { label: "Target", value: String(engagement?.target ?? "").trim() },
    { label: "Scope", value: String(engagement?.scope ?? "").trim() },
    { label: "Session", value: String(engagement?.sessionState ?? "").trim() },
  ].filter((fact) => fact.value.length > 0);
  // Native image when supported; otherwise render the same portrait as coloured
  // half blocks. Both paths are static and occupy exactly the same cell budget.
  return (
    <>
      {showTerminalMark ? (
        <text fg={MUTED} marginBottom={1}>{fitTuiText("Swiss Applied AI Cybersecurity Research Lab", contentWidth, { mode: "middle" })}</text>
      ) : null}
      {showTerminalMark && showMascot ? (
        <box flexDirection="column" width={ZERO_WIDTH} height={ZERO_HEIGHT} flexShrink={0} marginBottom={1} backgroundColor={theme.CANVAS}>
          {portraitImage ? (
            <image source={portraitImage} fit="fit" width={ZERO_WIDTH} height={ZERO_HEIGHT} flexShrink={0} />
          ) : ZERO_ROWS.map((runs, rowIndex) => (
            <box key={`zero-${rowIndex}`} flexDirection="row" width={ZERO_WIDTH} height={1} flexShrink={0}>
              {runs.map((run, runIndex) => (
                <text
                  key={`zero-${rowIndex}-${runIndex}`}
                  width={run.length}
                  height={1}
                  flexShrink={0}
                  fg={run.top ?? theme.CANVAS}
                  bg={run.bottom ?? theme.CANVAS}
                >{"▀".repeat(run.length)}</text>
              ))}
            </box>
          ))}
        </box>
      ) : null}
      {showTerminalMark ? (
        <box flexDirection="column" width={blockWidth} minWidth={blockWidth} flexShrink={0}>
          {blockFrame.map((row, index) => (
            <box key={`logo-${index}`} flexDirection="row" width={blockWidth} flexShrink={0} minWidth={0}>
              {logoRowRuns(row).map((run, runIndex) => {
                const style = logoRunStyle(run.tone, theme);
                const glyph = run.visible ? "█" : " ";
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
            {fitTuiText("0SECURITY · OPERATOR CONSOLE", contentWidth, { mode: "middle" })}
          </text>
        </box>
      )}
      {showTerminalMark ? (
        <box flexDirection="row" width={9} height={1} flexShrink={0} marginTop={1}>
          <text width={9} flexShrink={0} fg="#FD802E">━━━━━━━━━</text>
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
