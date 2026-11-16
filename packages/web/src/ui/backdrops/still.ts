import { STILL_TIME, seeded } from "./engine.js"
import type { BackdropKind } from "./kinds.js"
import { SKETCHES } from "./sketches.js"

/** What a still needs from the theme: the ink the scene is painted in, as any CSS colour string. */
export interface StillTheme { ink: string }

/** Aurora blobs, in the same units as `aurora.tsx`: percent position, size in percent of the width, drift seconds and delay. */
export const AURORA_BLOBS = [
  { x: 8, y: -12, size: 62, time: 46, delay: -9 },
  { x: 52, y: -18, size: 54, time: 58, delay: -23 },
  { x: 74, y: 20, size: 40, time: 52, delay: -31 },
] as const

/** Where the CSS drift keyframe (`backdrop-drift` in styles.css, ease-in-out, alternate) puts a blob `seconds` after the page started. */
export function auroraDrift(blob: { time: number; delay: number }, seconds: number) {
  const phase = ((seconds - blob.delay) / blob.time) % 2
  const linear = phase > 1 ? 2 - phase : phase
  const eased = linear * linear * (3 - 2 * linear)
  return { dx: -0.06 + 0.14 * eased, dy: -0.04 + 0.1 * eased, scale: 1 + 0.16 * eased }
}

/** `rgb(...)`/`#rrggbb` with a new alpha, so a gradient fades to the same hue instead of grey. */
function withAlpha(color: string, alpha: number): string {
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color.trim())
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (hex) { const n = parseInt(hex[1]!, 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})` }
  return color
}

function aurora(c: CanvasRenderingContext2D, width: number, height: number, ink: string, time: number) {
  for (const blob of AURORA_BLOBS) {
    const w = (blob.size / 100) * width, h = w * 0.7
    const drift = auroraDrift(blob, time)
    const cx = (blob.x / 100) * width + w / 2 + drift.dx * w, cy = (blob.y / 100) * height + h / 2 + drift.dy * h
    c.save()
    c.translate(cx, cy); c.scale(drift.scale, drift.scale * 0.7)
    const gradient = c.createRadialGradient(0, 0, 0, 0, 0, w / 2)
    gradient.addColorStop(0, ink); gradient.addColorStop(1, withAlpha(ink, 0))
    c.fillStyle = gradient
    c.fillRect(-w / 2, -w / 2, w, w)
    c.restore()
  }
}

function dither(c: CanvasRenderingContext2D, width: number, height: number, ink: string) {
  const step = width < 400 ? 4 : 6, rand = seeded(11)
  c.fillStyle = ink
  c.beginPath()
  for (let y = step / 2; y < height; y += step) for (let x = step / 2; x < width; x += step) {
    // Denser toward the top, like the shader's glow from the top edge.
    if (rand() > 0.35 + 0.65 * (1 - y / height)) continue
    c.moveTo(x + 1, y); c.arc(x, y, step < 5 ? 0.7 : 1, 0, 6.2832)
  }
  c.fill()
}

/**
 * Paints one frozen frame of a backdrop into `c` (CSS pixels, origin top left, nothing cleared). It runs the same sketches the live
 * backdrop runs, at a fixed `time`; Aurora and Dither are CSS in the live app, so they get a canvas twin with the same geometry.
 * The caller owns opacity. `none` paints nothing.
 */
export function renderStill(c: CanvasRenderingContext2D, kind: BackdropKind, width: number, height: number, theme: StillTheme, time = STILL_TIME): void {
  if (kind === "none" || width <= 0 || height <= 0) return
  c.save()
  c.globalAlpha = 1; c.fillStyle = theme.ink; c.strokeStyle = theme.ink
  if (kind === "aurora") aurora(c, width, height, theme.ink, time)
  else if (kind === "dither") dither(c, width, height, theme.ink)
  else {
    const sketch = SKETCHES[kind]?.()
    if (sketch) { sketch.resize(width, height); sketch.frame(c, width, height, time, { x: -1e4, y: -1e4, fresh: false }) }
  }
  c.restore()
}
