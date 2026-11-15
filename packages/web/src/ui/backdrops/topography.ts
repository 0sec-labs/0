import { unit } from "./engine.js"
import type { Sketch } from "./sketch.js"

const LEVELS = [-1.2, -0.8, -0.4, 0, 0.4, 0.8, 1.2]
const P = new Float32Array(2)

/** Point where the contour `level` crosses the edge between corner values a and b, written into P. */
function cross(x1: number, y1: number, a: number, x2: number, y2: number, b: number, level: number) {
  const k = a === b ? 0.5 : (level - a) / (b - a)
  P[0] = x1 + (x2 - x1) * k; P[1] = y1 + (y2 - y1) * k
}

/** Contour lines (marching squares) of a slowly drifting sum-of-sines height field. */
export const createTopography = (): Sketch => {
  let cols = 0, rows = 0, field = new Float32Array(0), colTerm = new Float32Array(0), rowTerm = new Float32Array(0)
  return {
    resize(w, h) {
      const cell = Math.round(24 * unit(w)) || 8
      cols = Math.ceil(w / cell) + 1; rows = Math.ceil(h / cell) + 1
      field = new Float32Array(cols * rows); colTerm = new Float32Array(cols); rowTerm = new Float32Array(rows)
    },
    frame(c, w, h, t) {
      if (!cols) return
      const cw = w / (cols - 1), ch = h / (rows - 1)
      for (let i = 0; i < cols; i++) colTerm[i] = Math.sin(i * cw * 0.0085 / unit(w) * 0.3 + t * 0.08) + Math.sin(i * cw * 0.004 - t * 0.05)
      for (let j = 0; j < rows; j++) rowTerm[j] = Math.sin(j * ch * 0.011 * 0.3 / unit(w) - t * 0.06) * 0.8
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++)
        field[j * cols + i] = (colTerm[i]! + rowTerm[j]!) * 0.55 + Math.sin((i * cw + j * ch) * 0.0045 + t * 0.04) * 0.6
      c.beginPath()
      for (const level of LEVELS) for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
        const a = field[j * cols + i]!, b = field[j * cols + i + 1]!, d = field[(j + 1) * cols + i]!, e = field[(j + 1) * cols + i + 1]!
        const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (e > level ? 2 : 0) | (d > level ? 1 : 0)
        if (idx === 0 || idx === 15) continue
        const x = i * cw, y = j * ch
        // Edges: T (a-b), R (b-e), B (d-e), L (a-d). Each case joins two of them (saddles join two pairs).
        const pairs = idx === 5 ? "TRLB" : idx === 10 ? "TLBR" : idx === 1 || idx === 14 ? "LB" : idx === 2 || idx === 13 ? "BR" : idx === 3 || idx === 12 ? "LR" : idx === 4 || idx === 11 ? "TR" : idx === 6 || idx === 9 ? "TB" : "TL"
        for (let k = 0; k < pairs.length; k += 2) {
          for (let end = 0; end < 2; end++) {
            const edge = pairs[k + end]
            if (edge === "T") cross(x, y, a, x + cw, y, b, level)
            else if (edge === "R") cross(x + cw, y, b, x + cw, y + ch, e, level)
            else if (edge === "B") cross(x, y + ch, d, x + cw, y + ch, e, level)
            else cross(x, y, a, x, y + ch, d, level)
            if (end === 0) c.moveTo(P[0]!, P[1]!); else c.lineTo(P[0]!, P[1]!)
          }
        }
      }
      c.lineWidth = 1
      c.stroke()
    },
  }
}
