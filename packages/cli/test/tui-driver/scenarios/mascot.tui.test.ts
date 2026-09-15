import { expect, it } from "vitest";
import { createZeroImage } from "../../../src/tui/chat/mascot.js";

it("bakes the active canvas into the portrait instead of leaving terminal-controlled transparency", () => {
  const dark = createZeroImage("#111111");
  const light = createZeroImage("#fcfcfd");
  try {
    const darkPixels = dark.raw();
    const lightPixels = light.raw();
    // Exterior pixels must match the requested canvas, including after a
    // theme change. Otherwise native image protocols can show a matte box.
    expect([...darkPixels.data.subarray(0, 4)]).toEqual([17, 17, 17, 255]);
    expect([...lightPixels.data.subarray(0, 4)]).toEqual([252, 252, 253, 255]);
    for (const raw of [darkPixels, lightPixels]) {
      for (let y = 0; y < raw.height; y++) {
        for (let x = 0; x < raw.width; x++) {
          // No remaining transparency, including partially transparent edges.
          expect(raw.data[y * raw.stride + x * 4 + 3]).toBe(255);
        }
      }
    }
  } finally {
    dark.dispose();
    light.dispose();
  }
});
