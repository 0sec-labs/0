"use client"

import * as React from "react"

import { resolveRgb } from "./contrast.js"
import { cappedDpr, createLoop, STILL_TIME, watchBattery, type Loop } from "./engine.js"
import { makeScene } from "./scene.js"
import { cellLayout } from "./pixels.js"
import type { Pointer, Scene, Sketch } from "./sketch.js"

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
    let width = 0, height = 0, ink = "", stale = true, scene: Scene = makeScene([128, 128, 128], 1)
    const readInk = () => {
      ink = getComputedStyle(canvas).color; stale = true
      const rgb = resolveRgb(ink)
      scene = { ...makeScene(rgb ? [rgb.r * 255, rgb.g * 255, rgb.b * 255] : [128, 128, 128], cappedDpr(window.devicePixelRatio)), lowres: sketch.cell !== undefined }
    }
    const loop = createLoop(seconds => {
      if (sketch.cell === undefined) {
        c.setTransform(cappedDpr(window.devicePixelRatio), 0, 0, cappedDpr(window.devicePixelRatio), 0, 0)
        if (!sketch.retained || stale) c.clearRect(0, 0, width, height)
        stale = false
      }
      c.fillStyle = ink; c.strokeStyle = ink; c.globalAlpha = 1
      sketch.frame(c, width, height, seconds, pointer, scene)
    }, undefined, sketch.fps, sketch.still ?? STILL_TIME)
    loopRef.current = loop
    const fit = (w: number, h: number) => {
      if (!w || !h) return
      const dpr = cappedDpr(window.devicePixelRatio)
      width = w; height = h
      if (sketch.cell !== undefined) {
        // Dither scenes paint a small cell grid and CSS scales it up, pixelated: the same cost profile as the lab files.
        const grid = cellLayout(sketch.cell, dpr, w, h)
        canvas.width = grid.W; canvas.height = grid.H
        canvas.style.width = `${grid.W * grid.size}px`; canvas.style.height = `${grid.H * grid.size}px`; canvas.style.imageRendering = "pixelated"
      } else { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); stale = true }
      sketch.resize(w, h)
      loop.draw()
    }
    readInk()
    const sized = new ResizeObserver(entries => { const box = entries[entries.length - 1]?.contentRect; if (box) fit(box.width, box.height) })
    sized.observe(canvas.parentElement ?? canvas)
    const themed = new MutationObserver(() => { readInk(); loop.draw() })
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-accent", "data-color-theme"] })
    const onMove = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect()
      const x = event.clientX - box.left, y = event.clientY - box.top
      if (x >= 0 && y >= 0 && x <= box.width && y <= box.height) { pointer.x = x; pointer.y = y; pointer.fresh = true }
    }
    if (sketch.pointer) window.addEventListener("pointermove", onMove, { passive: true })
    const unwatchBattery = watchBattery(saver => loop.lowPower(saver))
    return () => {
      unwatchBattery()
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
  return <canvas ref={ref} className="absolute top-0 left-0 size-full max-w-none" />
}

export { CanvasSketch }
