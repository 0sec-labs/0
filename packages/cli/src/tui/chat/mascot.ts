import type { Theme } from "../theme-context.js";

/**
 * The 0sec mascot — the "aperture operator", a compact terminal rendering of
 * the brand's signature device.
 *
 * Across the marketing site (`OsecAperture.astro`) and the 0cloud dashboard
 * (`OsecApertureMark` from `@0cloud/ui`) the brand carries ONE recurring
 * character: the *aperture* ∅ — a chamfered-octagon "0" ring cut by a diagonal
 * slash. That octagon-with-a-slash is the closest thing the brand owns to a
 * face: a little masked sentinel head. This is that head, drawn as block art so
 * it can stand beside the block "0SEC" wordmark in the CLI hero without a second
 * visual language.
 *
 * Construction mirrors the logo (see logo.ts):
 *   - single-cell-safe glyphs only — solid `█` for the octagon ring and the
 *     slash (never a wide/emoji char that would mis-measure), plus a `━`
 *     box-drawing rule for the band (also single width);
 *   - a fixed-width grid whose every row measures exactly `MASCOT_WIDTH`, so no
 *     row can overflow the content column;
 *   - per-cell tones mapped onto the active theme at render time (never
 *     hardcoded), so the mascot re-skins with every palette.
 *
 * The slash is the BRAND orange (the same mark colour as the logo's slash); the
 * ring is TEXT; and the band beneath is the PRIMARY orange rule — the brand's
 * "red band" retired to orange — echoing the wordmark-over-band lockup on the
 * site's OG image.
 *
 * It is entirely static: there is no animation, so it is reduceMotion-safe by
 * construction, and the caller gates it on the same interactive + width test as
 * the block logo (see Masthead), so it simply disappears on a narrow terminal
 * rather than breaking the layout.
 */

/** Every mascot row (head and band alike) is exactly this many cells wide. */
export const MASCOT_WIDTH = 9;

/** What a mascot cell paints as — a theme role, resolved by `mascotToneStyle`. */
export type MascotCellTone = "ring" | "slash" | "band" | "empty";

/**
 * The aperture head as a per-cell tone grid over a three-symbol alphabet:
 *   ' ' → empty (chamfered corner / hollow), 'O' → the white octagon ring,
 *   'X' → the orange diagonal slash crossing the hollow (lower-left to
 *   upper-right, the ∅). Two cells thick on each end so the slash reads as a
 *   deliberate diagonal and not a stray block. Each string is `MASCOT_WIDTH`.
 */
const HEAD_ROWS = [
  " OOOOOOO ",
  "OO   XXOO",
  "OO  X  OO",
  "OOXX   OO",
  " OOOOOOO ",
] as const;

/** The brand band: a solid orange rule under the head, full mascot width. */
const BAND_ROW = "━".repeat(MASCOT_WIDTH);

/** One coalesced run of same-tone cells within a row. */
export interface MascotRun {
  /** The glyph to repeat — `█` for solid cells, `━` for the band, ' ' for gaps. */
  glyph: string;
  /** How many cells wide this run is; the runs of a row sum to `MASCOT_WIDTH`. */
  length: number;
  /** The theme role this run paints in. */
  tone: MascotCellTone;
}

function cellTone(ch: string): MascotCellTone {
  switch (ch) {
    case "O":
      return "ring";
    case "X":
      return "slash";
    case "━":
      return "band";
    default:
      return "empty";
  }
}

function cellGlyph(tone: MascotCellTone): string {
  switch (tone) {
    case "band":
      return "━";
    case "empty":
      return " ";
    default:
      return "█";
  }
}

/** Coalesce a grid row string into same-tone runs (widths sum to MASCOT_WIDTH). */
function rowRuns(row: string): MascotRun[] {
  const runs: MascotRun[] = [];
  for (const ch of row) {
    const tone = cellTone(ch);
    const last = runs[runs.length - 1];
    if (last && last.tone === tone) last.length += 1;
    else runs.push({ glyph: cellGlyph(tone), length: 1, tone });
  }
  return runs;
}

/**
 * The full mascot as rows of runs, ready to paint: the octagon head rows
 * followed by the brand band row. The renderer sizes each run's `<text>` to
 * `run.length`, exactly as the logo does, so the art can never paint past
 * `MASCOT_WIDTH`.
 */
export function mascotRows(): MascotRun[][] {
  return [...HEAD_ROWS, BAND_ROW].map(rowRuns);
}

/**
 * How a mascot cell's tone maps onto the theme. Read from the theme every time
 * — nothing is hardcoded — so the mascot follows the palette:
 *   ring → TEXT, slash → BRAND (the mark orange), band → PRIMARY (brand rule).
 * `empty` never actually paints a visible glyph; its fg is harmless.
 */
export function mascotToneStyle(tone: MascotCellTone, theme: Theme): { fg: string } {
  switch (tone) {
    case "slash":
      return { fg: theme.BRAND };
    case "band":
      return { fg: theme.PRIMARY };
    case "ring":
    case "empty":
    default:
      return { fg: theme.TEXT };
  }
}
