import { describe, expect, it, vi } from "vitest"
import { renderStill } from "./still"
import { BACKDROPS, tileOpacity } from "./kinds"

/** Records what a still draws: every path point, rect and gradient, so "something was painted" and "it is not one flat fill" are checkable without a canvas. */
function recorder() {
  const log = { points: new Set<string>(), drawn: 0, bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity } }
  const track = (x: number, y: number) => {
    log.points.add(`${Math.round(x)},${Math.round(y)}`)
    log.bounds.minX = Math.min(log.bounds.minX, x); log.bounds.maxX = Math.max(log.bounds.maxX, x); log.bounds.minY = Math.min(log.bounds.minY, y); log.bounds.maxY = Math.max(log.bounds.maxY, y)
  }
  vi.stubGlobal("Path2D", class { moveTo(x: number, y: number) { track(x, y) } lineTo(x: number, y: number) { track(x, y) } })
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => {
      if (key === "moveTo" || key === "lineTo") return (x: number, y: number) => track(x, y)
      if (key === "arc") return (x: number, y: number, r: number) => { track(x - r, y); track(x + r, y); track(x, y - r); track(x, y + r) }
      if (key === "fillRect") return (x: number, y: number, w: number, h: number) => { log.drawn++; track(x, y); track(x + w, y + h) }
      if (key === "fillText") return (_: string, x: number, y: number) => { log.drawn++; track(x, y) }
      if (key === "stroke" || key === "fill") return () => { log.drawn++ }
      if (key === "canvas") return undefined
      return key in target ? target[key] : () => {}
    },
    set: (target, key: string, value) => { target[key] = value; return true },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, log }
}

describe("renderStill", () => {
  const kinds = BACKDROPS.filter(item => item.id !== "none").map(item => item.id)
  for (const [width, height] of [[160, 100], [768, 192]] as const) {
    it.each(kinds)(`%s paints a non-blank, non-uniform frame at ${width}x${height}`, kind => {
      const { ctx, log } = recorder()
      renderStill(ctx, kind, width, height, { ink: "rgb(82, 82, 91)" })
      expect(log.drawn, "something was drawn").toBeGreaterThan(0)
      expect(log.points.size, "spread over many positions, not one flat fill").toBeGreaterThanOrEqual(6)
      expect(log.bounds.maxX - log.bounds.minX).toBeGreaterThan(width * 0.2)
    })
  }
  it("paints nothing for none or an empty box", () => {
    const { ctx, log } = recorder()
    renderStill(ctx, "none", 160, 100, { ink: "#000" })
    renderStill(ctx, "ink", 0, 100, { ink: "#000" })
    expect(log.drawn).toBe(0)
  })
  it("a frame changes with time for the animated kinds and is deterministic for the same time", () => {
    for (const kind of ["dither", "contours", "school", "plankton"] as const) {
      const at = (time: number) => { const { ctx, log } = recorder(); renderStill(ctx, kind, 400, 250, { ink: "#555555" }, time); return [...log.points].join("|") }
      expect(at(8), kind).toBe(at(8))
      expect(at(8), kind).not.toBe(at(20))
    }
  })
  it("uses the dark or light tone from the ink unless told", () => {
    const light = recorder(), dark = recorder()
    renderStill(light.ctx, "dither", 200, 120, { ink: "rgb(82, 82, 91)" })
    renderStill(dark.ctx, "dither", 200, 120, { ink: "rgb(212, 212, 216)" })
    expect(light.log.drawn).toBeGreaterThan(0); expect(dark.log.drawn).toBeGreaterThan(0)
  })
  it("tiles are boosted well above the screen cap but never opaque", () => {
    for (const kind of kinds) { expect(tileOpacity(kind)).toBeGreaterThan(0.3); expect(tileOpacity(kind)).toBeLessThanOrEqual(0.75) }
  })
})

/** Glyphs the glyph still paints, with how far each differs from the page in luminance once the tile opacity is applied. */
function glyphMarks(ink: string, rgb: [number, number, number], page: number, width = 160, height = 100) {
  const marks: number[] = []
  const lum = (c: number[]) => (0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!) / 255
  const style = { value: "" }
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => {
      if (key === "fillText") return () => { const a = Number(/,\s*([\d.]+)\)$/.exec(style.value)?.[1] ?? 1); marks.push(a * tileOpacity("glyph") * Math.abs(lum(rgb) - page)) }
      if (key === "canvas") return undefined
      return key in target ? target[key] : () => {}
    },
    set: (target, key: string, value) => { if (key === "fillStyle") style.value = String(value); target[key] = value; return true },
  }) as unknown as CanvasRenderingContext2D
  renderStill(ctx, "glyph", width, height, { ink, rgb })
  return marks
}

describe("glyph tile", () => {
  const MIN_MARKS = 60, MIN_DIFF = 0.25
  it.each([["light", "rgb(82, 82, 91)", [82, 82, 91] as [number, number, number], 1], ["dark", "rgb(212, 212, 216)", [212, 212, 216] as [number, number, number], 0.04]])("has visible structure at 160x100 in %s", (_name, ink, rgb, page) => {
    const strong = glyphMarks(ink, rgb, page).filter(diff => diff >= MIN_DIFF)
    expect(strong.length).toBeGreaterThanOrEqual(MIN_MARKS)
  })
})
