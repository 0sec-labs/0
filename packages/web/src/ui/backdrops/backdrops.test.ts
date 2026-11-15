import { afterEach, describe, expect, it, vi } from "vitest"
import { contrastRatio, parseColor } from "../../lib/appearance-model"
import { COLOR_THEMES, mixSrgb, tokensFor, type ThemeMode } from "../../lib/color-themes"
import { safeAlpha } from "./contrast"
import { MAX_DPR, MAX_FPS, STILL_TIME, cappedDpr, createLoop, shouldAnimate, watchActivity, type LoopEnv } from "./engine"
import { BACKDROPS, DEFAULT_BACKDROP, PEAK_ALPHA, isBackdrop, parseBackdrop } from "./kinds"
import { createCodeRain } from "./code-rain"
import { createConstellation } from "./constellation"
import { createGrid } from "./grid"
import { createRipple } from "./ripple"
import { createScanline } from "./scanline"
import type { Sketch } from "./sketch"
import { createTopography } from "./topography"
import { createWaves } from "./waves"

afterEach(() => vi.unstubAllGlobals())

describe("registry", () => {
  it("lists ten unique kinds with plain labels and keeps Dither as the default", () => {
    expect(BACKDROPS.map(item => item.label)).toEqual(["None", "Dither", "Aurora", "Grid", "Topography", "Constellation", "Scanline", "Code rain", "Waves", "Ripple"])
    expect(new Set(BACKDROPS.map(item => item.id)).size).toBe(BACKDROPS.length)
    expect(DEFAULT_BACKDROP).toBe("dither")
    expect(parseBackdrop(null)).toBe("dither")
    expect(parseBackdrop("matrix")).toBe("dither")
    expect(parseBackdrop("waves")).toBe("waves")
    expect(isBackdrop("none")).toBe(true)
    for (const item of BACKDROPS) expect(PEAK_ALPHA[item.id]).toBe(item.id === "none" ? 0 : PEAK_ALPHA[item.id])
    expect(BACKDROPS.filter(item => item.id !== "none").every(item => PEAK_ALPHA[item.id] > 0 && PEAK_ALPHA[item.id] <= 0.3)).toBe(true)
  })
})

describe("selection persistence", () => {
  it("stores the choice per browser, publishes it and ignores junk", async () => {
    const data = new Map<string, string>()
    const store = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key), key: () => null, length: 0, clear: () => data.clear() }
    vi.stubGlobal("window", { localStorage: store, sessionStorage: store, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {} }) })
    vi.stubGlobal("document", { documentElement: { dataset: {} } })
    vi.resetModules()
    const appearance = await import("../../lib/web-appearance")
    expect(appearance.getWebBackground()).toBe("dither")
    appearance.setWebBackground("aurora")
    expect(appearance.getWebBackground()).toBe("aurora")
    expect(data.get("zero-web-background")).toBe("aurora")
    appearance.setWebBackground("bogus" as never)
    expect(appearance.getWebBackground()).toBe("aurora")
  })
})

