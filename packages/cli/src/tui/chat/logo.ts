import { TextAttributes } from "@opentui/core";
import type { Theme } from "../theme-context.js";
import type { LogoCellTone } from "../logo-animation.js";

/**
 * Five-row 0SECURITY wordmark. Every letter has an eight-cell slot and
 * two cells of tracking; the narrow I/T/Y stems keep the same two-cell weight.
 * '#' is white block art, '/' is the orange diagonal in the leading zero.
 */
export const TERMINAL_BLOCK_LOGO = [
  " ######    ######   #######    ######   ##    ##  #######    ######   ########  ##    ##",
  "##  //##  ##        ##        ##        ##    ##  ##    ##     ##        ##      ##  ## ",
  "## // ##   ######   ######    ##        ##    ##  #######      ##        ##       ####  ",
  "##//  ##        ##  ##        ##        ##    ##  ##  ##       ##        ##        ##   ",
  " ######    ######   #######    ######    ######   ##   ##    ######      ##        ##   ",
] as const;
export const TERMINAL_BLOCK_LOGO_FULL_WIDTH = 88;

/** Original compact mark for columns too narrow for the full word. */
export const TERMINAL_BLOCK_LOGO_COMPACT = [
  " ######   #######  #######   ######",
  "##  //##  ##       ##       ##     ",
  "## // ##  #######  #####    ##     ",
  "##//  ##       ##  ##       ##     ",
  " ######   #######  #######   ######",
] as const;
export const TERMINAL_BLOCK_LOGO_WIDTH = 35;

/**
 * Milliseconds between logo intro frames. One rate for every style — the frame
 * *counts* differ (see logo-animation.ts), so a shorter style simply settles
 * sooner; shimmer loops at this cadence. ~14 Hz reads as motion without the
 * repaint cost of the busy spinners.
 */
export const LOGO_FRAME_INTERVAL_MS = 70;

/**
 * How a computed logo frame's per-cell `tone` maps onto the theme (and DIM):
 *   text  -> TEXT             error -> ERROR
 *   dim   -> TEXT + DIM       muted -> MUTED
 *   brand -> BRAND            #rrggbb -> that literal colour as the foreground
 *
 * The colourful intro styles (rainbow, matrix, wave, neon, and the comet
 * gradients of shimmer/fade/strike/draw) can't be expressed in the five named
 * tones, so `logo-animation.ts` computes an explicit `#rrggbb` and carries it in
 * the `tone` field itself (it stays pure — no theme). Any value starting with
 * `#` is passed straight through as the foreground; everything else is a named
 * tone mapped to a theme token here. A hidden cell renders as spaces (the caller
 * picks the glyph), so this is only consulted for visible runs; the fg is
 * harmless on a space run regardless.
 */
export function logoRunStyle(tone: LogoCellTone, theme: Theme): { fg: string; attributes?: number } {
  if (tone.startsWith("#")) return { fg: tone };
  switch (tone) {
    case "error":
      // The slashed-zero's diagonal is the 0sec BRAND orange — a fixed mark, not a
      // semantic error tone. Pinned so it stays the brand red regardless of the
      // theme's colours (the orange is the brand mark, tuned to the 0sec identity).
      return { fg: "#FD802E" };
    case "muted":
      return { fg: theme.MUTED };
    case "dim":
      return { fg: theme.TEXT, attributes: TextAttributes.DIM };
    case "brand":
      return { fg: theme.BRAND };
    default:
      return { fg: theme.TEXT };
  }
}
