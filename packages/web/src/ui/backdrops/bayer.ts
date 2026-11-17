/** 8x8 ordered-dither thresholds in (0, 1), row-major: `BAYER[(y & 7) * 8 + (x & 7)]`. */
export const BAYER: Float32Array = (() => {
  let m: number[][] = [[0]]
  for (let n = 1; n < 8; n *= 2) {
    const next: number[][] = []
    for (let y = 0; y < 2 * n; y++) { next[y] = []; for (let x = 0; x < 2 * n; x++) next[y]![x] = m[y % n]![x % n]! * 4 + [[0, 2], [3, 1]][y >= n ? 1 : 0]![x >= n ? 1 : 0]! }
    m = next
  }
  const f = new Float32Array(64)
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) f[y * 8 + x] = (m[y]![x]! + 0.5) / 64
  return f
})()

/** Multiplier map thinning marks behind the composer: 1 at the edges, `1 - strength` in the middle (cell grid `w` x `h`). */
export function calmMap(w: number, h: number, strength: number): Float32Array {
  const m = new Float32Array(w * h)
  for (let y = 0; y < h; y++) { const ny = (y + 0.5) / h - 0.5; for (let x = 0; x < w; x++) { const nx = (x + 0.5) / w - 0.5; m[y * w + x] = 1 - strength * Math.exp(-(nx * nx / 0.05 + ny * ny / 0.018)) } }
  return m
}
