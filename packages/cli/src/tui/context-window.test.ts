import { describe, expect, it } from "vitest";
import { resolveContextLimit } from "./context-window.js";
import type { HostedCatalogModel } from "./model-catalog.js";

const HOSTED = { modelId: "gpt-5.5", providerId: "hosted", hosted: true as const };

describe("resolveContextLimit — hosted family fallback", () => {
  it("prefers the live hosted catalog window when it carries the exact route", () => {
    const catalog: HostedCatalogModel[] = [
      { id: "gpt-5.5", contextTokens: 400_000 } as HostedCatalogModel,
    ];
    const r = resolveContextLimit(HOSTED, { hostedCatalog: catalog });
    expect(r).toEqual({ tokens: 400_000, source: "hosted-catalog" });
  });

  it("falls back to the published family window (not 'unavailable') when the catalog has not loaded", () => {
    const r = resolveContextLimit(HOSTED, { hostedCatalog: null });
    expect(r).toEqual({ tokens: 272_000, source: "known-family" });
  });

  it("falls back to the family window when the catalog is ambiguous or lacks a usable window", () => {
    const dup: HostedCatalogModel[] = [
      { id: "gpt-5.5", contextTokens: 400_000 } as HostedCatalogModel,
      { id: "gpt-5.5", contextTokens: 300_000 } as HostedCatalogModel,
    ];
    expect(resolveContextLimit(HOSTED, { hostedCatalog: dup })).toEqual({ tokens: 272_000, source: "known-family" });
  });

  it("still returns null for a hosted model with no known family", () => {
    const r = resolveContextLimit({ modelId: "mystery-9", providerId: "hosted", hosted: true }, { hostedCatalog: null });
    expect(r).toBeNull();
  });
});
