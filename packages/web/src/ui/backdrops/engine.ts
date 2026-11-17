/** Shared animation rules: 30 fps cap, device pixel ratio cap, and when a backdrop may move at all. */
export const MAX_FPS = 30
export const MAX_DPR = 1.5
/** Seconds into the animation that the single still frame (reduced motion, hidden, hover-off) shows. */
export const STILL_TIME = 7

export const cappedDpr = (ratio: number) => Math.min(MAX_DPR, Math.max(1, ratio || 1))
/** Spacing and type scale: 1 on a full panel, smaller in a gallery tile, so previews keep the same proportions. */
export const unit = (width: number) => Math.min(1, Math.max(0.3, width / 1000))

export interface Activity { visible: boolean; onscreen: boolean; playing: boolean; reduced: boolean }
export const shouldAnimate = (a: Activity) => a.visible && a.onscreen && a.playing && !a.reduced

/** `wait`/`unwait` (optional) sleep between frames of a slow scene so the page is not woken at every display refresh; without them the loop polls on `raf`. `now` times the frames for the low-power rule. */
export interface LoopEnv { raf: (callback: (now: number) => void) => number; caf: (id: number) => void; wait?: (callback: () => void, ms: number) => number; unwait?: (id: number) => void; now?: () => number }
const browserEnv: LoopEnv = { raf: callback => requestAnimationFrame(callback), caf: id => cancelAnimationFrame(id), wait: (callback, ms) => window.setTimeout(callback, ms), unwait: id => window.clearTimeout(id), now: () => performance.now() }
export interface Loop { play(): void; pause(): void; draw(): void; /** Halve the frame rate (battery saver); the loop also does this by itself when frames run over budget. */ lowPower(on: boolean): void; readonly running: boolean; readonly halved: boolean }

/** Low-power rule: when more than half of the frames in a 2 s window take longer than this many ms of script, the loop halves its rate. */
export const FRAME_BUDGET_MS = 8
export const BUDGET_WINDOW_MS = 2000

/**
 * A frame-capped loop (`fps` at most the engine cap) on a virtual clock that starts at `start`: pausing never makes the scene jump when it resumes.
 * It also measures its own frame cost and drops to half rate when frames keep exceeding `FRAME_BUDGET_MS` (a slow machine or battery saver).
 */
export function createLoop(frame: (seconds: number) => void, env: LoopEnv = browserEnv, fps = MAX_FPS, start = STILL_TIME): Loop {
  const base = 1000 / Math.min(MAX_FPS, fps) - 1
  const clock = env.now ?? (() => 0)
  let time = start, last = -1, id = 0, timer = 0, on = false, slow = false, saver = false, windowStart = -1, frames = 0, over = 0
  const interval = () => slow || saver ? base * 2 + 1 : base
  const next = () => { const wait = interval(); if (wait > 40 && env.wait) { timer = env.wait(() => { id = env.raf(tick) }, wait - 12) } else id = env.raf(tick) }
  const tick = (now: number) => {
    if (last < 0) { last = now; next(); return }
    const elapsed = now - last
    if (elapsed < interval()) { id = env.raf(tick); return }
    last = now
    time += Math.min(elapsed, Math.max(100, interval() * 2)) / 1000
    const t0 = clock()
    frame(time)
    if (!slow) {
      if (windowStart < 0) windowStart = now
      frames++
      if (clock() - t0 > FRAME_BUDGET_MS) over++
      if (now - windowStart >= BUDGET_WINDOW_MS) { slow = frames >= 4 && over * 2 > frames; windowStart = -1; frames = 0; over = 0 }
    }
    next()
  }
  return {
    play() { if (on) return; on = true; last = -1; windowStart = -1; frames = 0; over = 0; id = env.raf(tick) },
    pause() { if (!on) return; on = false; env.caf(id); env.unwait?.(timer) },
    draw() { frame(time) },
    lowPower(on) { saver = on },
    get running() { return on },
    get halved() { return slow || saver },
  }
}

/** Tracks tab visibility, on-screen state and the reduced-motion flag on <html>. Returns the cleanup. */
export function watchActivity(element: Element, onChange: (next: Partial<Activity>) => void, doc: Document = document): () => void {
  const onVisibility = () => onChange({ visible: doc.visibilityState !== "hidden" })
  doc.addEventListener("visibilitychange", onVisibility)
  const reduced = () => onChange({ reduced: doc.documentElement.dataset.motion === "reduce" })
  const motion = new MutationObserver(reduced)
  motion.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-motion"] })
  const view = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => { const last = entries[entries.length - 1]; if (last) onChange({ onscreen: last.isIntersecting }) })
  view?.observe(element)
  onVisibility(); reduced()
  return () => { doc.removeEventListener("visibilitychange", onVisibility); motion.disconnect(); view?.disconnect() }
}

interface Battery extends EventTarget { charging: boolean; level: number }
/** Battery saver: true while the device runs on a battery at or below 20% (Chromium's Battery API; elsewhere it never fires). Returns the cleanup. */
export function watchBattery(onChange: (saver: boolean) => void, nav: { getBattery?: () => Promise<Battery> } = typeof navigator === "undefined" ? {} : navigator as { getBattery?: () => Promise<Battery> }): () => void {
  let battery: Battery | undefined, dead = false
  const update = () => { if (battery) onChange(!battery.charging && battery.level <= 0.2) }
  nav.getBattery?.().then(b => { if (dead) return; battery = b; b.addEventListener("levelchange", update); b.addEventListener("chargingchange", update); update() }, () => undefined)
  return () => { dead = true; battery?.removeEventListener("levelchange", update); battery?.removeEventListener("chargingchange", update) }
}

/** Small seeded generator (mulberry32) so a scene looks the same on every load and in tests. */
export function seeded(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
