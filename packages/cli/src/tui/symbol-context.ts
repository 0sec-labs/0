/**
 * The active glyph set, derived from the live settings and delivered
 * subscribably.
 *
 * Mirrors `theme-context.ts` exactly, for the orthogonal glyph axis: it selects
 * a table from the registry in `symbols.ts` by preset name and hands it to
 * consumers, re-rendering them when the `symbolPreset` setting changes — but it
 * defines no glyph VALUE. Every glyph lives in `symbols.ts`; this only chooses
 * and delivers one.
 *
 * `getSymbols` is already total (an unknown or hand-corrupted preset degrades to
 * the default), so nothing here needs to guard the name.
 *
 * Symbols are kept parallel to `Theme`, not folded into it: `themes.ts` is a
 * colour palette registry, and attaching glyphs there would force every
 * installed-theme JSON to grow a symbol block and couple two orthogonal axes.
 * Two hooks, two params — the same separation `theme-context.ts` already keeps.
 */

import { getSymbols, type SymbolPreset, type SymbolTable } from "./symbols.js";
import type { TuiSettings } from "./settings.js";
import { useSettings } from "./settings-store.js";

export type { SymbolTable, SymbolKey, SymbolPreset } from "./symbols.js";

/**
 * Tables are cached by preset name so a given preset always yields the *same*
 * object reference across renders. That stability matters: a fresh object every
 * render would defeat downstream memoisation and prop-identity checks even when
 * the preset never changed.
 */
const cache = new Map<SymbolPreset, SymbolTable>();

function tableFor(preset: SymbolPreset): SymbolTable {
  let cached = cache.get(preset);
  if (!cached) {
    cached = getSymbols(preset);
    cache.set(preset, cached);
  }
  return cached;
}

/**
 * Pure selection of the glyph table for a settings object. Use this when you
 * already hold a settings value and want the table it names (tests, non-React
 * call sites). React components want `useSymbols`, which also delivers changes
 * live.
 */
export function activeSymbols(settings: TuiSettings): SymbolTable {
  return tableFor(settings.symbolPreset);
}

/**
 * React hook: the live glyph table. Subscribes to the settings store, so a
 * preset change re-renders every consumer. Returns a stable reference while the
 * preset is unchanged.
 */
export function useSymbols(): SymbolTable {
  return tableFor(useSettings().symbolPreset);
}
