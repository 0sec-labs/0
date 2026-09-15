import { NativeImage, parseColor } from "@opentui/core";
import { ZERO_PALETTE, ZERO_PIXELS, ZERO_PNG_BASE64, ZERO_WIDTH } from "./zero-art.js";

const imageBytes = Buffer.from(ZERO_PNG_BASE64, "base64");

/**
 * Flatten transparency onto the active canvas before terminal image encoding.
 * Sixel/terminal compositors may otherwise replace transparent pixels with
 * their own background, producing a visible rectangle around the mascot.
 * The caller owns the returned native image and must dispose it.
 */
export function createZeroImage(canvas: string): NativeImage {
  const source = NativeImage.decode(imageBytes);
  try {
    const raw = source.raw();
    const [red, green, blue] = parseColor(canvas).toInts();
    const pixels = new Uint8Array(raw.width * raw.height * 4);
    for (let y = 0; y < raw.height; y++) {
      for (let x = 0; x < raw.width; x++) {
        const offset = y * raw.stride + x * 4;
        const target = (y * raw.width + x) * 4;
        const alpha = raw.data[offset + 3]! / 255;
        pixels[target] = Math.round(raw.data[offset]! * alpha + red * (1 - alpha));
        pixels[target + 1] = Math.round(raw.data[offset + 1]! * alpha + green * (1 - alpha));
        pixels[target + 2] = Math.round(raw.data[offset + 2]! * alpha + blue * (1 - alpha));
        pixels[target + 3] = 255;
      }
    }
    return NativeImage.fromRgba(pixels, raw.width, raw.height);
  } finally {
    source.dispose();
  }
}

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
