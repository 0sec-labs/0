/** A canvas scene. It owns its preallocated state; `frame` must not allocate. Paint in CSS pixels with the theme ink already set. */
export interface Pointer { x: number; y: number; fresh: boolean }
export interface Sketch {
  /** Called whenever the canvas size changes (the only place arrays may be allocated). */
  resize(width: number, height: number): void
  /** Paint one frame at `seconds` on the virtual clock. Draw with full alpha only up to 1; the layer applies the peak opacity. */
  frame(c: CanvasRenderingContext2D, width: number, height: number, seconds: number, pointer: Pointer): void
  /** True when the scene reacts to the pointer. */
  pointer?: boolean
}
