import { seeded, unit } from "./engine.js"
import type { Sketch } from "./sketch.js"

const GLYPHS = [..."0123456789abcdef0123456789abcdef<>/{}[]=+-*:;"]
/** Sparse, dim glyph columns falling a row or two per second, in hex and plain ASCII. */
export const createCodeRain = (): Sketch => {
  let cols = 0, phase = new Float32Array(0), speed = new Float32Array(0), trail = new Uint8Array(0)
  return {
    resize(w) {
      cols = Math.max(4, Math.floor(w / (24 * unit(w))))
      phase = new Float32Array(cols); speed = new Float32Array(cols); trail = new Uint8Array(cols)
      const rand = seeded(23)
      for (let i = 0; i < cols; i++) { phase[i] = rand() * 100; speed[i] = 1.2 + rand() * 1.8; trail[i] = rand() < 0.35 ? 5 + Math.floor(rand() * 6) : 0 }
    },
    frame(c, w, h, t) {
      const u = unit(w), size = Math.max(6, Math.round(13 * u)), line = size * 1.5, colW = w / cols, rows = Math.ceil(h / line)
      c.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`
      c.textBaseline = "top"
      for (let i = 0; i < cols; i++) {
        const length = trail[i]!
        if (!length) continue
        const head = Math.floor(phase[i]! + t * speed[i]!) % (rows + length)
        for (let k = 0; k < length; k++) {
          const row = head - k
          if (row < 0 || row >= rows) continue
          c.globalAlpha = (k === 0 ? 1 : 0.7) * (1 - k / length)
          c.fillText(GLYPHS[(i * 131 + row * 17 + Math.floor(t * 0.6 + i)) % GLYPHS.length]!, i * colW, row * line)
        }
      }
    },
  }
}
