/** A centred time stamp separates turns only after this long a silence (Capy's rule), or when the day changes. */
export const STAMP_GAP_MS = 30 * 60_000;

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * Whether the turn starting at `iso` gets a stamp above it. The first turn is stamped, a later turn only after a
 * gap or a new calendar day. A turn with no usable time is never stamped.
 */
export function needsStamp(previousIso: string | undefined, iso: string | undefined): boolean {
  const at = new Date(iso ?? "");
  if (!iso || Number.isNaN(at.getTime())) return false;
  const before = new Date(previousIso ?? "");
  if (!previousIso || Number.isNaN(before.getTime())) return true;
  return !sameDay(before, at) || at.getTime() - before.getTime() > STAMP_GAP_MS;
}
