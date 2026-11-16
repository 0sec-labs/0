import type { Rgb3, Scene } from "./sketch.js"

/** `rgb()`, `rgba()` or `#rrggbb` to 0..255 channels; undefined for anything else (the caller resolves other colour spaces in a canvas). */
export function parseInk(css: string): Rgb3 | undefined {
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css.trim())
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim())
  if (hex) { const n = parseInt(hex[1]!, 16); return [n >> 16, (n >> 8) & 255, n & 255] }
  return undefined
}

/** Whether `ink` belongs to a dark page: the ink of a dark theme is the light one. */
export const isDarkInk = (ink: Rgb3) => 0.2126 * ink[0] + 0.7152 * ink[1] + 0.0722 * ink[2] > 140

export function makeScene(ink: Rgb3, dpr: number, dark = isDarkInk(ink), still = false): Scene { return { ink, dark, dpr, ...(still ? { still } : {}) } }
