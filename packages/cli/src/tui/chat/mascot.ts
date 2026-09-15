import { ZERO_PALETTE, ZERO_PIXELS, ZERO_PNG_BASE64, ZERO_WIDTH } from "./zero-art.js";

/** Real Zero portrait for Kitty/Sixel-capable terminals. Embedded for standalone builds. */
export const ZERO_IMAGE = Buffer.from(ZERO_PNG_BASE64, "base64");

interface PortraitRun {
  top: string | null;
  bottom: string | null;
  length: number;
}

/** Half-block fallback from the same artwork, not a substitute logo or emoji.
 * Coalesce once; resolve transparent pixels against the current canvas at render time. */
export const ZERO_ROWS: readonly (readonly PortraitRun[])[] = Array.from(
  { length: ZERO_PIXELS.length / 2 },
  (_, row) => {
    const runs: PortraitRun[] = [];
    for (let col = 0; col < ZERO_WIDTH; col++) {
      const top = ZERO_PALETTE[ZERO_PIXELS[row * 2]!.charCodeAt(col) - 65] ?? null;
      const bottom = ZERO_PALETTE[ZERO_PIXELS[row * 2 + 1]!.charCodeAt(col) - 65] ?? null;
      const previous = runs[runs.length - 1];
      if (previous && previous.top === top && previous.bottom === bottom) previous.length++;
      else runs.push({ top, bottom, length: 1 });
    }
    return runs;
  },
);
