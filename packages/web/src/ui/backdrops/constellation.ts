import { seeded, unit } from "./engine.js"
import type { Sketch } from "./sketch.js"

/** Sparse points drifting slowly; any two that come near are joined by a line that fades with distance. */
export const createConstellation = (): Sketch => {
  let n = 0, x0 = new Float32Array(0), y0 = new Float32Array(0), vx = new Float32Array(0), vy = new Float32Array(0), px = new Float32Array(0), py = new Float32Array(0)
  return {
    resize(w, h) {
      n = Math.min(64, Math.max(10, Math.round((w * h) / 16000)))
      x0 = new Float32Array(n); y0 = new Float32Array(n); vx = new Float32Array(n); vy = new Float32Array(n); px = new Float32Array(n); py = new Float32Array(n)
      const rand = seeded(7)
      for (let i = 0; i < n; i++) { x0[i] = rand() * w; y0[i] = rand() * h; const a = rand() * 6.283, s = 4 + rand() * 7; vx[i] = Math.cos(a) * s * unit(w); vy[i] = Math.sin(a) * s * unit(w) }
    },
    frame(c, w, h, t) {
      const reach = 150 * unit(w), reach2 = reach * reach
      for (let i = 0; i < n; i++) {
        px[i] = (((x0[i]! + vx[i]! * t) % w) + w) % w
        py[i] = (((y0[i]! + vy[i]! * t) % h) + h) % h
      }
      c.lineWidth = 1
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const dx = px[i]! - px[j]!, dy = py[i]! - py[j]!, d2 = dx * dx + dy * dy
        if (d2 > reach2) continue
        c.globalAlpha = (1 - Math.sqrt(d2) / reach) * 0.7
        c.beginPath(); c.moveTo(px[i]!, py[i]!); c.lineTo(px[j]!, py[j]!); c.stroke()
      }
      c.globalAlpha = 1
      c.beginPath()
      const r = Math.max(1, 2 * unit(w))
      for (let i = 0; i < n; i++) { c.moveTo(px[i]! + r, py[i]!); c.arc(px[i]!, py[i]!, r, 0, 6.2832) }
      c.fill()
    },
  }
}
