/**
 * Deterministic, meaningful ordering for the model picker. Pure: no storage, no React.
 *
 * Inside a provider the newest generation comes first (parsed from the id, compared as semantic versions, never as
 * strings), and inside a generation flagship/pro models come before standard ones, then mini/flash/haiku, then
 * nano/lite. Dated snapshots of an alias that is also listed are hidden. Providers are ordered by what the operator is
 * most likely to want: the selected one, recently used ones, then by how many healthy models they offer, failing last.
 */
export interface OrderableModel { id: string; provider: string; enabled?: boolean }

export interface ParsedModelId {
  /** Id without a trailing date stamp: the alias a snapshot belongs to. */
  alias: string;
  /** Dated snapshot (`-2025-08-07`, `-20250805`, `@20250805`). */
  snapshot: boolean;
  /** Maker prefix of gateway ids such as `anthropic/claude-sonnet-4.5`; empty otherwise. */
  vendor: string;
  /** Generation as numbers: `gpt-5.2` is [5, 2]; `gpt-4o` sorts just above [4]. */
  version: number[];
  /** 0 flagship, 1 standard, 2 compact (mini/flash/haiku), 3 smallest (nano/lite). */
  tier: 0 | 1 | 2 | 3;
}

const DATE_SUFFIX = /[-@_](20\d{2})-?(\d{2})-?(\d{2})$/;
const TOKEN = /^([a-z]*)(\d+(?:\.\d+)*)([a-z]*)$/;
const TIER_WORDS: ReadonlyArray<readonly [0 | 2 | 3, RegExp]> = [
  [3, /^(nano|lite|micro|tiny|lightning)$/],
  [2, /^(mini|flash|haiku|small|air|instant|fast)$/],
  [0, /^(pro|opus|ultra|max|large|fable|flagship|heavy|preview-pro)$/],
];

export function parseModelId(id: string): ParsedModelId {
  const lower = id.trim().toLowerCase();
  const slash = lower.indexOf("/");
  const vendor = slash > 0 ? lower.slice(0, slash) : "";
  const name = slash > 0 ? lower.slice(slash + 1) : lower;
  const dated = DATE_SUFFIX.test(name);
  const base = dated ? name.replace(DATE_SUFFIX, "") : name;
  const tokens = base.split(/[-_:\s]+/).filter(Boolean);
  const version: number[] = [];
  const words = new Set<number>();
  let collecting = false;
  for (const token of tokens) {
    const match = TOKEN.exec(token);
    if (match && !collecting && !version.length) {
      version.push(...match[2]!.split(".").map(Number));
      if (match[3]) version.push(0.5); // `4o` is newer than `4`, older than `4.1`
      collecting = !match[2]!.includes(".") && !match[3]; // claude-sonnet-4-5: a lone small integer continues the version
      continue;
    }
    if (collecting) {
      if (/^\d{1,2}$/.test(token)) { version.push(Number(token)); collecting = false; continue; }
      collecting = false;
    }
    for (const [rank, pattern] of TIER_WORDS) if (pattern.test(token)) words.add(rank);
  }
  const tier = (words.has(3) ? 3 : words.has(2) ? 2 : words.has(0) ? 0 : 1) as ParsedModelId["tier"];
  return { alias: dated ? id.trim().replace(new RegExp(DATE_SUFFIX.source, "i"), "") : id, snapshot: dated, vendor, version, tier };
}

/** Numeric, element-wise compare. Longer versions win ties (`5.1` > `5`). Negative when `a` is older. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] ?? -1) - (b[index] ?? -1);
    if (delta) return delta;
  }
  return 0;
}

const collate = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Newest generation first, then flagship before standard before compact, then by name. */
export function compareModels(a: Pick<OrderableModel, "id">, b: Pick<OrderableModel, "id">): number {
  const left = parseModelId(a.id);
  const right = parseModelId(b.id);
  return compareVersions(right.version, left.version) || left.tier - right.tier || collate.compare(a.id, b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Drops dated snapshots whose alias is listed for the same provider. A snapshot with no listed alias stays so it is
 * still reachable. Hidden ids remain selectable through the custom model ID field in Models settings.
 */
export function hideSnapshots<T extends OrderableModel>(models: readonly T[]): T[] {
  const listed = new Set(models.map(model => `${model.provider}\u0000${model.id}`));
  return models.filter(model => {
    const parsed = parseModelId(model.id);
    return !parsed.snapshot || !listed.has(`${model.provider}\u0000${parsed.alias}`);
  });
}

/** One provider's models in picker order. Gateway ids group by maker, makers ranked by their best model. */
export function orderModels<T extends OrderableModel>(models: readonly T[]): T[] {
  const sorted = [...models].sort(compareModels);
  if (!sorted.some(model => parseModelId(model.id).vendor)) return sorted;
  const rank = new Map<string, number>();
  sorted.forEach((model, index) => { const vendor = parseModelId(model.id).vendor; if (!rank.has(vendor)) rank.set(vendor, index); });
  return sorted.sort((a, b) => (rank.get(parseModelId(a.id).vendor)! - rank.get(parseModelId(b.id).vendor)!) || compareModels(a, b));
}

export interface ProviderOrderInput {
  selectedProvider?: string;
  /** Providers of recently picked models, most recent first. */
  recentProviders?: readonly string[];
  failing?: ReadonlySet<string>;
  label?: (provider: string) => string;
}

/** Selected provider, then recently used ones, then most healthy models; failing providers last. */
export function orderProviders(models: readonly OrderableModel[], providers: readonly string[], input: ProviderOrderInput = {}): string[] {
  const healthy = new Map<string, number>();
  for (const model of models) if (model.enabled !== false) healthy.set(model.provider, (healthy.get(model.provider) ?? 0) + 1);
  const recent = input.recentProviders ?? [];
  const rank = (provider: string) => {
    if (input.failing?.has(provider)) return 3;
    if (provider === input.selectedProvider) return 0;
    return recent.includes(provider) ? 1 : 2;
  };
  const label = input.label ?? (id => id);
  return [...new Set(providers)].sort((a, b) =>
    rank(a) - rank(b)
    || (rank(a) === 1 ? recent.indexOf(a) - recent.indexOf(b) : 0)
    || (healthy.get(b) ?? 0) - (healthy.get(a) ?? 0)
    || collate.compare(label(a), label(b)));
}

/** 0 name starts with the term, 1 a word of the name starts with it, 2 it appears inside, 3 only provider text matched. */
export function searchRelevance(model: Pick<OrderableModel, "id">, terms: readonly string[]): number {
  if (!terms.length) return 0;
  const name = model.id.toLowerCase();
  const bare = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  let worst = 0;
  for (const term of terms) {
    const score = name.startsWith(term) || bare.startsWith(term) ? 0 : new RegExp(`(^|[-_/.:\\s])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(name) ? 1 : name.includes(term) ? 2 : 3;
    worst = Math.max(worst, score);
  }
  return worst;
}

/** Stable relevance ordering that falls back to the normal picker order on ties. */
export function rankSearch<T extends OrderableModel>(models: readonly T[], query: string): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return [...models].sort((a, b) => searchRelevance(a, terms) - searchRelevance(b, terms) || compareModels(a, b));
}
