import type { ModelRow } from "./models-model";

export interface RecommendedRow extends ModelRow { recommended?: { label: string; why?: string } }

/** Recommended picks lead the list (in role order), each marked; the remaining models follow unchanged. */
export function withRecommendedFirst(rows: readonly ModelRow[], picks: readonly { label: string; why?: string; providerId: string; model: string }[] = []): RecommendedRow[] {
  const lead: RecommendedRow[] = [];
  const used = new Set<string>();
  for (const pick of picks) {
    const key = `${pick.providerId}:${pick.model}`;
    const row = rows.find(item => item.key === key);
    if (!row || row.disabled || used.has(key)) continue;
    used.add(key);
    lead.push({ ...row, recommended: { label: pick.label, why: pick.why } });
  }
  return [...lead, ...rows.filter(row => !used.has(row.key))];
}
