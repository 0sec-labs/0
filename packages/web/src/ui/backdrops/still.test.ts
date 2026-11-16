import { describe, expect, it } from "vitest"
import { AURORA_BLOBS, auroraDrift, renderStill } from "./still"
import { STILL_TIME } from "./engine"
import { BACKDROPS, tileOpacity } from "./kinds"

/** Records what a still draws: every path point, rect and gradient, so "something was painted" and "it is not one flat fill" are checkable without a canvas. */
function recorder() {
  const log = { points: new Set<string>(), drawn: 0, gradients: 0, stops: [] as string[], bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity } }
  const track = (x: number, y: number) => {
    log.points.add(`${Math.round(x)},${Math.round(y)}`)
    log.bounds.minX = Math.min(log.bounds.minX, x); log.bounds.maxX = Math.max(log.bounds.maxX, x); log.bounds.minY = Math.min(log.bounds.minY, y); log.bounds.maxY = Math.max(log.bounds.maxY, y)
  }
  const gradient = { addColorStop: (_: number, color: string) => log.stops.push(color) }
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => {
      if (key === "moveTo" || key === "lineTo") return (x: number, y: number) => track(x, y)
      if (key === "arc") return (x: number, y: number, r: number) => { track(x - r, y); track(x + r, y); track(x, y - r); track(x, y + r) }
      if (key === "fillRect") return (x: number, y: number, w: number, h: number) => { log.drawn++; track(x, y); track(x + w, y + h) }
      if (key === "fillText") return (_: string, x: number, y: number) => { log.drawn++; track(x, y) }
      if (key === "stroke" || key === "fill") return () => { log.drawn++ }
      if (key === "createRadialGradient") return () => { log.gradients++; return gradient }
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
    renderStill(ctx, "grid", 0, 100, { ink: "#000" })
    expect(log.drawn).toBe(0)
  })
  it("aurora draws its colour blobs as ink fading to the same ink, not black", () => {
    const { ctx, log } = recorder()
    renderStill(ctx, "aurora", 160, 100, { ink: "rgb(212, 212, 216)" })
    expect(log.gradients).toBe(AURORA_BLOBS.length)
    expect(log.stops).toContain("rgb(212, 212, 216)")
    expect(log.stops).toContain("rgba(212, 212, 216, 0)")
  })
  it("a frame changes with time for the animated kinds and is deterministic for the same time", () => {
    const at = (time: number) => { const { ctx, log } = recorder(); renderStill(ctx, "waves", 400, 250, { ink: "#555555" }, time); return [...log.points].join("|") }
    expect(at(STILL_TIME)).toBe(at(STILL_TIME))
    expect(at(STILL_TIME)).not.toBe(at(STILL_TIME + 20))
  })
  it("the aurora drift stays inside the CSS keyframe range and alternates", () => {
    for (const blob of AURORA_BLOBS) for (const t of [0, 5, 40, 80, 300]) {
      const drift = auroraDrift(blob, t)
      expect(drift.dx).toBeGreaterThanOrEqual(-0.06 - 1e-9); expect(drift.dx).toBeLessThanOrEqual(0.08 + 1e-9)
      expect(drift.scale).toBeGreaterThanOrEqual(1); expect(drift.scale).toBeLessThanOrEqual(1.16 + 1e-9)
    }
  })
  it("tiles are boosted well above the screen cap but never opaque", () => {
    for (const kind of kinds) { expect(tileOpacity(kind)).toBeGreaterThan(0.3); expect(tileOpacity(kind)).toBeLessThanOrEqual(0.75) }
  })
})
