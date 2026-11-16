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

/** `wait`/`unwait` (optional) sleep between frames of a slow scene so the page is not woken at every display refresh; without them the loop polls on `raf`. */
export interface LoopEnv { raf: (callback: (now: number) => void) => number; caf: (id: number) => void; wait?: (callback: () => void, ms: number) => number; unwait?: (id: number) => void }
const browserEnv: LoopEnv = { raf: callback => requestAnimationFrame(callback), caf: id => cancelAnimationFrame(id), wait: (callback, ms) => window.setTimeout(callback, ms), unwait: id => window.clearTimeout(id) }
export interface Loop { play(): void; pause(): void; draw(): void; readonly running: boolean }

/** A frame-capped loop (`fps` at most the engine cap) on a virtual clock that starts at `start`: pausing never makes the scene jump when it resumes. */
export function createLoop(frame: (seconds: number) => void, env: LoopEnv = browserEnv, fps = MAX_FPS, start = STILL_TIME): Loop {
  const interval = 1000 / Math.min(MAX_FPS, fps) - 1
  const sleeps = interval > 40
  let clock = start, last = -1, id = 0, timer = 0, on = false
  const next = () => { if (sleeps && env.wait) { timer = env.wait(() => { id = env.raf(tick) }, interval - 12) } else id = env.raf(tick) }
  const tick = (now: number) => {
    if (last < 0) { last = now; next(); return }
    const elapsed = now - last
    if (elapsed < interval) { id = env.raf(tick); return }
    last = now
    clock += Math.min(elapsed, Math.max(100, interval * 2)) / 1000
    frame(clock)
    next()
  }
  return {
    play() { if (on) return; on = true; last = -1; id = env.raf(tick) },
    pause() { if (!on) return; on = false; env.caf(id); env.unwait?.(timer) },
    draw() { frame(clock) },
    get running() { return on },
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

/** Small seeded generator (mulberry32) so a scene looks the same on every load and in tests. */
export function seeded(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
