/** A canvas scene. It owns its preallocated state; `frame` should not allocate. Paint in CSS pixels with the theme ink already set. */
export interface Pointer { x: number; y: number; fresh: boolean }
export type Rgb3 = readonly [number, number, number]

/** What a scene needs from the theme: the ink as 0..255 channels, whether it sits on a dark page, and the canvas pixel ratio. */
export interface Scene {
  ink: Rgb3; dark: boolean; dpr: number
  /** True when the canvas is already the low-resolution cell grid (`Sketch.cell`) that CSS scales up; the sketch then paints it 1:1. */
  lowres?: boolean
  /** True for a frozen thumbnail (`renderStill`): a sketch may enlarge its marks and strengthen its tone so the look reads at 160px. The live backdrop never sets it. */
  still?: boolean
}

export interface Sketch {
  /** Called whenever the canvas size changes (the only place arrays may be allocated). */
  resize(width: number, height: number): void
  /** Paint one frame at `seconds` on the virtual clock. Draw with full alpha only up to 1; the layer applies the peak opacity. */
  frame(c: CanvasRenderingContext2D, width: number, height: number, seconds: number, pointer: Pointer, scene: Scene): void
  /** True when the scene reacts to the pointer. */
  pointer?: boolean
  /** Frame cap of this scene (at most the engine cap): slow scenes run at 10-20 fps. */
  fps?: number
  /** Dither scenes: logical px per cell. The host then sizes the canvas to the cell grid (`cellLayout`) and CSS scales it up, pixelated. */
  cell?: number
  /** Fraction of the screen height the scene paints, from the top. The host sizes the layer to that band and the sketch receives the band as its box. */
  band?: number
  /** True when the scene keeps its own pixels between frames (it redraws only what changed), so the host must not clear the canvas. */
  retained?: boolean
  /** Seconds into the scene that its single still frame shows (reduced motion, hidden, hover-off, tiles). */
  still?: number
}

/** ABGR little-endian word for a pixel buffer: `ink` channels at `alpha` 0..1. */
export const pack = (c: Rgb3, alpha: number) => ((Math.round(alpha * 255) << 24) | (Math.round(c[2]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[0])) >>> 0
export const mixRgb = (a: Rgb3, b: Rgb3, k: number): Rgb3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
export const rgbaCss = (c: Rgb3, alpha: number) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${alpha})`
export const hexRgb = (hex: string): Rgb3 => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255] }
