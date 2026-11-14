/**
 * Single source of truth for which models 0 recommends, per role.
 *
 * Criteria, in order: tool-use reliability (long agent loops must not derail), capability for the role,
 * context window, then cost per token (rates live in shared/pricing.ts). Only ids already in this repo's
 * catalog or seen in live discovery appear here; never invent ids. Each role lists candidates best first;
 * the first one actually reachable on the operator's connections wins, so recommendations never point
 * at something that cannot be called.
 */
export type RecommendedRole = "orchestrator" | "scanner" | "exploit" | "summariser";

export interface RecommendedRoleSpec {
  role: RecommendedRole;
  label: string;
  why: string;
  /** Model ids, best first. Compared case-insensitively. */
  candidates: readonly string[];
}

export const RECOMMENDED_MODEL_ROLES: readonly RecommendedRoleSpec[] = [
  // Drives the whole mission: needs dependable tool calls at a low price. Matches DEFAULT_OPENAI_MODEL.
  { role: "orchestrator", label: "Orchestrator", why: "Newest generation, reliable tool use, lowest cost for long agent loops",
    candidates: ["gpt-6-luna", "gpt-5.6-terra", "gpt-5.5", "claude-sonnet-5-5", "DeepSeek-V4-Pro", "deepseek-flash"] },
  // High volume triage: mid-tier price, 1M context for large codebases.
  { role: "scanner", label: "Scanner and triage", why: "Strong code reading at mid-tier cost, large context for big repositories",
    candidates: ["DeepSeek-V4-Pro", "deepseek-v4-pro", "gpt-5.6-terra", "gpt-5.4-mini", "gpt-6-luna"] },
  // Rare, high stakes: pay for the strongest reasoning.
  { role: "exploit", label: "Exploit analysis", why: "Strongest reasoning for hard verification and exploit chains",
    candidates: ["gpt-6-sol", "gpt-5.6-sol", "claude-sonnet-5-5", "DeepSeek-V4-Pro", "gpt-5.5"] },
  // Titles and summaries: speed and price over depth.
  { role: "summariser", label: "Titles and summaries", why: "Fast and cheap; depth is not needed for short text",
    candidates: ["DeepSeek-V4-Flash", "deepseek-flash", "gpt-5.4-nano", "gpt-6-luna"] },
];

export interface RecommendedPick { role: RecommendedRole; label: string; why: string; providerId: string; model: string }

/** Provider tie-break when several connections serve the same id: direct APIs before cloud resellers. */
const PROVIDER_PREFERENCE = ["openai", "chatgpt-codex", "anthropic", "deepseek", "azure"];

/** Resolve each role to the best candidate reachable in `available` (enabled rows only). */
export function recommendModels(available: readonly { id: string; provider: string; enabled?: boolean }[]): RecommendedPick[] {
  const rows = available.filter(row => row.enabled !== false);
  const rank = (provider: string) => { const i = PROVIDER_PREFERENCE.indexOf(provider); return i < 0 ? PROVIDER_PREFERENCE.length : i; };
  const picks: RecommendedPick[] = [];
  for (const spec of RECOMMENDED_MODEL_ROLES) {
    for (const candidate of spec.candidates) {
      const hit = rows.filter(row => row.id.toLowerCase() === candidate.toLowerCase()).sort((a, b) => rank(a.provider) - rank(b.provider))[0];
      if (hit) { picks.push({ role: spec.role, label: spec.label, why: spec.why, providerId: hit.provider, model: hit.id }); break; }
    }
  }
  return picks;
}
