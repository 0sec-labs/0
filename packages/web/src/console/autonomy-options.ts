/** Plain label for a saved engine mode, in the one approvals vocabulary. Stored values are never migrated; this only reads them. */
export function autonomyModeLabel(mode: string): string {
  return mode === "recon" ? "Read-only" : mode === "yolo" || mode === "copilot" ? "Auto" : "Asks first";
}
