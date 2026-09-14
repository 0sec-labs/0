import { describe, expect, it } from "vitest";

import { MODEL_PRICING } from "@0sec/shared";

import {
  buildModelCatalog,
  scopeModelCatalog,
  type CatalogModel,
} from "./model-catalog.js";
import { buildModelRows } from "./model-layout.js";
import { providerStates } from "./provider-status.js";

// Gateway duplicates (same id, several providers) plus one synced-only id.
// `gpt-5.5` / `mimo-v2.5-free` are priced core ids.
const CATALOG: CatalogModel[] = [
  { id: "gpt-5.5", provider: "openai", price: "$5/30 per M" },
  { id: "GPT-5.5", provider: "tokengo", price: "$5/30 per M" },
  { id: "mimo-v2.5-free", provider: "opencode", price: "free" },
  { id: "totally-new-model", provider: "acme", price: "\u2014" },
];

describe("scopeModelCatalog", () => {
  it("curates to the priced core: one canonical row per priced id", () => {
    const curated = scopeModelCatalog(CATALOG, {});
    expect(curated).toEqual(buildModelCatalog());
    expect(curated).toHaveLength(Object.keys(MODEL_PRICING).length - 1);
    // Gateway case-duplicates of a priced id never leak into the default view.
    expect(curated.filter((m) => m.id.toLowerCase() === "gpt-5.5")).toHaveLength(1);
    expect(curated.some((m) => m.provider === "opencode")).toBe(true);
  });

  it("a non-blank filter searches the full catalog, duplicates included", () => {
    const scoped = scopeModelCatalog(CATALOG, { filter: "gpt-5.5" });
    expect(scoped).toHaveLength(CATALOG.length);
    const rows = buildModelRows({ catalog: scoped, states: providerStates({}), filter: "gpt-5.5" });
    expect(rows.filter((r) => r.kind === "model")).toHaveLength(2);
  });

  it("keeps the active model even when it is unpriced", () => {
    const curated = scopeModelCatalog(CATALOG, { currentModel: "totally-new-model" });
    expect(curated[0].id).toBe("totally-new-model");
    expect(curated.some((m) => m.id === "totally-new-model")).toBe(true);
  });

  it("showAll returns the full catalog untouched", () => {
    expect(scopeModelCatalog(CATALOG, { showAll: true })).toHaveLength(CATALOG.length);
  });
});
