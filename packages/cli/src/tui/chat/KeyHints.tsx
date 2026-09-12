/** @jsxImportSource @opentui/react */
import React from "react";
import type { ConsoleAutonomyMode } from "@0sec/core";
import type { Theme } from "../theme-context.js";
import { fitTuiText } from "../text.js";
import { AUTONOMY_CYCLE_HINT } from "../composer-mode.js";
import { modeColorFor, modeLabel } from "./helpers.js";
import type { KeyHint } from "./types.js";

/** Plain rendered length of a key-hint row, for a fits-the-column guard. */
export function keyHintsLength(pairs: readonly KeyHint[], sep: string): number {
  let n = 0;
  pairs.forEach((p, i) => {
    if (i > 0) n += sep.length;
    n += p.key.length + 1 + p.label.length;
  });
  return n;
}

/**
 * A keybind hint row: the KEY glyphs render in TEXT (white) and the labels in
 * MUTED, so `shift+tab mode · ctrl+p palette` reads as chords, not prose. Each
 * segment is flexShrink={0}, so the caller must only render this where it fits
 * (see keyHintsLength); a squeezed row of siblings overpaints in this TUI.
 */
export function KeyHints({
  pairs,
  theme,
  sep = " · ",
}: {
  pairs: readonly KeyHint[];
  theme: Theme;
  sep?: string;
}) {
  const { TEXT, MUTED } = theme;
  const nodes: React.ReactNode[] = [];
  pairs.forEach((p, i) => {
    if (i > 0) nodes.push(<text key={`sep-${i}`} flexShrink={0} fg={MUTED}>{sep}</text>);
    nodes.push(<text key={`key-${i}`} flexShrink={0} fg={TEXT}>{p.key}</text>);
    nodes.push(<text key={`lbl-${i}`} flexShrink={0} fg={MUTED}>{` ${p.label}`}</text>);
  });
  return <box flexDirection="row" minWidth={0} flexShrink={0}>{nodes}</box>;
}

/**
 * The composer footer: the CURRENT autonomy mode and how to change it —
 * `Standard (Shift+Tab to cycle)`.
 *
 * The mode name is painted in its own colour (`modeColorFor`, the same one the
 * header and the status bar use) so an auto-approving mode is red wherever it
 * appears; the parenthetical is MUTED, because it is an affordance and not a
 * fact about the session.
 *
 * TRUTHFULNESS. `mode` absent — the host has not wired it, or the runtime has
 * not reported one yet — renders NOTHING. There is no default: displaying
 * "Standard" for an unknown mode would understate the authority actually in
 * force, which is the one direction this row must never be wrong in.
 *
 * GEOMETRY. Every segment is `flexShrink={0}` (a squeezed sibling row
 * overpaints in this TUI), so the row is measured against `width` before it is
 * built and degrades in steps: trailing `pairs` go first, then the
 * parenthetical hint, and the bare mode name is fitted as a last resort. It
 * never emits more cells than `width`.
 */
export function ComposerFooter({
  mode,
  theme,
  width,
  pairs = [],
  sep = " · ",
}: {
  /** The live autonomy mode; null/undefined renders nothing at all. */
  mode: ConsoleAutonomyMode | null | undefined;
  theme: Theme;
  /** Cells the footer row may occupy. */
  width: number;
  /** Optional extra hints appended after the mode (e.g. `ctrl+p palette`). */
  pairs?: readonly KeyHint[];
  sep?: string;
}) {
  const { MUTED } = theme;
  const cells = Math.max(0, Math.trunc(width) || 0);
  if (!mode || cells <= 0) return null;

  const label = modeLabel(mode);
  const modeColor = modeColorFor(mode, theme);
  const hint = ` ${AUTONOMY_CYCLE_HINT}`;
  const extras = pairs.length > 0 ? sep.length + keyHintsLength(pairs, sep) : 0;

  const withHint = label.length + hint.length;
  if (withHint + extras <= cells) {
    return (
      <box flexDirection="row" minWidth={0} flexShrink={0}>
        <text flexShrink={0} fg={modeColor}>{label}</text>
        <text flexShrink={0} fg={MUTED}>{hint}</text>
        {pairs.length > 0 ? <text flexShrink={0} fg={MUTED}>{sep}</text> : null}
        {pairs.length > 0 ? <KeyHints pairs={pairs} theme={theme} sep={sep} /> : null}
      </box>
    );
  }
  if (withHint <= cells) {
    return (
      <box flexDirection="row" minWidth={0} flexShrink={0}>
        <text flexShrink={0} fg={modeColor}>{label}</text>
        <text flexShrink={0} fg={MUTED}>{hint}</text>
      </box>
    );
  }
  // Too narrow for the affordance: the mode itself is the safety-relevant
  // half, so it is what survives — fitted, never overflowing.
  return (
    <box flexDirection="row" minWidth={0} flexShrink={0}>
      <text flexShrink={0} fg={modeColor}>{fitTuiText(label, cells)}</text>
    </box>
  );
}
