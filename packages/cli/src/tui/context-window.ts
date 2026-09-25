/**
 * Resolve the verified context window of the model an audit is actually running.
 *
 * The status bar needs both an exact-provider catalog window and a reported
 * planner input sample. This module resolves only the window; the chat screen
 * selects `ConsoleUsageReport.kind === "planner"` for occupancy and keeps
 * plugin samples separate. Canonical console usage currently has planner and
 * plugin emitters; compaction is a reserved kind, not a console emitter.
 *
 * Missing metadata or a missing/invalid planner sample remains unknown.
 *
 * @see resolveContextLimit — the only window authority.
 */

import { loadCatalogModels, type CatalogSyncOptions, type SyncedModel } from "./model-catalog-sync.js";

/** Source-qualified context window for the running direct-provider model. */
export interface ContextLimit {
  tokens: number;
  source: "synced-catalog" | "offline-catalog" | "known-family";
}

/**
 * Published model-family context windows used only when the provider-qualified
 * catalog has no exact entry. Never borrow a different provider's entry.
 */
const KNOWN_FAMILY_WINDOWS: ReadonlyArray<readonly [prefix: string, tokens: number]> = [
  ["gpt-5", 272_000],
  ["gpt-4.1", 1_047_576],
  ["gpt-4o", 128_000],
  ["o3", 200_000],
  ["o4", 200_000],
  ["claude", 200_000],
  ["glm-5", 200_000],
  ["glm-4", 128_000],
  ["gemini-2.5", 1_048_576],
  ["gemini-2", 1_000_000],
  ["deepseek", 128_000],
  ["qwen", 128_000],
];

/** The documented window for a model's FAMILY, by longest-prefix match, or null. */
function knownFamilyWindow(modelId: string): number | null {
  const id = modelId.toLowerCase();
  let best: number | null = null;
  let bestLen = -1;
  for (const [prefix, tokens] of KNOWN_FAMILY_WINDOWS) {
    if (id.startsWith(prefix) && prefix.length > bestLen) {
      best = tokens;
      bestLen = prefix.length;
    }
  }
  return best;
}

/** The running model an audit is bound to. Staged next-turn selections are not this. */
export interface ActiveModelIdentity {
  /**
   * The model the running session was actually built with — NOT a staged
   * next-turn selection. A staged model has not answered a single request, so
   * its window describes a conversation that does not exist yet.
   */
  modelId: string | undefined;
  /**
   * The provider the running session is bound to. Required for a match: an
   * unknown provider resolves to `null`, because a model id alone can collide
   * across providers whose windows differ.
   */
  providerId: string | undefined;
}

function positiveTokens(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}


/**
 * True when a BYOK catalog row describes the running model and nothing else.
 *
 * Identity is exact on BOTH halves, and the provider half is required rather
 * than optional. A bare model id is not a key: the same id can appear under
 * more than one provider with different windows, and matching on id alone
 * would silently pick whichever row happened to come first. A deployment
 * alias, a vendor prefix or a version-stripped stem is likewise a DIFFERENT
 * route that may carry a different window, so a near-match is treated as no
 * match — reporting a neighbouring model's window as this one's would be a
 * fabrication dressed as a lookup.
 *
 * A caller that cannot name the provider therefore gets `null`, not a guess.
 */
function sameByokModel(row: { id: string; provider: string }, identity: ActiveModelIdentity): boolean {
  return row.id === identity.modelId && row.provider === identity.providerId;
}

/**
 * Resolve the running direct/subscription model's context window. A catalog
 * match requires both the provider and the exact model ID; if metadata is
 * missing, a published family window is the only fallback.
 */
export function resolveContextLimit(
  identity: ActiveModelIdentity,
  opts: {
    /** Cache location overrides, for tests. */
    sync?: CatalogSyncOptions;
    /** Injectable catalog reader, for tests. */
    loadModels?: (opts: CatalogSyncOptions) => { source: string; models: readonly SyncedModel[] };
  } = {},
): ContextLimit | null {
  if (!identity.modelId || !identity.providerId) return null;

  // The published window for the running model's FAMILY — an honest, documented
  // last resort so the meter reads a real figure instead of a dead
  // "unavailable" for a model whose window is public knowledge.
  const familyFallback = (): ContextLimit | null => {
    const family = knownFamilyWindow(identity.modelId as string);
    return family === null ? null : { tokens: family, source: "known-family" };
  };


  // A known BYOK caveat, recorded rather than worked around: the synced
  // catalog deduplicates globally by id, so a given id survives under one
  // provider only. When the running provider is not that one the exact match
  // fails and the window stays unknown. That is the correct outcome — the
  // surviving row describes a different provider's route — and fixing it
  // belongs in the catalog contract, not here.
  const load = opts.loadModels ?? loadCatalogModels;
  const cache = load(opts.sync ?? {});
  const row = cache.models.find((model) => sameByokModel(model, identity));
  const tokens = row ? positiveTokens(row.contextTokens) : null;
  if (tokens !== null) {
    return { tokens, source: cache.source === "offline" ? "offline-catalog" : "synced-catalog" };
  }
  // The catalog does not carry this model (or carries no usable window for it).
  // Fall back to the model family's published window rather than reporting
  // "unavailable" for a model whose window is publicly known.
  return familyFallback();
}

