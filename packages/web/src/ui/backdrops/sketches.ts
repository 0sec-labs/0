import { createContours } from "./contours.js"
import { createDitherFlow } from "./dither-flow.js"
import { createDitherTop } from "./dither-top.js"
import { createGlyph } from "./glyph.js"
import { createInk } from "./ink.js"
import type { BackdropKind } from "./kinds.js"
import { createPlankton } from "./plankton.js"
import { createSchool } from "./school.js"
import type { Sketch } from "./sketch.js"

/** One scene factory for every backdrop except `none`; a missing entry is a type error. Every scene also renders a still frame. */
export const SKETCHES: Record<Exclude<BackdropKind, "none">, () => Sketch> = {
  "dither-top": createDitherTop, "dither-flow": createDitherFlow, contours: createContours, glyph: createGlyph, school: createSchool, plankton: createPlankton, ink: createInk,
}
