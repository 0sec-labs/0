/** UI choices only: saved legacy modes keep their existing engine policy. */
export const SELECTABLE_AUTONOMY_MODES = [
  { value: "standard", label: "Ask before acting" },
  { value: "yolo", label: "Act without asking" },
] as const;

/** Legacy settings become a Standard draft; only an explicit save applies it. */
export function autonomyModeDraft(mode: string): "standard" | "yolo" {
  return mode === "yolo" ? "yolo" : "standard";
}

/** Plain label for a saved autonomy mode; legacy modes read as Ask before acting, matching the composer. */
export function autonomyModeLabel(mode: string): string {
  return SELECTABLE_AUTONOMY_MODES.find(option => option.value === autonomyModeDraft(mode))!.label;
}
