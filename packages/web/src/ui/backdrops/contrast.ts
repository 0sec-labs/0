import { contrastRatio, type Rgb } from "../../lib/appearance-model"

const mix = (ink: Rgb, page: Rgb, alpha: number): Rgb => ({ r: ink.r * alpha + page.r * (1 - alpha), g: ink.g * alpha + page.g * (1 - alpha), b: ink.b * alpha + page.b * (1 - alpha) })

/**
 * The largest layer opacity (at most `peak`) that keeps `text` readable over `page` at WCAG AA on the brightest possible
 * frame, which is the ink at that opacity. A palette whose own text is already under AA may lose at most 0.2 of a ratio point.
 */
export function safeAlpha(peak: number, ink: Rgb, page: Rgb, text: Rgb, minimum = 4.5): number {
  const need = Math.min(minimum, contrastRatio(text, page) - 0.2) + 0.03
  if (contrastRatio(text, mix(ink, page, peak)) >= need) return peak
  let low = 0, high = peak
  for (let step = 0; step < 12; step++) { const middle = (low + high) / 2; if (contrastRatio(text, mix(ink, page, middle)) >= need) low = middle; else high = middle }
  return low
}

let probe: CanvasRenderingContext2D | null | undefined
/** Any CSS colour string (hex, rgb, oklch, color-mix result) to sRGB 0..1, by letting the browser paint one pixel. */
export function resolveRgb(css: string): Rgb | undefined {
  if (probe === undefined) probe = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!probe) return undefined
  probe.clearRect(0, 0, 1, 1); probe.fillStyle = "#000"; probe.fillStyle = css; probe.fillRect(0, 0, 1, 1)
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data
  return { r: r! / 255, g: g! / 255, b: b! / 255 }
}

/** Reads the live theme (ink, both page surfaces, foreground) under `element` and returns the opacity cap for `peak`. */
export function readSafeAlpha(element: Element, peak: number): number {
  const span = document.createElement("span")
  element.appendChild(span)
  const color = (value: string) => { span.style.color = value; return resolveRgb(getComputedStyle(span).color) }
  const ink = color("var(--dither-ink)"), text = color("var(--foreground)")
  const pages = [color("var(--background)"), color("var(--panel)")]
  span.remove()
  if (!ink || !text) return peak
  return pages.reduce((alpha, page) => page ? Math.min(alpha, safeAlpha(peak, ink, page, text)) : alpha, peak)
}
