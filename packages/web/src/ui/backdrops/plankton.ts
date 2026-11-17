import { hyp } from "./noise.js"
import { BAYER } from "./bayer.js"
import { seeded } from "./engine.js"
import { pixelSketch } from "./pixel-sketch.js"
import type { Sketch } from "./sketch.js"

const FPS = 16, CALM = 0.5, MOTES = 120, JELLIES = 4, ACCENT_MOTES = 0.14
interface Mote { z: number; x: number; y: number; sig: number; amp: number; vy: number; ph: number; pf: number; wx: number; acc: boolean }
interface Tentacle { ox: number; pts: { x: number; y: number }[]; seg: number; len: number }
interface Jelly { rx: number; big: number; x: number; y: number; per: number; ph: number; vy: number; wx: number; amp: number; tent: Tentacle[]; rxe: number; rye: number }

/** Glow falloff table: bright core and a long soft skirt, indexed by squared distance over radius squared. */
const PROFILE = (() => { const p = new Float32Array(1024); for (let q = 0; q < 1024; q++) { const u = Math.sqrt(q / 1023); p[q] = Math.pow(1 - u, 1.7) * 0.5 + Math.exp(-u * 11) * 0.9 } return p })()

export const createPlankton = (): Sketch => pixelSketch({
  fps: FPS, cell: 3, still: 20, trail: 0,
  palette: scene => ({ accent: scene.dark ? [88, 222, 204] : [10, 120, 112], tone: 1 }),
  create(g) {
    const { W, H, CS } = g, R = seeded(11), Fn = new Float32Array(W * H), Fa = new Float32Array(W * H), calm = g.calm(CALM)
    const spawnMote = (m: Mote, anywhere: boolean) => {
      const z = Math.pow(R(), 1.4)
      m.z = z; m.x = R() * W; m.y = anywhere ? R() * (H + 20) : H + 20 + R() * 20
      m.sig = 4 + z * 8; m.amp = (0.55 + 0.6 * (1 - z)) * (0.7 + R() * 0.5)
      m.vy = -(5 + 9 * z + R() * 3) / CS; m.ph = R() * 6.28; m.pf = 0.12 + R() * 0.2; m.wx = R() * 6.28; m.acc = R() < ACCENT_MOTES
    }
    const spawnJelly = (j: Jelly, anywhere: boolean) => {
      j.rx = 20 + R() * 26; j.big = (j.rx - 20) / 26; j.x = (0.08 + 0.84 * R()) * W; j.y = anywhere ? (0.1 + 0.8 * R()) * H : H + j.rx * 5
      j.per = 4.2 + R() * 2.4; j.ph = R() * 6.28; j.vy = 0; j.wx = R() * 6.28; j.amp = 0.55 + 0.25 * (1 - j.big)
      j.tent = []
      const nt = 7 + (R() * 3 | 0)
      for (let t = 0; t < nt; t++) {
        const L = 18, pts: { x: number; y: number }[] = []
        for (let k = 0; k < L; k++) pts.push({ x: j.x, y: j.y + k * 2 })
        j.tent.push({ ox: (t / (nt - 1)) * 2 - 1, pts, seg: j.rx * (0.14 + R() * 0.05), len: L - (t % 3 === 1 ? 4 : 0) })
      }
    }
    const motes: Mote[] = [], jellies: Jelly[] = []
    for (let i = 0, n = g.count(MOTES, 12); i < n; i++) { const m = {} as Mote; spawnMote(m, true); motes.push(m) }
    const nj = g.count(JELLIES, 2)
    for (let i = 0; i < nj; i++) { const j = { rxe: 0, rye: 0 } as Jelly; spawnJelly(j, true); j.y = H * (0.12 + 0.8 * i / nj); j.x = W * (0.1 + 0.8 * ((i * 0.618) % 1)); spawnJelly(j, true); jellies.push(j) }
    jellies.forEach((j, i) => { j.y = H * (0.1 + 0.85 * ((i * 0.382 + 0.1) % 1)); j.x = W * (0.08 + 0.84 * ((i * 0.618 + 0.2) % 1)) })

    const halo = (F: Float32Array, cx: number, cy: number, rad: number, a: number) => {
      const r = Math.ceil(rad), x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r)), k = 1023 / (rad * rad)
      if (x1 < x0 || y1 < y0) return
      g.touchBox(x0, y0, x1, y1, 1)
      for (let y = y0; y <= y1; y++) { const dy = y - cy, dy2 = dy * dy; for (let x = x0; x <= x1; x++) { const dx = x - cx, q = (dx * dx + dy2) * k; if (q >= 1023) continue; F[y * W + x] += a * PROFILE[q | 0]! } }
    }
    const seg = (F: Float32Array, x0: number, y0: number, x1: number, y1: number, a0: number, a1: number) => {
      const n = Math.max(1, Math.ceil(hyp(x1 - x0, y1 - y0) / 0.8))
      for (let i = 0; i <= n; i++) {
        const t = i / n, x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t)
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        const v = a0 + (a1 - a0) * t, k = y * W + x
        if (F[k]! < v) F[k] = v
        g.blk[(y >> 4) * g.BW + (x >> 4)] = g.FR + 1
      }
    }
    return {
      step(dt) {
        const { ptr, time } = g
        for (const m of motes) {
          m.ph += dt * m.pf * 6.28; m.wx += dt * 0.3; m.y += m.vy * dt; m.x += Math.sin(m.wx + m.ph) * 4 * dt / CS * 3
          if (ptr.act > 0.02) { const dx = m.x - ptr.sx, dy = m.y - ptr.sy, d = hyp(dx, dy), r = 200 / CS; if (d < r && d > 1) { const w = (1 - d / r) * ptr.act * 14 * dt; m.x += dx / d * w; m.y += dy / d * w } }
          if (m.y < -m.sig * 2) spawnMote(m, false)
        }
        for (const j of jellies) {
          j.ph += dt / j.per
          const c = 0.5 + 0.5 * Math.sin(j.ph * 6.283), thrust = Math.pow(Math.max(0, Math.cos(j.ph * 6.283 - 0.6)), 2)
          const vt = -(10 + 26 * thrust) / CS * 3 * (0.6 + 0.4 * (1 - j.big))
          j.vy += (vt - j.vy) * Math.min(1, dt * 2.2)
          j.y += j.vy * dt; j.wx += dt * 0.25; j.x += Math.sin(j.wx) * 3 * dt / CS * 3
          const rx = j.rx * (1 - 0.16 * c), ry = j.rx * 0.72 * (1 + 0.1 * c)
          j.rxe = rx; j.rye = ry
          for (const T of j.tent) {
            const p = T.pts
            p[0]!.x = j.x + T.ox * rx * 0.85; p[0]!.y = j.y + ry * 0.06
            for (let k = 1; k < T.len; k++) {
              const a = p[k - 1]!, b = p[k]!
              const tx = a.x + Math.sin(time * 0.8 + k * 0.55 + T.ox * 3) * T.seg * 0.9 * Math.min(1, k / 4), ty = a.y + T.seg
              b.x += (tx - b.x) * 0.28; b.y += (ty - b.y) * 0.28
              const dx = b.x - a.x, dy = b.y - a.y, d = hyp(dx, dy) || 1
              if (d > T.seg * 1.08) { b.x = a.x + dx / d * T.seg * 1.08; b.y = a.y + dy / d * T.seg * 1.08 }
            }
          }
          if (j.y < -j.rx * 6) spawnJelly(j, false)
        }
      },
      render() {
        const time = g.time
        for (const m of motes) { const tw = 0.62 + 0.38 * Math.sin(m.ph); halo(m.acc ? Fa : Fn, m.x, m.y, m.sig * (1 + 0.1 * Math.sin(m.ph * 0.7)), m.amp * tw * (m.sig < 3 ? 1.5 : 1)) }
        for (const j of jellies) {
          const F = Fa, rx = j.rxe, ry = j.rye, a = j.amp
          halo(F, j.x, j.y + ry * 0.3, rx * 1.75, a * 0.8)
          const x0 = Math.max(0, Math.floor(j.x - rx)), x1 = Math.min(W - 1, Math.ceil(j.x + rx)), y0 = Math.max(0, Math.floor(j.y - ry)), y1 = Math.min(H - 1, Math.ceil(j.y + ry * 0.12))
          if (x1 >= x0 && y1 >= y0) g.touchBox(x0, y0, x1, y1, 1)
          for (let y = y0; y <= y1; y++) {
            const v = (y - j.y) / ry
            for (let x = x0; x <= x1; x++) {
              const u = (x - j.x) / rx, r2 = u * u + v * v
              if (r2 > 1 || v > 0.1) continue
              const r = Math.sqrt(r2)
              let q = 0.16 + 0.5 * Math.pow(r, 5) + 0.5 * Math.exp(-((r - 0.4) * (r - 0.4)) / 0.006) * (v < -0.05 ? 1 : 0) + (v > -0.1 ? 0.35 : 0)
              if (q > 1) q = 1
              const i = y * W + x, val = q * a * 1.25
              if (F[i]! < val) F[i] = val
            }
          }
          for (const T of j.tent) {
            const p = T.pts, n = T.len
            for (let k = 1; k < n; k++) {
              const f0 = Math.pow(1 - (k - 1) / n, 0.9) * a * (0.8 + 0.2 * Math.sin(time * 1.1 - k * 0.9 + T.ox * 5)), f1 = Math.pow(1 - k / n, 0.9) * a * (0.8 + 0.2 * Math.sin(time * 1.1 - (k + 1) * 0.9 + T.ox * 5))
              seg(F, p[k - 1]!.x, p[k - 1]!.y, p[k]!.x, p[k]!.y, f0 * 1.3, f1 * 1.3)
            }
          }
        }
        {
        const { W, H, BW, BH, blk, FR, b32 } = g
        for (let by = 0; by < BH; by++) for (let bx = 0; bx < BW; bx++) {
          if (blk[by * BW + bx]! < FR) continue
          const y1 = Math.min(H, by * 16 + 16), x1 = Math.min(W, bx * 16 + 16)
          for (let y = by * 16; y < y1; y++) for (let x = bx * 16, i = y * W + x; x < x1; x++, i++) {
              const n = Fn[i]!, a = Fa[i]!
              if (n === 0 && a === 0) { b32[i] = 0; continue }
              Fn[i] = 0; Fa[i] = 0
              const acc = a > n, v = (acc ? a : n) * calm[i]!
              b32[i] = v > BAYER[(y & 7) * 8 + (x & 7)]! ? (acc ? g.acc : g.mark) : 0
          }
        }
        }
      },
    }
  },
})
