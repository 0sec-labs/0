"use client"

import * as React from "react"
import { createPortal } from "react-dom"

import { cn } from "../lib/utils.js"
import { CanvasSketch } from "./canvas-sketch.js"
import { readSafeAlpha } from "./contrast.js"
import { shouldAnimate, watchActivity, type Activity } from "./engine.js"
import { PEAK_ALPHA, bandOf, tileOpacity, type BackdropKind } from "./kinds.js"
import { SKETCHES } from "./sketches.js"

/** Whether the layer may move: visible tab, on screen, `playing`, and no reduced-motion request. */
function useAnimating(ref: React.RefObject<Element | null>, playing: boolean) {
  const [state, setState] = React.useState<Omit<Activity, "playing">>(() => ({ visible: typeof document === "undefined" || document.visibilityState !== "hidden", onscreen: true, reduced: typeof document !== "undefined" && document.documentElement.dataset.motion === "reduce" }))
  React.useEffect(() => ref.current ? watchActivity(ref.current, next => setState(previous => { const merged = { ...previous, ...next }; return merged.visible === previous.visible && merged.onscreen === previous.onscreen && merged.reduced === previous.reduced ? previous : merged })) : undefined, [ref])
  return shouldAnimate({ ...state, playing })
}

function Layer({ kind, preview, playing, className }: { kind: BackdropKind; preview: boolean; playing: boolean; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const animate = useAnimating(ref, playing)
  const make = kind === "none" ? undefined : SKETCHES[kind]
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
  const band = bandOf(kind)
  const opacity = preview ? tileOpacity(kind) : cap
  return (
    <div ref={ref} aria-hidden="true" data-slot="backdrop" data-kind={kind} className={cn("pointer-events-none absolute inset-0 overflow-hidden text-[var(--dither-ink)] [container-type:size]", !preview && "z-[-1]", className)}
      style={{ opacity, ...(band < 1 ? { bottom: "auto", height: `${band * 100}%` } : null) }}>
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
 * One quiet animated atmosphere for the new-thread screen. `preview` renders a small inline tile that
 * moves only while `playing`. Everything honours the theme ink, reduced motion, tab visibility and on-screen state.
 */
function Backdrop({ kind, className, preview = false, playing = true }: { kind: BackdropKind; className?: string; preview?: boolean; playing?: boolean }) {
  if (kind === "none") return null
  return preview ? <Layer kind={kind} preview playing={playing} className={className} /> : <PanelLayer kind={kind} className={className} />
}

export { Backdrop }
export * from "./kinds.js"

export { BackdropStill } from "./backdrop-still.js"
export { renderStill, type StillTheme } from "./still.js"
