import { clamp, hash, hyp, smooth } from "./noise.js"
import { rgbaCss, type Rgb3 } from "./sketch.js"

export interface Tally { x: number; y: number; ang: number; n: number; fade: number }

/** Where the dot-tally elevation marks sit: lattice anchors pulled onto the nearest major contour by Newton steps, so they glide with it. */
export function tallyAnchors(field: (x: number, y: number) => number, levelStep: number, vw: number, vh: number, inkAt: (x: number, y: number) => number): Tally[] {
  const S = Math.max(240, vw / 6), items: Tally[] = [], major = 5 * levelStep
  for (let gy = -1; gy < vh / S + 1; gy++) for (let gx = -1; gx < vw / S + 1; gx++) {
    let x = (gx + 0.5 + (hash(gx * 73 + gy * 19) - 0.5) * 0.6) * S, y = (gy + 0.5 + (hash(gx * 31 + gy * 57 + 5) - 0.5) * 0.6) * S
    const ax = x, ay = y
    let f = field(x, y)
    const Lm = Math.round(f / major) * major
    let gxv = 0, gyv = 0, ok = true
    for (let it = 0; it < 4; it++) {
      f = field(x, y)
      const h = 3
      gxv = (field(x + h, y) - field(x - h, y)) / (2 * h); gyv = (field(x, y + h) - field(x, y - h)) / (2 * h)
      const g2 = gxv * gxv + gyv * gyv
      if (g2 < 1e-8) { ok = false; break }
      const s = (f - Lm) / g2
      x -= gxv * s; y -= gyv * s
    }
    const dist = hyp(x - ax, y - ay), fade = smooth(S * 0.42, S * 0.25, dist) * inkAt(x, y) * smooth(30, 90, Math.min(x, y, vw - x, vh - y))
    if (ok && fade > 0.02) items.push({ x, y, ang: Math.atan2(gxv, -gyv), n: Math.round(Lm / major), fade })
  }
  return items
}

/** Cuts a gap in the lines under each tally, then draws its dots (up to seven, two rows) along the contour. */
export function drawTallies(c: CanvasRenderingContext2D, items: Tally[], peak: number, ink: Rgb3, accent: Rgb3) {
  c.globalCompositeOperation = "destination-out"
  for (const it of items) { c.globalAlpha = Math.min(1, it.fade * 1.6); c.beginPath(); c.arc(it.x, it.y, 13, 0, 7); c.fill() }
  c.globalCompositeOperation = "source-over"
  for (const it of items) {
    const n = clamp(it.n + 3, 1, 7), cs = Math.cos(it.ang), sn = Math.sin(it.ang), per = 5.6
    c.globalAlpha = peak * clamp(it.fade * 1.6, 0, 1); c.fillStyle = rgbaCss(it.n > 0 ? accent : ink, 1)
    const row1 = Math.min(n, 4), row2 = n - row1
    c.beginPath()
    for (let q = 0; q < n; q++) {
      const r = q < row1 ? 0 : 1, m = r === 0 ? row1 : row2, o = (q - (r === 0 ? 0 : row1) - (m - 1) / 2) * per, off = (r - (row2 ? 0.5 : 0)) * per
      const px = it.x + cs * o - sn * off, py = it.y + sn * o + cs * off
      c.moveTo(px + 1.9, py); c.arc(px, py, 1.9, 0, 7)
    }
    c.fill()
  }
}
