import { unit } from "./engine.js"
import type { Sketch } from "./sketch.js"

const LEVELS = 4
/** Faint flat grid with a slow diagonal highlight sweeping across it. */
export const createGrid = (): Sketch => ({
  resize() {},
  frame(c, w, h, t) {
    const step = Math.round(56 * unit(w))
    const span = w + h * 0.5 + 400
    const front = ((t * 60) % span) - 200
    for (let level = 0; level < LEVELS; level++) {
      c.beginPath()
      for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
        const d = (x + step / 2 + (y + step / 2) * 0.5 - front) / 130
        const bucket = Math.min(LEVELS - 1, Math.floor(Math.exp(-d * d) * LEVELS))
        if (bucket !== level) continue
        c.moveTo(x, y + step); c.lineTo(x, y); c.lineTo(x + step, y)
      }
      c.globalAlpha = 0.28 + (0.72 * level) / (LEVELS - 1)
      c.lineWidth = 1
      c.stroke()
    }
  },
})
