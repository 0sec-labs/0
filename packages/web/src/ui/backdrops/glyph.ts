import { unit } from "./engine.js"
import { clamp, smooth, vnoise } from "./noise.js"
import { hexRgb, rgbaCss, type Pointer, type Rgb3, type Scene, type Sketch } from "./sketch.js"

const FPS = 10, CELL_W = 10, CELL_H = 18, FONT = 13, RAMP = " .:-=+*#", NL = RAMP.length
const SPEED = 0.03, FREQ = 0.0030, WARP = 1.4, ACCENT_SHARE = 0.9, CALM = 0.4, RIDGE_W = 3.3, RIDGE_POW = 2.6
const ACCENT = { dark: "#e4663f", light: "#c23a16" }
/** Brightest-glyph alpha relative to the layer opacity (the lab used 0.5 of a grey ink; the page ink here is lighter on dark). */
const TONE = { dark: 0.57, light: 1 }
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
const alphaOf = (k: number, tone: number) => tone * (0.28 + 0.72 * Math.pow(k / (NL - 1), 1.1))

/** Glyph contours: monospace punctuation chosen from a density ramp by drifting, domain-warped noise, densest along its ridges. */
export function createGlyph(): Sketch {
  let width = 0, height = 0, cols = 0, rows = 0, prev = new Int16Array(0), key = ""
  let atlas: HTMLCanvasElement[] = []
  let sx = 0, sy = 0
  const build = (c: CanvasRenderingContext2D, scene: Scene) => {
    const u = unit(width), s = u * scene.dpr, doc = (c.canvas as HTMLCanvasElement | undefined)?.ownerDocument
    cols = Math.ceil(width / u / CELL_W) + 1; rows = Math.ceil(height / u / CELL_H) + 1; prev = new Int16Array(cols * rows)
    atlas = []
    if (!doc) return
    const aw = Math.ceil(CELL_W * s), ah = Math.ceil(CELL_H * s)
    for (const color of [scene.ink, hexRgb(scene.dark ? ACCENT.dark : ACCENT.light)] as Rgb3[]) {
      const cv = doc.createElement("canvas"); cv.width = aw * NL; cv.height = ah
      const g = cv.getContext("2d")!
      g.font = `${FONT * s}px ${MONO}`; g.textAlign = "center"; g.textBaseline = "middle"
      for (let k = 1; k < NL; k++) { g.fillStyle = rgbaCss(color, alphaOf(k, scene.dark ? TONE.dark : TONE.light)); g.fillText(RAMP[k]!, (k + 0.5) * aw, ah / 2 + scene.dpr) }
      atlas.push(cv)
    }
  }
  return {
    fps: FPS, still: 6, pointer: true, retained: true,
    resize(w, h) { width = w; height = h; key = "" },
    frame(c, _w, _h, seconds, pointer: Pointer, scene) {
      const next = `${scene.ink.join()}|${scene.dark}|${scene.dpr}|${width}x${height}`
      if (next !== key) { key = next; build(c, scene) }
      const u = unit(width), s = u * scene.dpr, vw = width / u, vh = height / u, tone = scene.dark ? TONE.dark : TONE.light
      const tx = pointer.fresh ? clamp(pointer.x / width * 2 - 1, -1, 1) : 0, ty = pointer.fresh ? clamp(pointer.y / height * 2 - 1, -1, 1) : 0
      sx += (tx - sx) * 0.06; sy += (ty - sy) * 0.06
      const tt = seconds * SPEED, aw = Math.ceil(CELL_W * s), ah = Math.ceil(CELL_H * s), accentInk = hexRgb(scene.dark ? ACCENT.dark : ACCENT.light)
      const cached = atlas.length > 0
      c.save()
      if (cached) c.setTransform(1, 0, 0, 1, 0, 0)
      else { c.scale(u, u); c.font = `${FONT}px ${MONO}`; c.textAlign = "center"; c.textBaseline = "middle" }
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const x = (i + 0.5) * CELL_W, y = (j + 0.5) * CELL_H
        const X = x * FREQ + sx * 0.05, Y = y * FREQ + sy * 0.05
        const q = vnoise(X * 0.7 + 3.1, Y * 0.7 + 8.4, tt * 0.8)
        const f = vnoise(X + WARP * (q - 0.5) * 2, Y + WARP * (q - 0.5) * 2.2, tt + 50) * 0.78 + vnoise(X * 2.6 + 9, Y * 2.6, tt * 1.3) * 0.22
        const nx = (x - vw / 2) / (vw * 0.4), ny = (y - vh / 2) / (vh * 0.34)
        const ridge = 1 - Math.abs(f - 0.5) * RIDGE_W
        const v = Math.pow(clamp(ridge, 0, 1), RIDGE_POW) * (0.35 + 0.65 * smooth(0.3, 0.7, vnoise(X * 0.6 + 70, Y * 0.6, tt * 0.5))) * (1 - CALM * Math.exp(-(nx * nx + ny * ny)))
        const k = Math.min(NL - 1, (v * NL * 1.15) | 0)
        let accent = 0
        if (k >= 4 && vnoise(X * 0.5 + 40, Y * 0.5, tt * 0.6 + 9) > 0.85 - 0.1 * ACCENT_SHARE) accent = 1
        const code = k < 1 ? 0 : accent * 16 + k + 1
        if (cached) {
          if (code === prev[j * cols + i]) continue
          prev[j * cols + i] = code
          const dx = Math.round(i * CELL_W * s), dy = Math.round(j * CELL_H * s)
          c.clearRect(dx, dy, aw, ah)
          if (k >= 1) c.drawImage(atlas[accent]!, k * aw, 0, aw, ah, dx, dy, aw, ah)
        } else if (k >= 1) {
          c.fillStyle = rgbaCss(accent ? accentInk : scene.ink, alphaOf(k, tone))
          c.fillText(RAMP[k]!, x, y + 1)
        }
      }
      c.restore()
    },
  }
}
