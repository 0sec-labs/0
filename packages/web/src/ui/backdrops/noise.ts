/** Small pure maths shared by the field sketches: clamping, smoothstep, an integer hash and two noises (simplex 2D, value 3D). */
export const clamp = (x: number, a: number, b: number) => x < a ? a : x > b ? b : x
export const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
/** Length of (a, b): small enough to be inlined, unlike `Math.hypot`, which boxes its arguments on every call. */
export const hyp = (a: number, b: number) => Math.sqrt(a * a + b * b)
export const hash = (n: number) => { n = Math.imul(n ^ n >>> 15, 2246822519); n = Math.imul(n ^ n >>> 13, 3266489917); return ((n ^ n >>> 16) >>> 0) / 4294967296 }

const NP = new Uint8Array(512), NGX = new Float32Array(16), NGY = new Float32Array(16)
{
  let s = 1234567
  const r = () => (s = Math.imul(s ^ s >>> 15, 1 | s) + 0x6D2B79F5 | 0, ((s ^ s >>> 14) >>> 0) / 4294967296)
  const p = Array.from({ length: 256 }, (_, i) => i)
  for (let i = 255; i > 0; i--) { const j = r() * (i + 1) | 0; const t = p[i]!; p[i] = p[j]!; p[j] = t }
  for (let i = 0; i < 512; i++) NP[i] = p[i & 255]!
  for (let i = 0; i < 16; i++) { NGX[i] = Math.cos(i * Math.PI / 8); NGY[i] = Math.sin(i * Math.PI / 8) }
}
const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6

export type Floats = Float64Array

/**
 * 2D simplex noise over arrays, roughly in [-1, 1]: `out[m] = snoise(xs[m], ys[m])` for `m < n`. The scenes evaluate tens of thousands of
 * points a frame, and a call per point boxes every double argument and result; one call per batch allocates nothing.
 */
export function snoiseBatch(out: Floats, xs: Floats, ys: Floats, n: number): void {
  for (let m = 0; m < n; m++) {
    const x = xs[m]!, y = ys[m]!
    const s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s), t = (i + j) * G2
    const x0 = x - (i - t), y0 = y - (j - t), i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2, ii = i & 255, jj = j & 255
    let v = 0, a = 0.5 - x0 * x0 - y0 * y0, g: number
    if (a > 0) { g = NP[ii + NP[jj]!]! & 15; a *= a; v += a * a * (NGX[g]! * x0 + NGY[g]! * y0) }
    a = 0.5 - x1 * x1 - y1 * y1; if (a > 0) { g = NP[ii + i1 + NP[jj + j1]!]! & 15; a *= a; v += a * a * (NGX[g]! * x1 + NGY[g]! * y1) }
    a = 0.5 - x2 * x2 - y2 * y2; if (a > 0) { g = NP[ii + 1 + NP[jj + 1]!]! & 15; a *= a; v += a * a * (NGX[g]! * x2 + NGY[g]! * y2) }
    out[m] = 72 * v
  }
}
const ONE = [new Float64Array(1), new Float64Array(1), new Float64Array(1)] as const
/** 2D simplex noise, roughly in [-1, 1] (a single point; use `snoiseBatch` in a frame loop). */
export function snoise(x: number, y: number): number { ONE[0][0] = x; ONE[1][0] = y; snoiseBatch(ONE[2], ONE[0], ONE[1], 1); return ONE[2][0]! }

const PERM = new Uint8Array(512)
{
  let s = 1337
  const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
  const p: number[] = []
  for (let i = 0; i < 256; i++) p.push(i)
  for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; const t = p[i]!; p[i] = p[j]!; p[j] = t }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]!
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

/**
 * 3D value noise over arrays in [0, 1] with a quintic fade (x and y are space, z is time): `out[m] = vnoise(xs[m], ys[m], z)` for `m < n`.
 * One call per batch so no double is boxed per point.
 */
export function vnoiseBatch(out: Floats, xs: Floats, ys: Floats, z: number, n: number): void {
  const zf = Math.floor(z), fz = fade(z - zf), Z = zf & 255, Z1 = (Z + 1) & 255
  for (let m = 0; m < n; m++) {
    const x = xs[m]!, y = ys[m]!, xf = Math.floor(x), yf = Math.floor(y)
    const tx = x - xf, ty = y - yf, fx = tx * tx * tx * (tx * (tx * 6 - 15) + 10), fy = ty * ty * ty * (ty * (ty * 6 - 15) + 10)
    const X = xf & 255, Y = yf & 255, X1 = (X + 1) & 255, Y1 = (Y + 1) & 255
    const a = PERM[X]! + Y, b = PERM[X1]! + Y, c = PERM[X]! + Y1, d = PERM[X1]! + Y1
    const aa = PERM[a]!, ba = PERM[b]!, ab = PERM[c]!, bb = PERM[d]!
    const v000 = PERM[aa + Z]!, v100 = PERM[ba + Z]!, v010 = PERM[ab + Z]!, v110 = PERM[bb + Z]!
    const v001 = PERM[aa + Z1]!, v101 = PERM[ba + Z1]!, v011 = PERM[ab + Z1]!, v111 = PERM[bb + Z1]!
    const x00 = v000 + (v100 - v000) * fx, x10 = v010 + (v110 - v010) * fx, x01 = v001 + (v101 - v001) * fx, x11 = v011 + (v111 - v011) * fx
    const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy
    out[m] = (y0 + (y1 - y0) * fz) / 255
  }
}
/** 3D value noise in [0, 1] for a single point; use `vnoiseBatch` in a frame loop. */
export function vnoise(x: number, y: number, z: number): number { ONE[0][0] = x; ONE[1][0] = y; vnoiseBatch(ONE[2], ONE[0], ONE[1], z, 1); return ONE[2][0]! }

/** Soft clear zone behind the composer for a scene `vw` x `vh` logical px: a multiplier in [floor, 1] for a position in px. */
export function calmAt(x: number, y: number, floor: number, vw: number, vh: number): number {
  const ex = (x - vw * 0.5) / Math.max(380, vw * 0.30), ey = (y - vh * 0.54) / Math.max(170, vh * 0.24)
  return floor + (1 - floor) * smooth(0.45, 1.3, Math.sqrt(ex * ex + ey * ey))
}
