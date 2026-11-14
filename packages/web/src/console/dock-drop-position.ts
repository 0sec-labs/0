/** Normalized edge zones keep small and large chat panes equally easy to split. */
export function chatDropPosition(x: number, y: number, width: number, height: number): "left" | "right" | "above" | "below" | "within" {
  if (width <= 0 || height <= 0) return "within";
  const horizontal = x < width / 2 ? "left" : "right";
  const vertical = y < height / 2 ? "above" : "below";
  const dx = Math.min(x, width - x) / width, dy = Math.min(y, height - y) / height;
  if (dx <= .28 && (dy > .2 || dx <= dy)) return horizontal;
  if (dy <= .2) return vertical;
  return "within";
}
