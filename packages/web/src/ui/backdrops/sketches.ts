import { createCodeRain } from "./code-rain.js"
import { createConstellation } from "./constellation.js"
import { createGrid } from "./grid.js"
import type { BackdropKind } from "./kinds.js"
import { createRipple } from "./ripple.js"
import { createScanline } from "./scanline.js"
import type { Sketch } from "./sketch.js"
import { createTopography } from "./topography.js"
import { createWaves } from "./waves.js"

/** The canvas kinds. Each factory builds one scene; `none`, `dither` and `aurora` are not sketches. */
export const SKETCHES: Partial<Record<BackdropKind, () => Sketch>> = {
  grid: createGrid, topography: createTopography, constellation: createConstellation, scanline: createScanline,
  "code-rain": createCodeRain, waves: createWaves, ripple: createRipple,
}
