/** Wire shape of GET /api/console/features, plus the pure view model for the Experiments page. */
export type FeatureFlagSource = "env" | "preset" | "default";
export interface FeatureFlagRow { id: string; env: string; label: string; description: string; default: boolean; value: boolean; source: FeatureFlagSource; tier: "stable" | "experimental"; settable: boolean }
export interface FeatureFlagsResponse { flags: FeatureFlagRow[]; preset: string | null; settable: boolean }

export const sourceLabel = (flag: FeatureFlagRow): string =>
  flag.source === "env" ? "Set by environment" : flag.source === "preset" ? "Raised by preset" : "Default";

/** One line per flag: its default and where the current value comes from. */
export const flagDetail = (flag: FeatureFlagRow): string => flag.source === "default" ? `Default ${flag.default ? "on" : "off"}` : `Default ${flag.default ? "on" : "off"} · ${sourceLabel(flag)}`;

export function filterFlags(flags: readonly FeatureFlagRow[], query: string): FeatureFlagRow[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...flags];
  return flags.filter(flag => { const haystack = `${flag.label} ${flag.description} ${flag.env}`.toLowerCase(); return terms.every(term => haystack.includes(term)); });
}

/** Experimental flags first: they are the ones an operator comes here to look for. */
export function groupFlags(flags: readonly FeatureFlagRow[]): { experimental: FeatureFlagRow[]; stable: FeatureFlagRow[] } {
  const byLabel = (a: FeatureFlagRow, b: FeatureFlagRow) => a.label.localeCompare(b.label);
  return { experimental: flags.filter(flag => flag.tier === "experimental").sort(byLabel), stable: flags.filter(flag => flag.tier === "stable").sort(byLabel) };
}

/** The value to export to flip a flag away from its current state. */
export const toggleHint = (flag: FeatureFlagRow): string => `${flag.env}=${flag.value ? "0" : "1"}`;
