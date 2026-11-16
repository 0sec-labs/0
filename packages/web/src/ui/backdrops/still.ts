import { STILL_TIME } from "./engine.js"
import type { BackdropKind } from "./kinds.js"
import { makeScene, parseInk } from "./scene.js"
import { SKETCHES } from "./sketches.js"
import type { Rgb3 } from "./sketch.js"

/** What a still needs from the theme: the ink as any `rgb()`/`#rrggbb` string (or channels), and optionally the page tone and pixel ratio. */
export interface StillTheme { ink: string; rgb?: Rgb3; dark?: boolean; dpr?: number }

/**
 * Paints one frozen frame of a backdrop into `c` (CSS pixels, origin top left, nothing cleared). It runs the same sketch the live
 * backdrop runs, fast-forwarded to `time` (default: that scene's own still time). The caller owns opacity. `none` paints nothing.
 */
export function renderStill(c: CanvasRenderingContext2D, kind: BackdropKind, width: number, height: number, theme: StillTheme, time?: number): void {
  if (kind === "none" || width <= 0 || height <= 0) return
  const sketch = SKETCHES[kind]()
  const scene = makeScene(theme.rgb ?? parseInk(theme.ink) ?? [128, 128, 128], theme.dpr ?? 1, theme.dark, true)
  c.save()
  c.globalAlpha = 1; c.fillStyle = theme.ink; c.strokeStyle = theme.ink
  const painted = height * (sketch.band ?? 1)
  sketch.resize(width, painted)
  sketch.frame(c, width, painted, time ?? sketch.still ?? STILL_TIME, { x: -1e4, y: -1e4, fresh: false }, scene)
  c.restore()
}
