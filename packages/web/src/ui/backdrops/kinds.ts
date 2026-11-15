/** The selectable backdrops: ids, plain labels and the worst-case opacity each layer can reach (the contrast test reads it). */
export const BACKDROPS = [
  { id: "none", label: "None" },
  { id: "dither", label: "Dither" },
  { id: "aurora", label: "Aurora" },
  { id: "grid", label: "Grid" },
  { id: "topography", label: "Topography" },
  { id: "constellation", label: "Constellation" },
  { id: "scanline", label: "Scanline" },
  { id: "code-rain", label: "Code rain" },
  { id: "waves", label: "Waves" },
  { id: "ripple", label: "Ripple" },
] as const
export type BackdropKind = (typeof BACKDROPS)[number]["id"]
export const DEFAULT_BACKDROP: BackdropKind = "dither"

export const isBackdrop = (value: unknown): value is BackdropKind => BACKDROPS.some(item => item.id === value)
/** Unset or unknown stored values keep the Dither default, so nothing changes for existing users. */
export const parseBackdrop = (value: unknown): BackdropKind => isBackdrop(value) ? value : DEFAULT_BACKDROP

/**
 * Opacity of the whole layer. Sketches paint the theme ink at full alpha inside it, so no pixel is ever more opaque than
 * this: the ink over the page background at this alpha is the brightest frame the text can sit on.
 */
export const PEAK_ALPHA: Record<BackdropKind, number> = {
  none: 0, dither: 0.15, aurora: 0.2, grid: 0.2, topography: 0.2, constellation: 0.24, scanline: 0.12, "code-rain": 0.26, waves: 0.2, ripple: 0.22,
}
