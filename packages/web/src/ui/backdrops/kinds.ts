/**
 * The selectable backdrops, one entry each: id, plain label and `peak`, the worst-case opacity the layer can reach (the contrast
 * guard lowers it per theme; the contrast test reads it). The sketch for each id is in `sketches.ts`.
 */
export const BACKDROPS = [
  { id: "none", label: "None", peak: 0 },
  { id: "dither", label: "Dither", peak: 0.41 },
  { id: "contours", label: "Contours", peak: 0.46 },
  { id: "glyph", label: "Glyph contours", peak: 0.67 },
  { id: "school", label: "Fish school", peak: 0.66 },
  { id: "plankton", label: "Plankton", peak: 0.66 },
  { id: "ink", label: "Ink", peak: 0.66 },
] as const
export type BackdropKind = (typeof BACKDROPS)[number]["id"]
export const DEFAULT_BACKDROP: BackdropKind = "dither"

/** Backdrops that existed before Dither flow, Contours and the organic scenes replaced them; saved choices of these fall back to Dither. */
export const REMOVED_BACKDROPS = ["aurora", "grid", "scanline", "code-rain", "waves", "ripple", "constellation", "topography"] as const

export const isBackdrop = (value: unknown): value is BackdropKind => BACKDROPS.some(item => item.id === value)
/** Unset, removed or unknown stored values become the Dither default; `none` stays `none`. */
export const parseBackdrop = (value: unknown): BackdropKind => isBackdrop(value) ? value : DEFAULT_BACKDROP

/**
 * Opacity of the whole layer. Sketches paint the theme ink at up to full alpha inside it, so no pixel is ever more opaque than
 * this: the ink over the page background at this alpha is the brightest frame the text can sit on.
 */
export const PEAK_ALPHA = Object.fromEntries(BACKDROPS.map(item => [item.id, item.peak])) as Record<BackdropKind, number>

/** Opacity of a gallery tile or other thumbnail. Nothing reads over it, so it is well above the screen cap: the look has to be visible at 160px. */
export const tileOpacity = (kind: BackdropKind) => Math.min(0.75, PEAK_ALPHA[kind] * 2.4)
