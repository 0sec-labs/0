/** Plain label for a thread's access: two states. Older stored values (observe, recon -> Read-only; everything else -> Can make changes) are only read, never rewritten. */
const READ_ONLY_VALUES = new Set(["read-only", "recon", "observe"]);
export function autonomyModeLabel(mode: string): string {
  return READ_ONLY_VALUES.has(mode) ? "Read-only" : "Can make changes";
}
