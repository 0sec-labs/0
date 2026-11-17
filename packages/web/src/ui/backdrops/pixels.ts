import { calmMap } from "./bayer.js"
import { unit } from "./engine.js"

/**
 * Cell grid for a canvas box: `size` css px per cell (whole device pixels at `dpr`), `cs` the same in logical px, `W` x `H` cells.
 * Shared by the host that sizes the canvas and by the sketch that fills it, so they always agree.
 */
export function cellLayout(cell: number, dpr: number, width: number, height: number) {
  const u = unit(width), cs = Math.max(2, Math.round(cell * dpr)) / dpr, size = cs * u
  return { u, cs, size, W: Math.max(1, Math.ceil(width / size)), H: Math.max(1, Math.ceil(height / size)) }
}

/**
 * A low-resolution dither surface: `W` x `H` cells, each `CS` logical px (a logical px is `u` real css px, so a tile shows the
 * whole scene in miniature). Marks are written into `b32` as packed RGBA words; 0 is clear. Sparse scenes mark 16x16 blocks
 * as active (`touch`) so only recently drawn blocks are redithered.
 */
export class Grid {
  readonly b32: Uint32Array
  readonly BW: number
  readonly BH: number
  readonly blk: Int32Array
  FR = 1
  time = 0
  /** Pointer in cells, eased toward the real pointer; `act` fades after the last move. */
  readonly ptr = { x: -999, y: -999, sx: -999, sy: -999, act: 0 }
  private readonly canvas: HTMLCanvasElement | null
  private readonly image: ImageData | null
  private readonly direct: boolean

  constructor(readonly W: number, readonly H: number, readonly CS: number, readonly u: number, readonly density: number, readonly mark: number, readonly acc: number, c: CanvasRenderingContext2D, direct = false) {
    this.BW = Math.ceil(W / 16); this.BH = Math.ceil(H / 16)
    this.blk = new Int32Array(this.BW * this.BH)
    const doc = direct ? undefined : (c.canvas as HTMLCanvasElement | undefined)?.ownerDocument
    this.canvas = doc?.createElement("canvas") ?? null
    if (this.canvas) { this.canvas.width = W; this.canvas.height = H }
    this.image = this.canvas || direct ? c.createImageData(W, H) : null
    this.direct = direct
    this.b32 = this.image ? new Uint32Array(this.image.data.buffer) : new Uint32Array(W * H)
  }
  calm(strength: number) { return calmMap(this.W, this.H, strength) }
  /** Scale a count of scene objects with the area drawn (full at the reference 1440x900 screen). */
  count(n: number, min = 1) { return Math.max(min, Math.round(n * this.density)) }
  touch(x: number, y: number, keep: number) { if (x < 0 || y < 0 || x >= this.W || y >= this.H) return; this.blk[(y >> 4) * this.BW + (x >> 4)] = this.FR + keep }
  touchBox(x0: number, y0: number, x1: number, y1: number, keep: number) {
    x0 = Math.max(0, x0 >> 4); y0 = Math.max(0, y0 >> 4); x1 = Math.min(this.BW - 1, x1 >> 4); y1 = Math.min(this.BH - 1, y1 >> 4)
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.blk[y * this.BW + x] = this.FR + keep
  }
  pointerAt(xCells: number, yCells: number) {
    const p = this.ptr
    p.x = xCells; p.y = yCells
    if (p.sx < -900) { p.sx = xCells; p.sy = yCells }
    p.act = 1
  }
  ptrStep() { const p = this.ptr; p.sx += (p.x - p.sx) * 0.06; p.sy += (p.y - p.sy) * 0.06; p.act *= 0.992 }
  /** Draws the surface at `W*CS*u` css px with nearest-neighbour scaling (a plain rect per run when there is no real canvas). */
  present(c: CanvasRenderingContext2D) {
    const size = this.CS * this.u
    if (this.direct && this.image) { c.putImageData(this.image, 0, 0); return }
    if (this.canvas && this.image) {
      this.canvas.getContext("2d")?.putImageData(this.image, 0, 0)
      c.imageSmoothingEnabled = false
      c.drawImage(this.canvas, 0, 0, this.W * size, this.H * size)
      return
    }
    let last = 0
    for (let y = 0; y < this.H; y++) for (let x = 0; x < this.W; x++) {
      const word = this.b32[y * this.W + x]!
      if (!word) continue
      if (word !== last) { c.fillStyle = `rgba(${word & 255},${word >> 8 & 255},${word >> 16 & 255},${(word >>> 24) / 255})`; last = word }
      c.fillRect(x * size, y * size, size, size)
    }
  }
}

/** Frames a trail needs to fade from `v` below `floor` at per-frame multiplier `d`. */
export const decayFrames = (v: number, d: number, floor: number) => Math.ceil(Math.log(Math.max(v, floor * 1.01) / floor) / -Math.log(d)) + 2
