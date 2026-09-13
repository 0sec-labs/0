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
import type { HostedCatalogModel } from "./model-catalog.js";

/**
 * A context window this process can stand behind, and where it came from.
 *
 * `source` exists so a caller can label the figure truthfully rather than
 * implying every window carries the same weight: a hosted window is the live
 * account-scoped catalog's own number, while a BYOK window may have come from
 * the bundled offline floor.
 */
export interface ContextLimit {
  tokens: number;
  source: "hosted-catalog" | "synced-catalog" | "offline-catalog" | "known-family";
}

/**
 * Last-resort context windows for well-known model FAMILIES, consulted only
 * when neither catalog carries the running model. These are published,
 * documented numbers (not a guess or a floor) — e.g. the gpt-5.x family's
 * 272k input window, recorded in the runtime's own notes — so the meter reads
 * an honest figure instead of "unavailable" for a model the catalog sync has
 * not (yet) enumerated. Matched by longest id prefix; the `source` on the
 * result labels the figure truthfully as a family default.
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
  /** True when this audit routes through the hosted service. */
  hosted: boolean;
}

function positiveTokens(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

/** The runtime provider discriminator for an audit routed through the service. */
const HOSTED_PROVIDER_ID = "hosted";

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
 *
 * NOTE this is the BYOK rule only. It deliberately does NOT apply to hosted
 * rows — see {@link resolveContextLimit} for why comparing those two provider
 * fields is a category error.
 */
function sameByokModel(row: { id: string; provider: string }, identity: ActiveModelIdentity): boolean {
  return row.id === identity.modelId && row.provider === identity.providerId;
}

/**
 * The verified context window for the running model, or `null` when unknown.
 *
 * Hosted and BYOK models resolve through entirely separate authorities and
 * never borrow from each other:
 *
 *  - **Hosted** resolves ONLY against the live, authenticated, account-scoped
 *    hosted catalog passed in `hostedCatalog`, matched on the model's UNIQUE
 *    public route id. If that catalog has not loaded, is stale, or does not
 *    carry this exact route, the answer is `null`. The bundled offline table is
 *    never consulted for a hosted id — it describes models.dev's view of a
 *    public model, not the window of the route this account is actually
 *    entitled to, and the two can legitimately differ.
 *  - **BYOK/local** resolves against the synced catalog cache on exact
 *    provider + id, with the bundled offline snapshot as that contract's
 *    documented last-resort floor.
 *
 * THE TWO `provider` FIELDS ARE NOT THE SAME FIELD. `identity.providerId` is
 * the RUNTIME discriminator and reads `"hosted"` for every hosted audit, while
 * `HostedCatalogModel.provider` is the UPSTREAM vendor behind the route
 * ("anthropic", "openai", …). Comparing them is a category error that matches
 * nothing, so the hosted branch checks the discriminator and then keys on the
 * route id alone. It does NOT fall back to the upstream label and does NOT
 * synthesize an alias.
 *
 * Because the hosted branch keys on id alone, it must prove that id is
 * UNAMBIGUOUS in the catalog it was handed: two rows sharing a public id are
 * two different routes, and picking either would be a guess. Duplicates
 * therefore resolve to `null`.
 *
 * Returning `null` is a correct and expected outcome. The caller's obligation
 * is to render "unavailable", never to substitute an estimate.
 */
export function resolveContextLimit(
  identity: ActiveModelIdentity,
  opts: {
    /** The live hosted catalog. Required for, and only used by, hosted audits. */
    hostedCatalog?: readonly HostedCatalogModel[] | null;
    /** Cache location overrides, for tests. */
    sync?: CatalogSyncOptions;
    /** Injectable catalog reader, for tests. */
    loadModels?: (opts: CatalogSyncOptions) => { source: string; models: readonly SyncedModel[] };
  } = {},
): ContextLimit | null {
  if (!identity.modelId || !identity.providerId) return null;

  if (identity.hosted) {
    // The runtime must actually say "hosted". A hosted audit whose runtime
    // reports some other discriminator is a state this function does not
    // understand, and guessing through it is exactly the failure mode the
    // hosted/BYOK split exists to prevent.
    if (identity.providerId !== HOSTED_PROVIDER_ID) return null;
    const catalog = opts.hostedCatalog;
    if (!catalog || catalog.length === 0) return null;
    // Key on the public route id alone — see the note above on why the two
    // `provider` fields cannot be compared — but only once it is proven
    // unique. `find` would silently take the first of a duplicate pair.
    const matches = catalog.filter((model) => model.id === identity.modelId);
    if (matches.length !== 1) return null;
    const row = matches[0]!;
    // The running route's context window must come from this catalog row.
    const tokens = positiveTokens(row.contextTokens);
    return tokens === null ? null : { tokens, source: "hosted-catalog" };
  }

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
  const family = knownFamilyWindow(identity.modelId);
  return family === null ? null : { tokens: family, source: "known-family" };
}

