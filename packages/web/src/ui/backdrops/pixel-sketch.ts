import { Grid, cellLayout } from "./pixels.js"
import { pack, type Pointer, type Rgb3, type Scene, type Sketch } from "./sketch.js"

/** One simulated dither scene: allocates in `init`, advances in fixed steps, and writes marks into the grid in `render`. */
export interface PixelSim { step(dt: number): void; render(): void }
export interface PixelSpec {
  /** Frame cap and logical px per dither cell, as in the lab file. */
  fps: number; cell: number
  /** Seconds the still frame shows, and how many seconds before it are rendered while fast-forwarding so trails exist. */
  still: number; trail: number
  /** Accent tint for this theme and the relative alpha (0..1 of the layer opacity) of the brightest mark, to match the lab tone. */
  palette(scene: Scene): { accent: Rgb3; tone: number }
  create(g: Grid): PixelSim
}

const MAX_BOOT = 60

/** Hosts a `PixelSim` as a `Sketch`: fixed-step simulation on the virtual clock, rebuilt when the box or the theme changes. */
export function pixelSketch(spec: PixelSpec): Sketch {
  let width = 0, height = 0, grid: Grid | null = null, sim: PixelSim | null = null, key = "", last = 0, owed = 0
  const dt = 1 / spec.fps
  const advance = (steps: number, renderFrom: number) => {
    for (let i = 0; i < steps; i++) { grid!.time += dt; grid!.ptrStep(); sim!.step(dt); if (i >= renderFrom) { sim!.render(); grid!.FR++ } }
  }
  const build = (c: CanvasRenderingContext2D, scene: Scene, seconds: number) => {
    const { u, cs, W, H } = cellLayout(spec.cell, scene.dpr, width, height)
    const palette = spec.palette(scene)
    const density = Math.min(1.5, Math.max(0.15, (width * height) / (u * u * 1296000)))
    grid = new Grid(W, H, cs, u, density, pack(scene.ink, palette.tone), pack(palette.accent, palette.tone), c, scene.lowres)
    sim = spec.create(grid)
    const steps = Math.round(Math.min(seconds, MAX_BOOT) * spec.fps), trail = Math.round(spec.trail * spec.fps)
    advance(steps, Math.max(0, steps - trail))
    sim.render(); grid.FR++
    last = seconds; owed = 0
  }
  return {
    fps: spec.fps, still: spec.still, cell: spec.cell, pointer: true,
    resize(w, h) { width = w; height = h; grid = null },
    frame(c, _w, _h, seconds, pointer: Pointer, scene) {
      const next = `${scene.ink.join()}|${scene.dark}|${scene.dpr}`
      if (!grid || !sim || next !== key) { key = next; build(c, scene, seconds) }
      else {
        const grid_ = grid
        if (pointer.fresh) { grid_.pointerAt(pointer.x / (grid_.CS * grid_.u), pointer.y / (grid_.CS * grid_.u)); pointer.fresh = false }
        owed += Math.max(0, seconds - last); last = seconds
        const steps = Math.min(4, Math.floor(owed / dt + 0.5))
        if (steps > 0) { owed = steps === 4 ? 0 : owed - steps * dt; advance(steps, steps - 1) }
      }
      grid?.present(c)
    },
  }
}
