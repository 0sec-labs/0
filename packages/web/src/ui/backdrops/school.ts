import { hyp } from "./noise.js"
import { stepShoal, createShoal, type Fish, type ShoalLayer, type ShoalLayerState } from "./boids.js"
import { BAYER } from "./bayer.js"
import { pixelSketch } from "./pixel-sketch.js"
import { decayFrames, type Grid } from "./pixels.js"
import type { Sketch } from "./sketch.js"

const FPS = 15
/** Back to front: huge slow dim fish behind, small quick bright ones in front. Lengths and widths in logical px, speed in px/s. */
const LAYERS: readonly ShoalLayer[] = [
  { n: 11, len: 130, wid: 38, speed: 24, alpha: 0.58, trail: 0.16, turn: 0.9, groups: 3 },
  { n: 46, len: 50, wid: 15, speed: 46, alpha: 0.82, trail: 0.12, turn: 1.5, groups: 4 },
  { n: 70, len: 28, wid: 8.5, speed: 74, alpha: 1, trail: 0.1, turn: 2.2, groups: 4 },
]
const CALM = 0.45, ACCENT_SHARE = 0.2, KEEP = decayFrames(1, Math.exp(-(1 / FPS) / 0.16), 0.02) + 2

/** A tapered fish with a tail beat, plotted as max-alpha points into `b`. */
function drawFish(g: Grid, b: Float32Array, f: Fish, ly: ShoalLayerState, a: number) {
  const { W, H, blk, BW } = g
  const s = hyp(f.vx, f.vy) || 1, hx = f.vx / s, hy = f.vy / s, nx = -hy, ny = hx, Lc = ly.len, Wc = ly.wid
  const plot = (px: number, py: number, v: number) => {
    const x = Math.round(px), y = Math.round(py)
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = y * W + x
    if (b[i]! < v) b[i] = v
    blk[(y >> 4) * BW + (x >> 4)] = g.FR + KEEP
  }
  const steps = Math.max(4, Math.ceil(Lc * 1.3))
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    let w = t < 0.3 ? Math.sqrt(t / 0.3) * 0.92 + 0.08 : Math.pow(1 - (t - 0.3) / 0.7, 1.25) * 0.9 + 0.06
    w *= Wc * 0.5
    if (t > 0.86) w += Wc * 0.38 * (t - 0.86) / 0.14
    const wig = Math.sin(f.ph - t * 4.4) * Wc * 0.55 * t * t, cx = f.x - hx * t * Lc + nx * wig, cy = f.y - hy * t * Lc + ny * wig
    for (let u = -w; u <= w + 0.01; u += 0.7) plot(cx + nx * u, cy + ny * u, a * (1 - 0.3 * Math.abs(u) / (w + 0.6)) * (1 - 0.35 * t))
    if (w < 0.8) plot(cx, cy, a)
  }
}

export const createSchool = (): Sketch => pixelSketch({
  fps: FPS, cell: 3, still: 14, trail: 5,
  palette: scene => ({ accent: scene.dark ? [88, 222, 204] : [10, 120, 112], tone: 1 }),
  create(g) {
    const layers: ShoalLayerState[] = createShoal(g, LAYERS, FPS, ACCENT_SHARE, 1)
    const bufs = layers.map(() => new Float32Array(g.W * g.H)), bufA = new Float32Array(g.W * g.H), calm = g.calm(CALM)
    const [b0, b1, b2] = bufs as [Float32Array, Float32Array, Float32Array]
    const d0 = layers[0]!.decay, d1 = layers[1]!.decay, d2 = layers[2]!.decay
    return {
      step: dt => stepShoal(g, layers, dt),
      render() {
        for (let li = 0; li < layers.length; li++) { const ly = layers[li]!; for (const f of ly.fish) drawFish(g, f.acc ? bufA : bufs[li]!, f, ly, ly.L.alpha) }
        {
        const { W, H, BW, BH, blk, FR, b32 } = g
        for (let by = 0; by < BH; by++) for (let bx = 0; bx < BW; bx++) {
          if (blk[by * BW + bx]! < FR) continue
          const y1 = Math.min(H, by * 16 + 16), x1 = Math.min(W, bx * 16 + 16)
          for (let y = by * 16; y < y1; y++) for (let x = bx * 16, i = y * W + x; x < x1; x++, i++) {
              let a = b0[i]!, b = b1[i]!, c = b2[i]!, e = bufA[i]!
              if (a === 0 && b === 0 && c === 0 && e === 0) { b32[i] = 0; continue }
              a *= d0; b *= d1; c *= d2; e *= d1
              if (a < 0.02) a = 0; if (b < 0.02) b = 0; if (c < 0.02) c = 0; if (e < 0.02) e = 0
              b0[i] = a; b1[i] = b; b2[i] = c; bufA[i] = e
              let v = a > b ? a : b
              if (c > v) v = c
              let acc = false
              if (e > v) { v = e; acc = true }
              b32[i] = v > 0 && v * calm[i]! > BAYER[(y & 7) * 8 + (x & 7)]! ? (acc ? g.acc : g.mark) : 0
          }
        }
        }
      },
    }
  },
})
