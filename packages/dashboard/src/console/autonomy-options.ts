/** UI choices only: saved legacy modes keep their existing engine policy. */
export const SELECTABLE_AUTONOMY_MODES = [
  { value: "standard", label: "Standard" },
  { value: "yolo", label: "YOLO" },
] as const;

/** Legacy settings become a Standard draft; only an explicit save applies it. */
export function autonomyModeDraft(mode: string): "standard" | "yolo" {
  return mode === "yolo" ? "yolo" : "standard";
}
