import { drawTallies, tallyAnchors } from "./contour-tally.js"
import { unit } from "./engine.js"
import { calmAt, clamp, smooth, snoise } from "./noise.js"
import { hexRgb, mixRgb, rgbaCss, type Rgb3, type Sketch } from "./sketch.js"

const SPEED = 0.7, FPS = 10, CELL = 11, SCALE = 0.0016, LEVEL_STEP = 0.085, CALM = 0.10, BANDS = 5
const ACCENT = { dark: "#6ea8ff", light: "#2457d6" }
/** Line alpha relative to the layer opacity (the lab drew 0.34 of a light ink; a dark page needs a little less). */
const TONE = { dark: 0.8, light: 1 }
const ALPHAS = [0.78, 0.92, 1], WIDTHS = [0.8, 1.3, 2.1]

/** Contours v2: marching squares on a drifting warped simplex field with minor, major and index weights, fading toward the composer. */
export function createContours(): Sketch {
  let width = 0, height = 0, cols = 0, rows = 0, Fv = new Float32Array(0)
  return {
    fps: FPS, still: 8,
    resize(w, h) {
      width = w; height = h
      const u = unit(w)
      cols = Math.ceil(w / u / CELL) + 2; rows = Math.ceil(h / u / CELL) + 2; Fv = new Float32Array(cols * rows)
    },
    frame(c, _w, _h, seconds, _pointer, scene) {
      if (!cols) return
      const u = unit(width), vw = width / u, vh = height / u, t = seconds * SPEED
      const ink: Rgb3 = scene.ink, accent = mixRgb(ink, hexRgb(scene.dark ? ACCENT.dark : ACCENT.light), 0.9), peak = scene.dark ? TONE.dark : TONE.light
      const field = (x: number, y: number) => {
        const a = x * SCALE, b = y * SCALE
        const wx = snoise(a * 0.7 + t * 0.020 + 9.1, b * 0.7), wy = snoise(a * 0.7 + 4.3, b * 0.7 - t * 0.017)
        return 0.70 * snoise(a + 0.55 * wx + t * 0.018, b + 0.55 * wy - t * 0.012) + 0.25 * snoise(2.3 * a - t * 0.020 + 3, 2.3 * b + 0.8 * wy + t * 0.016)
      }
      const inkAt = (x: number, y: number) => calmAt(x, y, CALM, vw, vh) * (0.50 + 0.50 * (1 - clamp(y / vh, 0, 1)) ** 0.8) * smooth(0, 60, Math.min(x, y, vw - x, vh - y) + 20)
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) Fv[j * cols + i] = field(i * CELL, j * CELL)
      // classes: 0 minor, 1 major (every 5th), 2 index (every 10th); BANDS opacity steps per class
      const paths: Path2D[][] = []
      for (let k = 0; k < 3; k++) { paths.push([]); for (let b = 0; b < BANDS; b++) paths[k]!.push(new Path2D()) }
      for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
        const a = Fv[j * cols + i]!, b = Fv[j * cols + i + 1]!, d = Fv[(j + 1) * cols + i]!, e = Fv[(j + 1) * cols + i + 1]!
        const k0 = Math.ceil(Math.min(a, b, d, e) / LEVEL_STEP), k1 = Math.floor(Math.max(a, b, d, e) / LEVEL_STEP)
        if (k1 < k0) continue
        const x = i * CELL, y = j * CELL, band = Math.min(BANDS - 1, (inkAt(x + CELL / 2, y + CELL / 2) * BANDS) | 0)
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
      drawTallies(c, tallyAnchors(field, LEVEL_STEP, vw, vh, inkAt), peak, ink, accent)
      c.strokeStyle = rgbaCss(ink, 1); c.lineWidth = 0.8; c.beginPath()
      const G = 120
      for (let y = G * 0.5; y < vh; y += G) for (let x = G * 0.5; x < vw; x += G) { c.moveTo(x - 3, y); c.lineTo(x + 3, y); c.moveTo(x, y - 3); c.lineTo(x, y + 3) }
      c.globalAlpha = peak * 0.5; c.stroke()
      c.restore()
      c.globalAlpha = 1
    },
  }
}
