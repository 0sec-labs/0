"use client"

import * as React from "react"

import { cn } from "../lib/utils.js"
import { readSafeAlpha } from "./contrast.js"
import { cappedDpr } from "./engine.js"
import { PEAK_ALPHA, tileOpacity, type BackdropKind } from "./kinds.js"
import { renderStill } from "./still.js"

/** Same mask the live backdrop wears on the new-thread screen: glow from the top and corners, clear behind the composer. */
const SCREEN_MASK = "[mask-image:radial-gradient(ellipse_150%_135%_at_50%_110%,rgb(0_0_0/0)_0%,rgb(0_0_0/0)_48%,rgb(0_0_0/.4)_70%,rgb(0_0_0/.9)_94%)]"

/**
 * One frozen frame of a backdrop, drawn at its own size by `renderStill` (no animation loop, no timers).
 * `tile` is boosted so the look reads in a thumbnail; `screen` uses the opacity the live screen uses (the contrast cap) and its mask.
 * It repaints when the box or the theme, accent or mode changes.
 */
function BackdropStill({ kind, variant, className }: { kind: BackdropKind; variant: "tile" | "screen"; className?: string }) {
  const box = React.useRef<HTMLDivElement>(null)
  const canvas = React.useRef<HTMLCanvasElement>(null)
  React.useEffect(() => {
    const host = box.current, el = canvas.current, c = el?.getContext("2d")
    if (!host || !el || !c) return
    const paint = () => {
      const { width, height } = host.getBoundingClientRect()
      if (!width || !height) return
      const dpr = cappedDpr(window.devicePixelRatio)
      el.width = Math.round(width * dpr); el.height = Math.round(height * dpr)
      c.setTransform(dpr, 0, 0, dpr, 0, 0)
      host.style.opacity = String(variant === "tile" ? tileOpacity(kind) : readSafeAlpha(host, PEAK_ALPHA[kind]))
      renderStill(c, kind, width, height, { ink: getComputedStyle(host).color })
    }
    paint()
    const sized = new ResizeObserver(paint)
    sized.observe(host)
    const themed = new MutationObserver(paint)
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-accent", "data-color-theme"] })
    return () => { sized.disconnect(); themed.disconnect() }
  }, [kind, variant])
  if (kind === "none") return null
  return <div ref={box} aria-hidden="true" data-slot="backdrop-still" data-kind={kind} className={cn("pointer-events-none absolute inset-0 overflow-hidden text-[var(--dither-ink)]", variant === "screen" && SCREEN_MASK, className)}>
    <canvas ref={canvas} className="absolute inset-0 size-full" />
  </div>
}

export { BackdropStill }
