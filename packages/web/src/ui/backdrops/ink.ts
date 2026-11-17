import { BAYER } from "./bayer.js"
import { createInkFlow } from "./curl.js"
import { pixelSketch } from "./pixel-sketch.js"
import { decayFrames } from "./pixels.js"
import type { Sketch } from "./sketch.js"

const FPS = 15, TRAIL = 2.2, INK = 0.2, CALM = 0.55
const DECAY = Math.exp(-(1 / FPS) / (TRAIL / 3.2)), KEEP = decayFrames(1, DECAY, 0.004)

/** Ink plumes: ~3400 particles leave fading trails that thin into dithered wisps. */
export const createInk = (): Sketch => pixelSketch({
  fps: FPS, cell: 3, still: 20, trail: 4,
  palette: scene => ({ accent: scene.dark ? [88, 222, 204] : [10, 120, 112], tone: 1 }),
  create(g) {
    const { W, H } = g, A = new Float32Array(W * H), B = new Float32Array(W * H), calm = g.calm(CALM)
    const flow = createInkFlow(g, { particles: 1700, flow: 46, wind: 34, life: 19, fps: FPS })
    return {
      step: dt => flow.advance(dt),
      render() {
        for (const p of flow.parts) {
          const a0 = Math.min(1, p.age / 0.6) * Math.min(1, (p.life - p.age) / 2.5) * (0.35 + 0.65 * Math.exp(-p.age / 7)) * INK
          const xi = p.x | 0, yi = p.y | 0
          if (xi < 0 || yi < 0 || xi >= W - 1 || yi >= H - 1) continue
          const fx = p.x - xi, fy = p.y - yi, F = p.t ? B : A, i = yi * W + xi
          g.touchBox(xi - 1, yi - 1, xi + 1, yi + 1, KEEP)
          F[i]! += a0 * (1 - fx) * (1 - fy); F[i + 1]! += a0 * fx * (1 - fy); F[i + W]! += a0 * (1 - fx) * fy; F[i + W + 1]! += a0 * fx * fy
        }
        {
        const { W, H, BW, BH, blk, FR, b32 } = g
        for (let by = 0; by < BH; by++) for (let bx = 0; bx < BW; bx++) {
          if (blk[by * BW + bx]! < FR) continue
          const y1 = Math.min(H, by * 16 + 16), x1 = Math.min(W, bx * 16 + 16)
          for (let y = by * 16; y < y1; y++) for (let x = bx * 16, i = y * W + x; x < x1; x++, i++) {
              let a = A[i]!, b = B[i]!
              if (a === 0 && b === 0) { b32[i] = 0; continue }
              a *= DECAY; b *= DECAY
              if (a < 0.004) a = 0; if (b < 0.004) b = 0; if (a > 1) a = 1; if (b > 1) b = 1
              A[i] = a; B[i] = b
              const acc = b > a
              let v = acc ? b : a
              v = v * (2 - v) * calm[i]!
              b32[i] = v > BAYER[(y & 7) * 8 + (x & 7)]! ? (acc ? g.acc : g.mark) : 0
          }
        }
        }
      },
    }
  },
})
