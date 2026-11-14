/**
 * Normalises the marketplace registry result (tool plugins) into a
 * single `MarketItem` shape. Install is not enablement; nothing here runs code.
 * Registry shapes are declared locally as structural views of untrusted data.
 */

import { sanitizeTuiText } from "./text.js";

// ---------------------------------------------------------------------------
// Registry shapes (untrusted; declared locally so this module owns no core d.ts)
// ---------------------------------------------------------------------------

/** A tool plugin entry, as `RegistryResult.entries` reports it. */
interface MarketPluginEntryView {
  id: string;
  version: string;
  manifest?: {
    name?: string;
    tools?: { name?: string; description?: string }[];
  };
  capabilities?: readonly string[];
  signatureState?: string;
}

/** The validated registry result. Either half may be absent or malformed. */
export interface MarketRegistryView {
  entries?: readonly MarketPluginEntryView[];
}

// ---------------------------------------------------------------------------
// Normalised item model
// ---------------------------------------------------------------------------

type MarketKind = "plugin";
type MarketSignature = "verified" | "unverified";

/**
 * A plugin's filesystem/enablement state.
 *
 * This is the honest security statement the browser makes, and it is DATA the
 * screen computes and hands in — never inferred from the registry:
 *
 * - `available` — not on this machine.
 * - `installed` — files on disk. For a plugin this is explicitly NOT enabled;
 *                 no plugin code has run.
 * - `enabled`   — a plugin an operator recorded an approval for (plugins only).
 */
export type MarketState = "available" | "installed" | "enabled";

export interface MarketItem {
  readonly kind: MarketKind;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** Requested capabilities. */
  readonly capabilities: readonly string[];
  readonly signature: MarketSignature;
  /**
   * The original registry view, kept so the install action can write the exact
   * validated bytes without re-deriving them. Opaque here.
   */
  readonly raw: unknown;
}

function signatureOf(state: unknown): MarketSignature {
  return state === "verified" ? "verified" : "unverified";
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** One-line description of a plugin, derived from its tool set. */
function pluginDescription(entry: MarketPluginEntryView): string {
  const tools = Array.isArray(entry.manifest?.tools) ? entry.manifest?.tools ?? [] : [];
  const named = tools.map((tool) => (nonEmpty(tool?.name) ? tool.name!.trim() : "")).filter(Boolean);
  if (named.length === 0) return "Tool plugin.";
  const count = named.length;
  return `${count} tool${count === 1 ? "" : "s"}: ${named.join(", ")}`;
}

/**
 * Flattens a fetched registry result into normalised items.
 *
 * Plugins come from `entries`. Everything else (theme/config artifacts,
 * unknown kinds, malformed rows) is skipped rather than surfaced — an item the browser cannot describe is noise.
 */
export function buildMarketItems(view: MarketRegistryView | undefined): MarketItem[] {
  const items: MarketItem[] = [];
  if (!view || typeof view !== "object") return items;

  for (const entry of view.entries ?? []) {
    if (!entry || typeof entry.id !== "string" || entry.id.length === 0) continue;
    const version = typeof entry.version === "string" ? entry.version : "";
    items.push({
      kind: "plugin",
      id: entry.id,
      name: nonEmpty(entry.manifest?.name) ? entry.manifest!.name!.trim() : entry.id,
      version,
      description: sanitizeTuiText(pluginDescription(entry)),
      capabilities: Array.isArray(entry.capabilities)
        ? entry.capabilities.filter((cap): cap is string => nonEmpty(cap))
        : [],
      signature: signatureOf(entry.signatureState),
      raw: entry,
    });
  }

  return items;
}
