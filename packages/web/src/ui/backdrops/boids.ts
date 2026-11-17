import { hyp } from "./noise.js"
import { seeded } from "./engine.js"
import type { Grid } from "./pixels.js"

/** One depth layer of a shoal (lengths in logical px, speed in px/s), back to front. */
export interface ShoalLayer { n: number; len: number; wid: number; speed: number; alpha: number; trail: number; turn: number; groups: number }
export interface Fish { x: number; y: number; vx: number; vy: number; g: number; ph: number; sf: number; acc: boolean; wob: number }
interface Attractor { ax: number; ay: number; px: number; py: number; x: number; y: number }
export interface ShoalLayerState { L: ShoalLayer; len: number; wid: number; sp: number; atts: Attractor[]; fish: Fish[]; decay: number; R2: number; S2: number; turn: number }

/** Builds the layers: each shoal follows slow Lissajous attractors, one per group. */
export function createShoal(g: Grid, spec: readonly ShoalLayer[], fps: number, accentShare: number, accentLayer: number): ShoalLayerState[] {
  const R = seeded(7), { W, H, CS } = g
  return spec.map((L, li) => {
    const len = L.len / CS, wid = L.wid / CS, sp = L.speed / CS
    const atts: Attractor[] = []
    for (let k = 0; k < L.groups; k++) { const om = (0.8 * sp / (0.4 * W)) * (0.7 + R() * 0.6); atts.push({ ax: om * (0.8 + R() * 0.5), ay: om * (1.3 + R() * 0.8), px: k / L.groups * 6.283 + R() * 0.8, py: R() * 6.28, x: 0, y: 0 }) }
    const fish: Fish[] = []
    const n = g.count(L.n, L.groups)
    for (let i = 0; i < n; i++) {
      const a = R() * 6.28, sx = W * (0.15 + 0.7 * R()), sy = H * (0.15 + 0.7 * R())
      fish.push({ x: sx, y: sy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: i % L.groups, ph: R() * 6.28, sf: 0.85 + R() * 0.3, acc: li === accentLayer && R() < accentShare, wob: R() * 6.28 })
    }
    return { L, len, wid, sp, atts, fish, decay: Math.exp(-(1 / fps) / L.trail), R2: (len * 4.2) ** 2, S2: (len * 1.7) ** 2, turn: L.turn }
  })
}

/** One boid step for every layer: separation, alignment, cohesion, a pull to the group attractor, wall avoidance and a pointer swirl. */
export function stepShoal(g: Grid, layers: ShoalLayerState[], dt: number) {
  const { W, H, CS, ptr, time } = g
  for (const ly of layers) {
    for (const a of ly.atts) { a.x = W * (0.5 + 0.44 * Math.sin(a.ax * time + a.px)); a.y = H * (0.5 + 0.40 * Math.sin(a.ay * time + a.py)) }
    const F = ly.fish, n = F.length
    for (let i = 0; i < n; i++) {
      const f = F[i]!
      let ax = 0, ay = 0, cx = 0, cy = 0, sx = 0, sy = 0, c = 0
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const o = F[j]!, dx = o.x - f.x, dy = o.y - f.y, d2 = dx * dx + dy * dy
        if (d2 < ly.R2) {
          c++
          const os = hyp(o.vx, o.vy) || 1
          ax += o.vx / os; ay += o.vy / os; cx += dx; cy += dy
          if (d2 < ly.S2 && d2 > 0.01) { const k = 1 / d2; sx -= dx * k; sy -= dy * k }
        }
      }
      let dx = 0, dy = 0
      const sm = hyp(sx, sy)
      if (sm > 0) { dx += sx / sm * 2.4; dy += sy / sm * 2.4 }
      if (c) { const am = hyp(ax, ay) || 1; dx += ax / am * 1.7; dy += ay / am * 1.7; const cm = hyp(cx, cy) || 1; dx += cx / cm * 0.3; dy += cy / cm * 0.3 }
      const t = ly.atts[f.g]!, tx = t.x - f.x, ty = t.y - f.y, tm = hyp(tx, ty) || 1
      dx += tx / tm * 0.7; dy += ty / tm * 0.7
      f.wob += dt * 0.4; dx += Math.cos(f.wob * 2.3) * 0.1; dy += Math.sin(f.wob * 1.7) * 0.1
      const m = ly.len * 1.2
      if (f.x < m) dx += 2; if (f.x > W - m) dx -= 2; if (f.y < m) dy += 2; if (f.y > H - m) dy -= 2
      if (ptr.act > 0.02) {
        const qx = f.x - ptr.sx, qy = f.y - ptr.sy, pd = hyp(qx, qy), r = 300 / CS
        if (pd < r && pd > 1) { const w = (1 - pd / r) * ptr.act * 0.9; dx += -qy / pd * w; dy += qx / pd * w }
      }
      const dm = hyp(dx, dy) || 1, sp = ly.sp * f.sf * (1 + 0.12 * Math.sin(f.wob * 3))
      const k = Math.min(1, ly.turn * dt)
      f.vx += (dx / dm * sp - f.vx) * k; f.vy += (dy / dm * sp - f.vy) * k
      f.x += f.vx * dt; f.y += f.vy * dt; f.ph += dt * (5 + sp * 0.35 / (ly.len / 10)) * 0.9
    }
  }
}
