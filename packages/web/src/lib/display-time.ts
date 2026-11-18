/** A date and time in the reader's locale, with the zone named. */
export function displayTime(value: string, timezone?: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  try { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" as const } : {}), hour: "numeric", minute: "2-digit", timeZoneName: "short", ...(timezone ? { timeZone: timezone } : {}) }).format(date); }
  catch { return date.toLocaleString(); }
}
