import { seeded, unit } from "./engine.js"
import type { Sketch } from "./sketch.js"

const GRAIN = 260
/** Very slow horizontal band, hairline scan rows and a little flickering grain. */
export const createScanline = (): Sketch => {
  const rand = seeded(11)
  const gx = new Float32Array(GRAIN), gy = new Float32Array(GRAIN)
  let roll = -1
  return {
    resize() { roll = -1 },
    frame(c, w, h, t) {
      const u = unit(w), gap = Math.max(2, Math.round(4 * u))
      c.globalAlpha = 0.22
      c.beginPath()
      for (let y = 0; y < h; y += gap) { c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5) }
      c.lineWidth = 1; c.stroke()
      // Band: stacked slices so the edges fall off softly without a gradient object per frame.
      const band = 140 * u, slices = 14, y0 = ((t * 14 * u) % (h + band * 2)) - band
      for (let i = 0; i < slices; i++) {
        c.globalAlpha = 0.5 * Math.sin(((i + 0.5) / slices) * Math.PI)
        c.fillRect(0, y0 + (i * band) / slices, w, band / slices + 1)
      }
      const tick = Math.floor(t * 8)
      if (tick !== roll) { roll = tick; for (let i = 0; i < GRAIN; i++) { gx[i] = Math.floor(rand() * w); gy[i] = Math.floor(rand() * h) } }
      c.globalAlpha = 0.6
      c.beginPath()
      for (let i = 0; i < GRAIN; i++) c.rect(gx[i]!, gy[i]!, 1, 1)
      c.fill()
    },
  }
}
