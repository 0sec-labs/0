import { BAND } from "./kinds.js"
import { smooth, snoiseBatch } from "./noise.js"
import { Grid, cellLayout } from "./pixels.js"
import { pack, type Scene, type Sketch } from "./sketch.js"

/** Logical px per dot, as the original shader (one backing pixel per 3x3 css px). The frame cap is slow (6 fps) because the field drifts only about 30 px a second and the dot pattern itself is fixed to the screen. */
const PX = 3, FPS = 6, STILL = 8
/** The original shader's field: two simplex octaves at 0.001 per px / 1.3, drifting at `SPEED` noise units per second, thresholded by a 4x4 Bayer matrix. */
const FIELD = 0.001 / 1.3, SPEED = 0.075
/** Lattice spacing in cells for the noise (the field is smooth over hundreds of px, so it is sampled sparsely and interpolated). */
const STEP = 4
/** Brightest-dot alpha relative to the layer opacity: the original used 0.15 on a dark page and 0.12 on a light one. */
const TONE = { dark: 1, light: 0.8 }
const B4 = Float32Array.from([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5], v => v / 16)

/** The original radial mask (`ellipse 150% 135% at 50% 110%`, clear to 48%, 0.4 at 70%, 0.9 from 94%): glow from the top edge and corners, nothing in the lower middle. */
const maskAt = (x: number, y: number, w: number, h: number) => {
  const r = Math.hypot((x - w * 0.5) / (1.5 * w), (y - 1.1 * h) / (1.35 * h))
  return r <= 0.48 ? 0 : r <= 0.7 ? 0.4 * (r - 0.48) / 0.22 : r <= 0.94 ? 0.4 + 0.5 * (r - 0.7) / 0.24 : 0.9
}

/**
 * Dither: the original new-thread backdrop. A slow simplex field ordered-dithered into dots, shown only in the top part of the screen and
 * fading out downward. The sketch's box is that top band (`BAND` of the screen height); the mask is baked per cell once, so a frame is a
 * sparse noise lattice plus one threshold per dot.
 */
export function createDitherTop(): Sketch {
  let width = 0, height = 0, g: Grid | null = null, key = "", gw = 0, gh = 0, V = new Float32Array(0), word = new Uint32Array(0), c0 = new Int32Array(0), cf = new Float32Array(0), x0 = 0, y0 = 0
  // Lattice noise coordinates (fixed per size) and stage buffers, reused every frame so a frame allocates nothing.
  let PX0 = new Float64Array(0), PY0 = PX0, XS = PX0, YS = PX0, N1 = PX0, N2 = PX0
  const build = (c: CanvasRenderingContext2D, scene: Scene) => {
    const { u, cs, W, H } = cellLayout(PX, scene.dpr, width, height)
    g = new Grid(W, H, cs, u, 1, 0, 0, c, scene.lowres)
    gw = Math.ceil(W / STEP) + 2; gh = Math.ceil(H / STEP) + 2; V = new Float32Array(gw * gh)
    PX0 = new Float64Array(gw * gh); PY0 = new Float64Array(PX0.length); XS = new Float64Array(PX0.length); YS = new Float64Array(PX0.length); N1 = new Float64Array(PX0.length); N2 = new Float64Array(PX0.length)
    c0 = new Int32Array(W); cf = new Float32Array(W)
    for (let i = 0; i < W; i++) { const k = i / STEP; c0[i] = k | 0; cf[i] = k - (k | 0) }
    const vw = width / u, vh = height / u / BAND, tone = scene.still ? 1 : scene.dark ? TONE.dark : TONE.light
    x0 = vw / 2; y0 = vh / 2
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { PX0[j * gw + i] = (i * STEP * cs - x0) * FIELD; PY0[j * gw + i] = (y0 - j * STEP * cs) * FIELD }
    word = new Uint32Array(W * H)
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const y = (j + 0.5) * cs
      // Light pages also fade the top 22% toward the panel, as the original did (70% panel colour at the very top edge).
      const ramp = scene.dark ? 1 : 0.3 + 0.7 * Math.min(1, y / (0.22 * vh))
      const alpha = maskAt((i + 0.5) * cs, y, vw, vh) * ramp * tone
      word[j * W + i] = alpha < 1 / 255 ? 0 : pack(scene.ink, alpha)
    }
  }
  return {
    fps: FPS, still: STILL, cell: PX, band: BAND,
    resize(w, h) { width = w; height = h; g = null },
    frame(c, _w, _h, seconds, _pointer, scene) {
      const next = `${scene.ink.join()}|${scene.dark}|${scene.dpr}|${scene.still}`
      if (!g || next !== key) { key = next; build(c, scene) }
      const grid = g!, t = seconds * SPEED, { W, H, b32 } = grid
      const n = gw * gh
      for (let m = 0; m < n; m++) { XS[m] = PX0[m]!; YS[m] = PY0[m]! - 0.3 * t }
      snoiseBatch(N1, XS, YS, n)
      for (let m = 0; m < n; m++) { XS[m] = 2 * PX0[m]!; YS[m] = 2 * PY0[m]! + 0.32 * t }
      snoiseBatch(N2, XS, YS, n)
      for (let m = 0; m < n; m++) V[m] = smooth(0.3, 0.9, 0.5 + 0.5 * (0.5 * N1[m]! + 0.5 * N2[m]!))
      for (let j = 0; j < H; j++) {
        const k = j / STEP, r0 = (k | 0) * gw, r1 = r0 + gw, fy = k - (k | 0), bj = (j & 3) << 2, row = j * W
        for (let i = 0; i < W; i++) {
          const w = word[row + i]!
          if (!w) { b32[row + i] = 0; continue }
          const cc = c0[i]!, fx = cf[i]!
          const a = V[r0 + cc]! + (V[r0 + cc + 1]! - V[r0 + cc]!) * fx, b = V[r1 + cc]! + (V[r1 + cc + 1]! - V[r1 + cc]!) * fx
          b32[row + i] = a + (b - a) * fy >= 1 - B4[bj | (i & 3)]! ? w : 0
        }
      }
      grid.present(c)
    },
  }
}
