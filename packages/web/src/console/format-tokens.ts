/** Compact token counts: 950, 14.3K, 218.3K, 1.1M. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, "");
  if (abs >= 999_950) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1000) return `${trim(value / 1000)}K`;
  return String(Math.round(value));
}
