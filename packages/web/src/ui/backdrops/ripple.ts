import { unit } from "./engine.js"
import type { Sketch } from "./sketch.js"

const LIFE = 6, EVERY = 3.4, POOL = 4
/** Soft concentric rings: one is released slowly now and then, and the pointer drops one as it moves. */
export const createRipple = (): Sketch => {
  const px = new Float32Array(POOL), py = new Float32Array(POOL), born = new Float32Array(POOL).fill(-1e9)
  let next = 0, lastDrop = -1e9
  const ring = (c: CanvasRenderingContext2D, x: number, y: number, age: number, u: number) => {
    const k = age / LIFE
    c.globalAlpha = (1 - k) * (1 - k)
    for (let band = 0; band < 3; band++) { const r = (age * 46 - band * 16) * u; if (r <= 0) continue; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.stroke() }
  }
  return {
    pointer: true,
    resize() { born.fill(-1e9) },
    frame(c, w, h, t, p) {
      const u = unit(w)
      if (p.fresh) { p.fresh = false; if (t - lastDrop > 0.7) { lastDrop = t; px[next] = p.x; py[next] = p.y; born[next] = t; next = (next + 1) % POOL } }
      c.lineWidth = 1
      for (let n = Math.max(0, Math.floor((t - LIFE) / EVERY) + 1); n * EVERY <= t; n++) {
        const age = t - n * EVERY, x = w * (0.2 + 0.6 * ((n * 0.6180339) % 1)), y = h * (0.15 + 0.45 * ((n * 0.7548776) % 1))
        ring(c, x, y, age, u)
      }
      for (let i = 0; i < POOL; i++) if (t - born[i]! < LIFE) ring(c, px[i]!, py[i]!, t - born[i]!, u)
    },
  }
}
