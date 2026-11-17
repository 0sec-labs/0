import { seeded } from "./engine.js"
import type { Grid } from "./pixels.js"

/** Cosine table (4096 steps, so under 0.0008 rad of error: far below what a flow field shows): the wave loop runs 13 times per particle per step. */
const COS_N = 4096, COS_MASK = COS_N - 1, COS_K = COS_N / 6.283185307179586, COS = Float32Array.from({ length: COS_N }, (_, i) => Math.cos(i / COS_K))

export interface Plume { t: number; x: number; y: number; age: number; life: number; k: number }
interface Wave { kx: number; ky: number; nx: number; ny: number; w: number; ph: number; a: number }

export interface InkFlow { parts: Plume[]; advance(dt: number): void }
export interface InkOptions { particles: number; flow: number; wind: number; life: number; fps: number }

/**
 * Two jets (plume 0 from the lower left, plume 1 from the upper right) carried by a divergence-free flow: a sum of 13 travelling
 * plane waves, each pushing along its own perpendicular. Speeds are logical px/s; positions are cells.
 */
export function createInkFlow(g: Grid, o: InkOptions): InkFlow {
  const { W, H, CS } = g, R = seeded(41), r = seeded(3), waves: Wave[] = []
  for (let i = 0; i < 13; i++) {
    const lam = (70 + Math.pow(r(), 0.8) * 330) / CS, th = r() * 6.283, k = 6.283 / lam
    waves.push({ kx: Math.cos(th) * k, ky: Math.sin(th) * k, nx: Math.cos(th), ny: Math.sin(th), w: (0.18 + r() * 0.28) * (r() < 0.5 ? -1 : 1), ph: r() * 6.283, a: Math.pow(lam * CS / 200, 0.55) / Math.sqrt(13) * o.flow / CS * 1.5 })
  }
  const nozzles = [{ x: -W * 0.03, y: H * 0.88, dx: 1, dy: -0.35 }, { x: W * 1.03, y: H * 0.14, dx: -1, dy: 0.35 }]
  const nozzle = (t: number) => nozzles[t]!
  const spawn = (p: Plume) => { const n = nozzle(p.t); p.x = n.x + (R() - 0.5) * 14 / CS; p.y = n.y + (R() - 0.5) * 30 / CS; p.age = 0; p.life = o.life * (0.6 + R() * 0.8); p.k = 0.6 + R() * 0.8 }
  const parts: Plume[] = []
  for (let t = 0; t < 2; t++) for (let i = 0, n = g.count(o.particles, 200); i < n; i++) { const p = { t, x: 0, y: 0, age: 0, life: 0, k: 0 }; spawn(p); p.age = R() * p.life; parts.push(p) }
  // Wave parameters as flat typed arrays: the inner loop below runs 13 times per particle per step.
  const NW = waves.length, WK = new Float64Array(NW * 2), WN = new Float64Array(NW * 2), WA = new Float64Array(NW), WP = new Float64Array(NW), WW = new Float64Array(NW)
  waves.forEach((w, i) => { WK[i * 2] = w.kx; WK[i * 2 + 1] = w.ky; WN[i * 2] = w.nx; WN[i * 2 + 1] = w.ny; WA[i] = w.a; WW[i] = w.w; WP[i] = w.ph })
  const phase = new Float64Array(NW), WKS = WK.map(k => k * COS_K)
  const advance = (dt: number) => {
    const wind = o.wind / CS, { ptr, time } = g
    for (let i = 0; i < NW; i++) phase[i] = (WP[i]! - WW[i]! * time) * COS_K
    for (const p of parts) {
      p.age += dt
      if (p.age > p.life || p.x < -12 || p.x > W + 12 || p.y < -12 || p.y > H + 12) spawn(p)
      let vx = 0, vy = 0
      for (let i = 0; i < NW; i++) { const c = COS[((WKS[i * 2]! * p.x + WKS[i * 2 + 1]! * p.y + phase[i]!) | 0) & COS_MASK]! * WA[i]!; vx -= WN[i * 2 + 1]! * c; vy += WN[i * 2]! * c }
      const n = nozzle(p.t), boost = Math.exp(-p.age / 1.6) * 2.4
      vx += n.dx * (wind + wind * boost); vy += n.dy * (wind * 0.8 + wind * boost * 0.5)
      if (ptr.act > 0.02) { const dx = p.x - ptr.sx, dy = p.y - ptr.sy, d2 = dx * dx + dy * dy, s = 110 / CS, gain = Math.exp(-d2 / (2 * s * s)) * ptr.act * 28 / CS, d = Math.sqrt(d2) || 1; vx += -dy / d * gain * 8; vy += dx / d * gain * 8 }
      p.x += vx * dt * p.k * 0.5 + vx * dt * 0.5; p.y += vy * dt * p.k * 0.5 + vy * dt * 0.5
    }
  }
  for (let s = 0, n = Math.round(13 * o.fps); s < n; s++) advance(1 / o.fps)
  return { parts, advance }
}
