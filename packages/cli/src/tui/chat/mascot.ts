import type { Theme } from "../theme-context.js";

/**
 * The 0sec brand band — a short orange rule that sits directly beneath the block
 * wordmark in the CLI hero, echoing the wordmark-over-band lockup on the
 * marketing site's OG image (the brand's old "red band", retired to orange).
 *
 * This used to also carry an "aperture operator" head (a slashed-octagon mask)
 * stacked above the wordmark, but that was a mini slashed-zero sitting on top of
 * the wordmark's OWN slashed-zero — redundant — so only the band remains.
 *
 * Construction mirrors the logo (see logo.ts):
 *   - a single-cell-safe glyph only — a `━` box-drawing rule (single width, so
 *     it never mis-measures like a wide/emoji char would);
 *   - a fixed-width row that measures exactly `MASCOT_WIDTH`, so it can never
 *     overflow the content column;
 *   - its tone mapped onto the active theme at render time (never hardcoded), so
 *     the band re-skins with every palette.
 *
 * It is entirely static — no animation, so reduceMotion-safe by construction —
 * and the caller gates it on the same interactive + width test as the block
 * logo (see Masthead), so it simply disappears on a narrow terminal rather than
 * breaking the layout.
 */

/** The brand band is exactly this many cells wide. */
export const MASCOT_WIDTH = 9;

/** What a band cell paints as — a theme role, resolved by `mascotToneStyle`. */
export type MascotCellTone = "band" | "empty";

/** One coalesced run of same-tone cells within the band row. */
export interface MascotRun {
  /** The glyph to repeat — `━` for the band, ' ' for a gap. */
  glyph: string;
  /** How many cells wide this run is; the runs of the row sum to `MASCOT_WIDTH`. */
  length: number;
  /** The theme role this run paints in. */
  tone: MascotCellTone;
}

/** The brand band: a solid orange rule, full mascot width, as one run. */
export function mascotBand(): MascotRun {
  return { glyph: "━", length: MASCOT_WIDTH, tone: "band" };
}

/**
 * How a band cell's tone maps onto the theme. Read from the theme every time —
 * nothing is hardcoded — so the band follows the palette: band → PRIMARY (the
 * brand rule). `empty` never actually paints a visible glyph; its fg is harmless.
 */
export function mascotToneStyle(tone: MascotCellTone, theme: Theme): { fg: string } {
  switch (tone) {
    case "band":
      return { fg: theme.PRIMARY };
    case "empty":
    default:
      return { fg: theme.TEXT };
  }
}
