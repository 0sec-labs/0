import { unit } from "./engine.js"
import type { Sketch } from "./sketch.js"

const LAYERS = 6
/** Layered sine contours that roll past one another at different speeds. */
export const createWaves = (): Sketch => ({
  resize() {},
  frame(c, w, h, t) {
    const u = unit(w), step = Math.max(4, 8 * u)
    c.lineWidth = 1
    for (let layer = 0; layer < LAYERS; layer++) {
      const base = h * (0.3 + layer * 0.1), amp = (22 + layer * 5) * (0.4 + u * 0.6)
      const k1 = 0.0042 / u * (1 + layer * 0.08), k2 = 0.0095 / u, s1 = 0.22 + layer * 0.03, s2 = 0.15
      c.beginPath()
      for (let x = 0; x <= w + step; x += step) {
        const y = base + amp * Math.sin(x * k1 + t * s1 + layer) + amp * 0.35 * Math.sin(x * k2 - t * s2 + layer * 2)
        if (x === 0) c.moveTo(x, y); else c.lineTo(x, y)
      }
      c.globalAlpha = 1 - layer * 0.1
      c.stroke()
    }
  },
})
