import type { OptimizedBuffer, SliderRenderable } from "@opentui/core";
import type { Theme } from "./themes.js";

// Retain OpenTUI's native slider sizing and input handling; replace only the
// full-block ink with a one-eighth-cell stroke in its public paint hook.
function renderThinThumb(this: SliderRenderable, buffer: OptimizedBuffer): void {
  if (this.orientation !== "vertical" || this.height <= 0) return;
  const track = this.height * 2;
  const range = this.max - this.min;
  const viewport = Math.max(1, this.viewPortSize);
  const size = range <= 0 ? track : Math.max(1, Math.min(Math.floor(track * viewport / (range + viewport)), track));
  const start = range <= 0 ? 0 : Math.round((this.value - this.min) / range * (track - size));
  const endRow = Math.ceil((start + size) / 2);
  for (let row = Math.floor(start / 2); row < endRow; row++) {
    buffer.setCellWithAlphaBlending(this.x, this.y + row, "▏", this.foregroundColor, this.backgroundColor);
  }
}

export function sleekScrollbar(theme: Theme, surface: string = theme.PANEL) {
  return {
    width: 1,
    showArrows: false,
    trackOptions: {
      backgroundColor: surface,
      foregroundColor: theme.BORDER,
      renderAfter: renderThinThumb,
    },
    arrowOptions: {
      foregroundColor: surface,
      backgroundColor: surface,
    },
  } as const;
}
