"use client"

import * as React from "react"

import { cappedDpr, createLoop, type Loop } from "./engine.js"
import type { Pointer, Sketch } from "./sketch.js"

/** Hosts one canvas scene: sizes it (DPR capped), reads the theme ink, runs the capped loop only while `animate`, and cleans up. */
function CanvasSketch({ create, animate }: { create: () => Sketch; animate: boolean }) {
  const ref = React.useRef<HTMLCanvasElement>(null)
  const loopRef = React.useRef<Loop | null>(null)
  React.useEffect(() => {
    const canvas = ref.current
    const c = canvas?.getContext("2d")
    if (!canvas || !c) return
    const sketch = create()
    const pointer: Pointer = { x: 0, y: 0, fresh: false }
    let width = 0, height = 0, ink = ""
    const readInk = () => { ink = getComputedStyle(canvas).color }
    const loop = createLoop(seconds => {
      c.setTransform(cappedDpr(window.devicePixelRatio), 0, 0, cappedDpr(window.devicePixelRatio), 0, 0)
      c.clearRect(0, 0, width, height)
      c.fillStyle = ink; c.strokeStyle = ink; c.globalAlpha = 1
      sketch.frame(c, width, height, seconds, pointer)
    })
    loopRef.current = loop
    const fit = (w: number, h: number) => {
      if (!w || !h) return
      const dpr = cappedDpr(window.devicePixelRatio)
      width = w; height = h
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
      sketch.resize(w, h)
      loop.draw()
    }
    readInk()
    const sized = new ResizeObserver(entries => { const box = entries[entries.length - 1]?.contentRect; if (box) fit(box.width, box.height) })
    sized.observe(canvas)
    const themed = new MutationObserver(() => { readInk(); loop.draw() })
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-accent", "data-color-theme"] })
    const onMove = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect()
      const x = event.clientX - box.left, y = event.clientY - box.top
      if (x >= 0 && y >= 0 && x <= box.width && y <= box.height) { pointer.x = x; pointer.y = y; pointer.fresh = true }
    }
    if (sketch.pointer) window.addEventListener("pointermove", onMove, { passive: true })
    return () => {
      loop.pause(); loopRef.current = null
      sized.disconnect(); themed.disconnect()
      window.removeEventListener("pointermove", onMove)
    }
  }, [create])
  React.useEffect(() => {
    const loop = loopRef.current
    if (animate) loop?.play(); else loop?.pause()
    return () => loop?.pause()
  }, [animate, create])
  return <canvas ref={ref} className="absolute inset-0 size-full" />
}

export { CanvasSketch }
