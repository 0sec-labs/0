"use client"

import * as React from "react"
import { createPortal } from "react-dom"

import { cn } from "../lib/utils.js"

const Dithering = React.lazy(() => import("@paper-design/shaders-react").then(module => ({ default: module.Dithering })))

/** Glow from the top edge and corners; clear in the lower middle behind the composer (Capy's measured mask). */
const MASK = "radial-gradient(ellipse 150% 135% at 50% 110%, rgb(0 0 0 / 0) 0%, rgb(0 0 0 / 0) 42%, rgb(0 0 0 / .45) 66%, rgb(0 0 0 / 1) 92%)"
/** Capy renders one backing pixel per 3x3 CSS pixels, so the budget is the panel area over nine. */
const FALLBACK_PIXEL_BUDGET = 117000
const FALLBACK_INK = "#fd802e"

/** WebGL cannot read CSS variables, so resolve the ink token once to a concrete colour. */
function useInkColor(override?: string) {
  const [ink, setInk] = React.useState(override ?? FALLBACK_INK)
  React.useLayoutEffect(() => {
    if (override) { setInk(override); return }
    const probe = document.createElement("span")
    probe.style.color = `var(--dither-ink, ${FALLBACK_INK})`
    document.body.appendChild(probe)
    const resolved = getComputedStyle(probe).color
    probe.remove()
    if (resolved) setInk(resolved)
  }, [override])
  return ink
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = React.useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setReduced(query.matches)
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])
  return reduced
}

/**
 * Quiet animated ordered-dither texture for empty states, in the brand accent (`--dither-ink`). It is
 * rendered at roughly a third of the panel resolution and upscaled pixelated, and freezes for users
 * who prefer reduced motion.
 */
function DitherBackdrop({ className, color }: { className?: string; color?: string }) {
  const reduced = usePrefersReducedMotion()
  const ink = useInkColor(color)
  const marker = React.useRef<HTMLSpanElement>(null)
  const [panel, setPanel] = React.useState<Element | null>(null)
  // Render into the surrounding panel so the texture runs behind its header and tabs as well.
  React.useLayoutEffect(() => { setPanel(marker.current?.closest('[data-slot="sidebar-panel"]') ?? null) }, [])
  const host = React.useRef<HTMLDivElement>(null)
  const [budget, setBudget] = React.useState(FALLBACK_PIXEL_BUDGET)
  React.useLayoutEffect(() => {
    const node = host.current
    if (!node || typeof ResizeObserver === "undefined") return
    const measure = () => { const { width, height } = node.getBoundingClientRect(); if (width && height) setBudget(Math.max(1000, Math.round(width * height / 9))) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [panel])
  const layer = (
    <div ref={host} aria-hidden="true" data-slot="dither-backdrop" className={cn("pointer-events-none absolute inset-0 z-[-1] overflow-hidden", className)}>
      <div
        className="absolute inset-0 opacity-20 mix-blend-multiply dark:opacity-25 dark:mix-blend-screen"
        style={{ maskImage: MASK, WebkitMaskImage: MASK, maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat" }}
      >
        <React.Suspense fallback={null}>
          <Dithering
            className="size-full [&_canvas]:[image-rendering:pixelated]"
            colorBack="#00000000"
            colorFront={ink}
            shape="simplex"
            type="4x4"
            size={1}
            scale={0.8}
            speed={reduced ? 0 : 0.25}
            maxPixelCount={budget}
          />
        </React.Suspense>
      </div>
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,color-mix(in_srgb,var(--panel)_70%,transparent),transparent_22%)] dark:hidden" />
    </div>
  )
  return <>
    <span ref={marker} hidden />
    {panel ? createPortal(layer, panel) : layer}
  </>
}

export { DitherBackdrop }
