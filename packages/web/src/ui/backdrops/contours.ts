import { drawTallies, tallyAnchors } from "./contour-tally.js"
import { unit } from "./engine.js"
import { calmAt, clamp, smooth, snoise, snoiseBatch } from "./noise.js"
import { hexRgb, mixRgb, rgbaCss, type Rgb3, type Sketch } from "./sketch.js"

const SPEED = 0.7, FPS = 5, CELL = 16, SCALE = 0.0016, LEVEL_STEP = 0.085, CALM = 0.10, BANDS = 5
const ACCENT = { dark: "#6ea8ff", light: "#2457d6" }
/** Line alpha relative to the layer opacity (the lab drew 0.34 of a light ink; a dark page needs a little less). */
const TONE = { dark: 0.8, light: 1 }
const ALPHAS = [0.78, 0.92, 1], WIDTHS = [0.8, 1.3, 2.1]

/** How much of the line shows at a point: clear behind the composer, fading toward the bottom and the edges. */
const inkAt = (x: number, y: number, vw: number, vh: number) => calmAt(x, y, CALM, vw, vh) * (0.50 + 0.50 * (1 - clamp(y / vh, 0, 1)) ** 0.8) * smooth(0, 60, Math.min(x, y, vw - x, vh - y) + 20)

/** Contours v2: marching squares on a drifting warped simplex field with minor, major and index weights, fading toward the composer. */
export function createContours(): Sketch {
  let width = 0, height = 0, cols = 0, rows = 0, Fv = new Float32Array(0), bandOf = new Uint8Array(0), wc = 0, Wx = new Float64Array(0), Wy = Wx
  // Stage buffers, allocated with the size and reused every frame: noise coordinates, and the warp and field results per lattice point.
  let GA = Wx, GB = Wx, WA = Wx, WB = Wx, XS = Wx, YS = Wx, WXI = Wx, WYI = Wx, N1 = Wx, N2 = Wx
  return {
    fps: FPS, still: 8,
    resize(w, h) {
      width = w; height = h
      const u = unit(w)
      cols = Math.ceil(w / u / CELL) + 2; rows = Math.ceil(h / u / CELL) + 2; Fv = new Float32Array(cols * rows)
      // Which opacity band each cell falls in never changes while the size does not, so it is computed once here.
      const vw = w / u, vh = h / u
      wc = (cols >> 1) + 2; Wx = new Float64Array(wc * ((rows >> 1) + 2)); Wy = new Float64Array(Wx.length)
      const n = cols * rows
      GA = new Float64Array(n); GB = new Float64Array(n); WA = new Float64Array(wc * ((rows >> 1) + 2)); WB = new Float64Array(WA.length)
      for (let m = 0; m < n; m++) { GA[m] = (m % cols) * CELL * SCALE; GB[m] = ((m / cols) | 0) * CELL * SCALE }
      for (let m = 0; m < WA.length; m++) { WA[m] = (m % wc) * 2 * CELL * SCALE; WB[m] = ((m / wc) | 0) * 2 * CELL * SCALE }
      XS = new Float64Array(n); YS = new Float64Array(n); WXI = new Float64Array(n); WYI = new Float64Array(n); N1 = new Float64Array(n); N2 = new Float64Array(n)
      bandOf = new Uint8Array(cols * rows)
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) bandOf[j * cols + i] = Math.min(BANDS - 1, (inkAt(i * CELL + CELL / 2, j * CELL + CELL / 2, vw, vh) * BANDS) | 0)
    },
    frame(c, _w, _h, seconds, _pointer, scene) {
      if (!cols) return
      const u = unit(width), vw = width / u, vh = height / u, t = seconds * SPEED
      const ink: Rgb3 = scene.ink, accent = mixRgb(ink, hexRgb(scene.dark ? ACCENT.dark : ACCENT.light), 0.9), peak = scene.dark ? TONE.dark : TONE.light
      const wxAt = (a: number, b: number) => snoise(a * 0.7 + t * 0.020 + 9.1, b * 0.7), wyAt = (a: number, b: number) => snoise(a * 0.7 + 4.3, b * 0.7 - t * 0.017)
      const field = (x: number, y: number) => { const a = x * SCALE, b = y * SCALE, wx = wxAt(a, b), wy = wyAt(a, b); return 0.70 * snoise(a + 0.55 * wx + t * 0.018, b + 0.55 * wy - t * 0.012) + 0.25 * snoise(2.3 * a - t * 0.020 + 3, 2.3 * b + 0.8 * wy + t * 0.016) }
      // The warp is a very slow noise (features ~900 px), so it is sampled every second grid point and interpolated: a third fewer noise calls.
      const wr = (rows >> 1) + 2, wn = wc * wr
      for (let m = 0; m < wn; m++) { XS[m] = WA[m]! * 0.7 + t * 0.020 + 9.1; YS[m] = WB[m]! * 0.7 }
      snoiseBatch(Wx, XS, YS, wn)
      for (let m = 0; m < wn; m++) { XS[m] = WA[m]! * 0.7 + 4.3; YS[m] = WB[m]! * 0.7 - t * 0.017 }
      snoiseBatch(Wy, XS, YS, wn)
      for (let j = 0; j < rows; j++) {
        const r0 = (j >> 1) * wc, r1 = r0 + wc, fy = (j & 1) * 0.5
        for (let i = 0; i < cols; i++) {
          const i0 = i >> 1, fx = (i & 1) * 0.5, m = j * cols + i
          const wx0 = Wx[r0 + i0]! + (Wx[r0 + i0 + 1]! - Wx[r0 + i0]!) * fx, wx1 = Wx[r1 + i0]! + (Wx[r1 + i0 + 1]! - Wx[r1 + i0]!) * fx
          const wy0 = Wy[r0 + i0]! + (Wy[r0 + i0 + 1]! - Wy[r0 + i0]!) * fx, wy1 = Wy[r1 + i0]! + (Wy[r1 + i0 + 1]! - Wy[r1 + i0]!) * fx
          WXI[m] = wx0 + (wx1 - wx0) * fy; WYI[m] = wy0 + (wy1 - wy0) * fy
        }
      }
      const n = cols * rows
      for (let m = 0; m < n; m++) { XS[m] = GA[m]! + 0.55 * WXI[m]! + t * 0.018; YS[m] = GB[m]! + 0.55 * WYI[m]! - t * 0.012 }
      snoiseBatch(N1, XS, YS, n)
      for (let m = 0; m < n; m++) { XS[m] = 2.3 * GA[m]! - t * 0.020 + 3; YS[m] = 2.3 * GB[m]! + 0.8 * WYI[m]! + t * 0.016 }
      snoiseBatch(N2, XS, YS, n)
      for (let m = 0; m < n; m++) Fv[m] = 0.70 * N1[m]! + 0.25 * N2[m]!
      // classes: 0 minor, 1 major (every 5th), 2 index (every 10th); BANDS opacity steps per class
      const paths: Path2D[][] = []
      for (let k = 0; k < 3; k++) { paths.push([]); for (let b = 0; b < BANDS; b++) paths[k]!.push(new Path2D()) }
      for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
        const a = Fv[j * cols + i]!, b = Fv[j * cols + i + 1]!, d = Fv[(j + 1) * cols + i]!, e = Fv[(j + 1) * cols + i + 1]!
        const k0 = Math.ceil(Math.min(a, b, d, e) / LEVEL_STEP), k1 = Math.floor(Math.max(a, b, d, e) / LEVEL_STEP)
        if (k1 < k0) continue
        const x = i * CELL, y = j * CELL, band = bandOf[j * cols + i]!
        for (let k = k0; k <= k1; k++) {
          const L = k * LEVEL_STEP, path = paths[k % 10 === 0 ? 2 : k % 5 === 0 ? 1 : 0]![band]!
          const idx = (a > L ? 8 : 0) | (b > L ? 4 : 0) | (e > L ? 2 : 0) | (d > L ? 1 : 0)
          if (idx === 0 || idx === 15) continue
          const x1 = x + CELL, y1 = y + CELL
          const tx = x + CELL * ((L - a) / (b - a)), ry = y + CELL * ((L - b) / (e - b)), bx = x + CELL * ((L - d) / (e - d)), ly = y + CELL * ((L - a) / (d - a))
          switch (idx) {
            case 1: case 14: path.moveTo(x, ly); path.lineTo(bx, y1); break
            case 2: case 13: path.moveTo(bx, y1); path.lineTo(x1, ry); break
            case 3: case 12: path.moveTo(x, ly); path.lineTo(x1, ry); break
            case 4: case 11: path.moveTo(tx, y); path.lineTo(x1, ry); break
            case 6: case 9: path.moveTo(tx, y); path.lineTo(bx, y1); break
            case 7: case 8: path.moveTo(tx, y); path.lineTo(x, ly); break
            default: {
              const mid = (a + b + d + e) / 4 > L
              if ((idx === 5) === mid) { path.moveTo(tx, y); path.lineTo(x1, ry); path.moveTo(x, ly); path.lineTo(bx, y1) }
              else { path.moveTo(tx, y); path.lineTo(x, ly); path.moveTo(bx, y1); path.lineTo(x1, ry) }
            }
          }
        }
      }
      c.save()
      c.scale(u, u)
      c.lineCap = "butt"; c.lineJoin = "round"; c.strokeStyle = rgbaCss(ink, 1)
      for (let k = 0; k < 3; k++) { c.lineWidth = Math.max(WIDTHS[k]!, 0.75 / u); for (let b = 0; b < BANDS; b++) { c.globalAlpha = peak * ALPHAS[k]! * (0.42 + 0.58 * (b + 0.5) / BANDS); c.stroke(paths[k]![b]!) } }
      drawTallies(c, tallyAnchors(field, LEVEL_STEP, vw, vh, (x, y) => inkAt(x, y, vw, vh)), peak, ink, accent)
      c.strokeStyle = rgbaCss(ink, 1); c.lineWidth = 0.8; c.beginPath()
      const G = 120
      for (let y = G * 0.5; y < vh; y += G) for (let x = G * 0.5; x < vw; x += G) { c.moveTo(x - 3, y); c.lineTo(x + 3, y); c.moveTo(x, y - 3); c.lineTo(x, y + 3) }
      c.globalAlpha = peak * 0.5; c.stroke()
      c.restore()
      c.globalAlpha = 1
    },
  }
}
