/**
 * The selectable backdrops, one entry each: id, plain label and `peak`, the worst-case opacity the layer can reach (the contrast
 * guard lowers it per theme; the contrast test reads it). The sketch for each id is in `sketches.ts`.
 */
export const BACKDROPS = [
  { id: "none", label: "None", peak: 0 },
  { id: "dither-top", label: "Dither", peak: 0.15 },
  { id: "dither-flow", label: "Dither flow", peak: 0.41 },
  { id: "contours", label: "Contours", peak: 0.46 },
  { id: "glyph", label: "Glyph contours", peak: 0.67 },
  { id: "school", label: "Fish school", peak: 0.66 },
  { id: "plankton", label: "Plankton", peak: 0.66 },
  { id: "ink", label: "Ink", peak: 0.66 },
] as const
export type BackdropKind = (typeof BACKDROPS)[number]["id"]
export const DEFAULT_BACKDROP: BackdropKind = "dither-top"

/**
 * Stored ids. `dither-top` (label Dither, the original top-only dot field) is the default. `dither-flow` (label Dither flow) is the full-screen
 * Dither flow v2 and was called `dither` for a short while. A stored `dither` was the owner's choice of the original Dither look, so it now reads
 * as `dither-top` (`LEGACY_BACKDROPS`); to get the flow scene, pick Dither flow once. Everything else not listed reads as the default.
 */
export const LEGACY_BACKDROPS: Readonly<Record<string, BackdropKind>> = { dither: "dither-top" }

/** Height of the canvas as a fraction of the screen for scenes that only paint the top part (the layer is that tall, not the full screen). */
export const BAND: number = 0.64
export const bandOf = (kind: BackdropKind): number => kind === "dither-top" ? BAND : 1

/** Backdrops that existed before Dither (flow), Contours and the organic scenes replaced them; saved choices of these fall back to the default. */
export const REMOVED_BACKDROPS = ["aurora", "grid", "scanline", "code-rain", "waves", "ripple", "constellation", "topography"] as const

export const isBackdrop = (value: unknown): value is BackdropKind => BACKDROPS.some(item => item.id === value)
/** Unset, removed or unknown stored values become the default; `none` stays `none`; the old `dither` id becomes `dither-top`. */
export const parseBackdrop = (value: unknown): BackdropKind => isBackdrop(value) ? value : typeof value === "string" && Object.hasOwn(LEGACY_BACKDROPS, value) ? LEGACY_BACKDROPS[value]! : DEFAULT_BACKDROP

/**
 * Opacity of the whole layer. Sketches paint the theme ink at up to full alpha inside it, so no pixel is ever more opaque than
 * this: the ink over the page background at this alpha is the brightest frame the text can sit on.
 */
export const PEAK_ALPHA = Object.fromEntries(BACKDROPS.map(item => [item.id, item.peak])) as Record<BackdropKind, number>

/** Opacity of a gallery tile or other thumbnail. Nothing reads over it, so it is well above the screen cap: the look has to be visible at 160px. */
export const tileOpacity = (kind: BackdropKind) => Math.min(0.75, PEAK_ALPHA[kind] * 2.4)
