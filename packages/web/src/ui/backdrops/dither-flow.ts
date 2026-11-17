import { BAYER } from "./bayer.js"
import { unit } from "./engine.js"
import { calmAt, clamp, smooth, snoiseBatch } from "./noise.js"
import { Grid, cellLayout } from "./pixels.js"
import { hexRgb, mixRgb, pack, type Pointer, type Scene, type Sketch } from "./sketch.js"

const SPEED = 1, PX = 3, FPS = 8
/** Feature size in noise units per logical px, and the domain-warp strength (0 is plain clouds, ~1.5 silk folds). */
const SCALE = 0.0012, WARP = 1.25, CALM = 0.18, STEP = 5
const ACCENT = { dark: "#6ea8ff", light: "#2457d6" }, ACCENT_AMOUNT = 0.85
/** Brightest-dot alpha relative to the layer opacity; the lab used 0.30 of a light ink, so a dark page needs a little less. */
const TONE = { dark: 0.8, light: 1 }

/** Dither flow v2: a domain-warped three-octave simplex field, lit by three drifting lights, ordered-dithered in two tones with sparse accent dots. */
export function createDitherFlow(): Sketch {
  let width = 0, height = 0, g: Grid | null = null, key = "", gw = 0, gh = 0, V = new Float32Array(0), c0 = new Int32Array(0), cf = new Float32Array(0), S = new Float32Array(0)
  // Per lattice point: noise coordinates and the light-space position never move, so they are filled once per size; the rest are stage buffers reused every frame.
  let SU = new Float64Array(0), SV = SU, NX = SU, NY = SU, QX = SU, QY = SU, F1 = SU, F2 = SU, F3 = SU, XS = SU, YS = SU
  let dim = 0, bright = 0, accent = 0, lx = 0, ly = 0
  const lw = () => width / unit(width), lh = () => height / unit(width)
  const build = (c: CanvasRenderingContext2D, scene: Scene) => {
    const { u, cs, W, H } = cellLayout(PX, scene.dpr, width, height)
    g = new Grid(W, H, cs, u, 1, 0, 0, c, scene.lowres)
    gw = Math.ceil(W / STEP) + 2; gh = Math.ceil(H / STEP) + 2; V = new Float32Array(gw * gh); S = new Float32Array(gw * gh)
    SU = new Float64Array(gw * gh); SV = new Float64Array(SU.length); NX = new Float64Array(SU.length); NY = new Float64Array(SU.length)
    QX = new Float64Array(SU.length); QY = new Float64Array(SU.length); F1 = new Float64Array(SU.length); F2 = new Float64Array(SU.length); F3 = new Float64Array(SU.length); XS = new Float64Array(SU.length); YS = new Float64Array(SU.length)
    c0 = new Int32Array(W); cf = new Float32Array(W)
    for (let i = 0; i < W; i++) { const k = i / STEP; c0[i] = k | 0; cf[i] = k - (k | 0) }
    // The part of the field that never moves (the clear zone behind the composer and the edge fade) is computed once per size.
    const vw = lw(), vh = lh()
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const x = i * STEP * cs, y = j * STEP * cs, ex = Math.min(x, vw - x, y, vh - y) / 70
      SU[j * gw + i] = x * SCALE; SV[j * gw + i] = y * SCALE; NX[j * gw + i] = x / vw; NY[j * gw + i] = y / vh
      S[j * gw + i] = calmAt(x, y, CALM, vw, vh) * (0.55 + 0.45 * smooth(0, 1, ex)) * 1.25
    }
    const tone = scene.dark ? TONE.dark : TONE.light
    dim = pack(scene.ink, tone * 0.5); bright = pack(scene.ink, tone)
    accent = pack(mixRgb(scene.ink, hexRgb(scene.dark ? ACCENT.dark : ACCENT.light), ACCENT_AMOUNT), tone)
  }
  return {
    fps: FPS, still: 8, cell: PX, pointer: true,
    resize(w, h) { width = w; height = h; g = null },
    frame(c, _w, _h, seconds, pointer: Pointer, scene) {
      const next = `${scene.ink.join()}|${scene.dark}|${scene.dpr}`
      if (!g || next !== key) { key = next; build(c, scene) }
      const grid = g!, vw = lw(), vh = lh(), t = seconds * SPEED
      const tx = pointer.fresh ? clamp(pointer.x / width * 2 - 1, -1, 1) : 0, ty = pointer.fresh ? clamp(pointer.y / height * 2 - 1, -1, 1) : 0
      lx += (tx - lx) * 0.05; ly += (ty - ly) * 0.05
      const l1x = 0.5 + 0.26 * Math.sin(t * 0.047) + lx * 0.06, l1y = -0.10 + 0.07 * Math.sin(t * 0.031 + 1) + ly * 0.03
      const l2x = 0.02 + 0.08 * Math.sin(t * 0.041 + 2), l2y = 0.88 + 0.10 * Math.sin(t * 0.029)
      const l3x = 0.98 + 0.06 * Math.sin(t * 0.037 + 4), l3y = 0.80 + 0.12 * Math.sin(t * 0.033 + 3)
      const n = gw * gh
      for (let m = 0; m < n; m++) { XS[m] = SU[m]! * 0.8 + t * 0.045; YS[m] = SV[m]! * 0.8 - t * 0.030 }
      snoiseBatch(QX, XS, YS, n)
      for (let m = 0; m < n; m++) { XS[m] = SU[m]! * 0.8 - t * 0.035 + 7.1; YS[m] = SV[m]! * 0.8 + t * 0.040 + 3.7 }
      snoiseBatch(QY, XS, YS, n)
      for (let m = 0; m < n; m++) { XS[m] = SU[m]! + WARP * QX[m]! + t * 0.015; YS[m] = SV[m]! + WARP * QY[m]! - t * 0.010 }
      snoiseBatch(F1, XS, YS, n)
      for (let m = 0; m < n; m++) { XS[m] = 2.1 * SU[m]! + WARP * 1.2 * QY[m]! - t * 0.030 + 11; YS[m] = 2.1 * SV[m]! - WARP * 1.2 * QX[m]! + t * 0.020 }
      snoiseBatch(F2, XS, YS, n)
      for (let m = 0; m < n; m++) { XS[m] = 4.4 * SU[m]! + WARP * QX[m]! * 1.5 + t * 0.05 + 23; YS[m] = 4.4 * SV[m]! + WARP * QY[m]! * 1.5 - t * 0.04 }
      snoiseBatch(F3, XS, YS, n)
      for (let m = 0; m < n; m++) {
        const nx = NX[m]!, ny = NY[m]!, f2 = F2[m]!
        const f01 = clamp(0.5 + 0.62 * (0.60 * F1[m]! + 0.28 * f2 + 0.12 * F3[m]!), 0, 1)
        const ridge = 1 - Math.abs(f2) * 1.6
        const shaped = smooth(0.34, 0.82, f01) * (0.80 + 0.45 * Math.max(0, ridge) ** 3)
        const d1 = ((nx - l1x) / 0.55) ** 2 + ((ny - l1y) / 0.62) ** 2, d2 = ((nx - l2x) / 0.34) ** 2 + ((ny - l2y) / 0.45) ** 2, d3 = ((nx - l3x) / 0.34) ** 2 + ((ny - l3y) / 0.45) ** 2
        const lit = Math.min(1, Math.exp(-d1 * 0.9) + 0.55 * Math.exp(-d2) + 0.55 * Math.exp(-d3))
        V[m] = shaped * (0.10 + 0.95 * lit) * S[m]!
      }
      const { W, H, b32 } = grid
      for (let j = 0; j < H; j++) {
        const k = j / STEP, r0 = (k | 0) * gw, r1 = r0 + gw, fy = k - (k | 0), bj = (j & 7) << 3, row = j * W
        for (let i = 0; i < W; i++) {
          const cc = c0[i]!, fx = cf[i]!
          const a = V[r0 + cc]! + (V[r0 + cc + 1]! - V[r0 + cc]!) * fx, b = V[r1 + cc]! + (V[r1 + cc + 1]! - V[r1 + cc]!) * fx
          const val = Math.min(0.8, a + (b - a) * fy), th = BAYER[bj | (i & 7)]!
          b32[row + i] = val <= th ? 0 : val > 0.34 + 0.66 * th ? (val > 0.62 && th < (val - 0.62) * 0.9 ? accent : bright) : dim
        }
      }
      grid.present(c)
    },
  }
}