describe("contrast", () => {
  const modes: ThemeMode[] = ["light", "dark"]
  it("caps every backdrop so body text stays at AA over its brightest frame in every theme", () => {
    let checked = 0
    for (const theme of COLOR_THEMES) for (const mode of modes) {
      if (mode === "light" ? !theme.light : !theme.dark) continue
      const tokens = tokensFor(theme, mode)
      const ink = parseColor(tokens.shaderInk)!, text = parseColor(tokens.text)!
      for (const page of [tokens.bg, tokens.panel ?? tokens.bg].map(value => parseColor(value)!)) {
        const before = contrastRatio(text, page)
        for (const kind of BACKDROPS.filter(item => item.id !== "none" && item.id !== "dither")) {
          const alpha = safeAlpha(PEAK_ALPHA[kind.id], ink, page, text)
          const worst = parseColor(mixSrgb(tokens.shaderInk, `#${[page.r, page.g, page.b].map(c => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`, alpha * 100))!
          expect(contrastRatio(text, worst), `${theme.id} ${mode} ${kind.id}`).toBeGreaterThanOrEqual(Math.min(4.5, before - 0.2) - 0.02)
          if (before >= 4.9) expect(alpha, `${theme.id} ${mode} ${kind.id}`).toBeGreaterThan(0.05)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(300)
  })
  it("leaves the declared opacity alone when there is room", () => {
    expect(safeAlpha(0.2, parseColor("#808080")!, parseColor("#ffffff")!, parseColor("#000000")!)).toBe(0.2)
    expect(safeAlpha(0.9, parseColor("#000000")!, parseColor("#ffffff")!, parseColor("#767676")!)).toBeLessThan(0.9)
  })
})

describe("loop and activity", () => {
  const fakeEnv = () => {
    const callbacks = new Map<number, (now: number) => void>()
    let next = 1
    const env: LoopEnv = { raf: callback => { callbacks.set(next, callback); return next++ }, caf: id => void callbacks.delete(id) }
    const step = (now: number) => { const pending = [...callbacks.values()]; callbacks.clear(); for (const callback of pending) callback(now) }
    return { env, step, pending: () => callbacks.size }
  }
  it("never paints faster than 30 fps and cancels its frame when paused", () => {
    const { env, step, pending } = fakeEnv()
    const frame = vi.fn()
    const loop = createLoop(frame, env)
    loop.play()
    for (let now = 0; now <= 1000; now += 1000 / 120) step(now)
    expect(frame.mock.calls.length).toBeLessThanOrEqual(MAX_FPS)
    expect(frame.mock.calls.length).toBeGreaterThan(MAX_FPS - 6)
    loop.pause()
    expect(pending()).toBe(0)
    expect(loop.running).toBe(false)
  })
  it("resumes on its virtual clock without jumping and starts at the still frame", () => {
    const { env, step } = fakeEnv()
    const times: number[] = []
    const loop = createLoop(seconds => times.push(seconds), env)
    loop.draw()
    expect(times[0]).toBe(STILL_TIME)
    loop.play(); step(0); step(40)
    loop.pause(); loop.play(); step(60_000); step(60_040)
    expect(times[times.length - 1]! - times[1]!).toBeLessThan(0.2)
  })
  it("animates only when visible, on screen, playing and not reduced", () => {
    const on = { visible: true, onscreen: true, playing: true, reduced: false }
    expect(shouldAnimate(on)).toBe(true)
    for (const key of ["visible", "onscreen", "playing"] as const) expect(shouldAnimate({ ...on, [key]: false })).toBe(false)
    expect(shouldAnimate({ ...on, reduced: true })).toBe(false)
  })
  it("caps the device pixel ratio", () => {
    expect([0.5, 1, 2, 3, NaN].map(cappedDpr)).toEqual([1, 1, MAX_DPR, MAX_DPR, 1])
  })
  it("reports tab, reduced-motion and viewport changes and removes every listener on cleanup", () => {
    const listeners = new Set<() => void>()
    const root = { dataset: {} as Record<string, string> }
    const doc = { visibilityState: "visible", documentElement: root, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) }
    const observers: { disconnected: boolean; callback: () => void }[] = []
    vi.stubGlobal("MutationObserver", class { o = { disconnected: false, callback: () => {} }; constructor(callback: () => void) { this.o.callback = callback; observers.push(this.o) } observe() {} disconnect() { this.o.disconnected = true } })
    let view: (entries: { isIntersecting: boolean }[]) => void = () => {}
    vi.stubGlobal("IntersectionObserver", class { disconnected = false; constructor(callback: typeof view) { view = callback } observe() {} disconnect() { this.disconnected = true } })
    const seen: Record<string, unknown>[] = []
    const stop = watchActivity({} as Element, next => seen.push(next), doc as unknown as Document)
    expect(seen).toContainEqual({ visible: true }); expect(seen).toContainEqual({ reduced: false })
    doc.visibilityState = "hidden"; for (const fn of listeners) fn()
    expect(seen).toContainEqual({ visible: false })
    root.dataset.motion = "reduce"; observers[0]!.callback()
    expect(seen).toContainEqual({ reduced: true })
    view([{ isIntersecting: false }])
    expect(seen).toContainEqual({ onscreen: false })
    stop()
    expect(listeners.size).toBe(0)
    expect(observers[0]!.disconnected).toBe(true)
  })
})

/** Records canvas calls so a scene can run headless. */
function fakeContext() {
  const calls = { stroke: 0, fill: 0, text: 0, rect: 0, maxAlpha: 0 }
  let alpha = 1
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => key === "globalAlpha" ? alpha : key === "stroke" ? () => { calls.stroke++; calls.maxAlpha = Math.max(calls.maxAlpha, alpha) } : key === "fill" ? () => { calls.fill++ } : key === "fillText" ? () => { calls.text++ } : key === "fillRect" || key === "rect" ? () => { calls.rect++ } : key in target ? target[key] : () => {},
    set: (target, key: string, value) => { if (key === "globalAlpha") { alpha = value; if (value < 0 || value > 1) throw new Error(`alpha ${value}`) } else target[key] = value; return true },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}

describe("canvas scenes", () => {
  const scenes: [string, () => Sketch][] = [["grid", createGrid], ["topography", createTopography], ["constellation", createConstellation], ["scanline", createScanline], ["code-rain", createCodeRain], ["waves", createWaves], ["ripple", createRipple]]
  it.each(scenes)("%s draws within alpha 1 at the still frame, in motion and at tile size", (_name, create) => {
    for (const [w, h] of [[1200, 760], [140, 88]] as const) {
      const sketch = create(), { ctx, calls } = fakeContext(), pointer = { x: 50, y: 40, fresh: true }
      sketch.resize(w, h)
      for (const t of [STILL_TIME, STILL_TIME + 0.033, 30, 300]) sketch.frame(ctx, w, h, t, pointer)
      expect(calls.stroke + calls.fill + calls.text + calls.rect).toBeGreaterThan(0)
    }
  })
  it("the pointer drops a ripple only for scenes that ask for it", () => {
    expect(createRipple().pointer).toBe(true)
    expect(createWaves().pointer).toBeUndefined()
  })
})
