"use client"

import * as React from "react"
import { createPortal } from "react-dom"

import { cn } from "../lib/utils.js"
import { DitherBackdrop } from "../components/dither-backdrop.js"
import { Aurora } from "./aurora.js"
import { CanvasSketch } from "./canvas-sketch.js"
import { createCodeRain } from "./code-rain.js"
import { createConstellation } from "./constellation.js"
import { readSafeAlpha } from "./contrast.js"
import { shouldAnimate, watchActivity, type Activity } from "./engine.js"
import { createGrid } from "./grid.js"
import { PEAK_ALPHA, type BackdropKind } from "./kinds.js"
import { createRipple } from "./ripple.js"
import { createScanline } from "./scanline.js"
import type { Sketch } from "./sketch.js"
import { createTopography } from "./topography.js"
import { createWaves } from "./waves.js"

/** The canvas kinds. Each factory builds one scene; `none`, `dither` and `aurora` are handled in `Backdrop`. */
const SKETCHES: Partial<Record<BackdropKind, () => Sketch>> = {
  grid: createGrid, topography: createTopography, constellation: createConstellation, scanline: createScanline,
  "code-rain": createCodeRain, waves: createWaves, ripple: createRipple,
}
/** Glow from the top and corners, clear in the lower middle behind the composer (same mask as Dither). */
const MASK = "radial-gradient(ellipse 150% 135% at 50% 110%, rgb(0 0 0 / 0) 0%, rgb(0 0 0 / 0) 48%, rgb(0 0 0 / .4) 70%, rgb(0 0 0 / .9) 94%)"

/** Whether the layer may move: visible tab, on screen, `playing`, and no reduced-motion request. */
function useAnimating(ref: React.RefObject<Element | null>, playing: boolean) {
  const [state, setState] = React.useState<Omit<Activity, "playing">>(() => ({ visible: typeof document === "undefined" || document.visibilityState !== "hidden", onscreen: true, reduced: typeof document !== "undefined" && document.documentElement.dataset.motion === "reduce" }))
  React.useEffect(() => ref.current ? watchActivity(ref.current, next => setState(previous => { const merged = { ...previous, ...next }; return merged.visible === previous.visible && merged.onscreen === previous.onscreen && merged.reduced === previous.reduced ? previous : merged })) : undefined, [ref])
  return shouldAnimate({ ...state, playing })
}

function Layer({ kind, preview, playing, className }: { kind: BackdropKind; preview: boolean; playing: boolean; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const animate = useAnimating(ref, playing)
  const make = SKETCHES[kind]
  const peak = PEAK_ALPHA[kind]
  const [cap, setCap] = React.useState(peak)
  // The opacity never exceeds what keeps text at AA in the current theme (re-read when the theme, accent or mode changes).
  React.useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const read = () => setCap(readSafeAlpha(node, peak))
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-accent", "data-color-theme"] })
    return () => observer.disconnect()
  }, [peak])
  const opacity = preview ? Math.min(0.5, cap * 2.2) : cap
  return (
    <div ref={ref} aria-hidden="true" data-slot="backdrop" data-kind={kind} className={cn("pointer-events-none absolute inset-0 overflow-hidden text-[var(--dither-ink)]", !preview && "z-[-1]", className)}
      style={{ opacity, ...(preview ? null : { maskImage: MASK, WebkitMaskImage: MASK, maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat" }) }}>
      {kind === "aurora" && <Aurora animate={animate} />}
      {kind === "dither" && <span className="absolute inset-0 bg-[radial-gradient(currentColor_1px,transparent_1.6px)] bg-[length:6px_6px]" />}
      {make && <CanvasSketch create={make} animate={animate} />}
    </div>
  )
}

/** Render into the surrounding panel so the atmosphere runs behind its header too (same as Dither). */
function PanelLayer(props: { kind: BackdropKind; className?: string }) {
  const marker = React.useRef<HTMLSpanElement>(null)
  const [panel, setPanel] = React.useState<Element | null>(null)
  React.useLayoutEffect(() => { setPanel(marker.current?.closest('[data-slot="sidebar-panel"]') ?? null) }, [])
  const layer = <Layer kind={props.kind} preview={false} playing className={props.className} />
  return <><span ref={marker} hidden />{panel ? createPortal(layer, panel) : layer}</>
}

/**
 * One quiet animated atmosphere for the new-thread screen. `preview` renders a small inline tile (no mask or portal) that
 * moves only while `playing`. Everything honours the theme ink, reduced motion, tab visibility and on-screen state.
 */
function Backdrop({ kind, className, preview = false, playing = true }: { kind: BackdropKind; className?: string; preview?: boolean; playing?: boolean }) {
  if (kind === "none") return null
  if (kind === "dither" && !preview) return <DitherBackdrop className={className} />
  return preview ? <Layer kind={kind} preview playing={playing} className={className} /> : <PanelLayer kind={kind} className={className} />
}

export { Backdrop }
export * from "./kinds.js"
