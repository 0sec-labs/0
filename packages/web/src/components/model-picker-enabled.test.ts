import { describe, expect, it } from "vitest";
import { filterModels, isModelEnabled } from "./model-picker";
import { readModelCatalog, writeModelCatalog } from "@/lib/model-catalog-cache";

describe("model enablement", () => {
  it("treats a missing flag as enabled and only false as off", () => {
    expect(isModelEnabled({})).toBe(true);
    expect(isModelEnabled({ enabled: true })).toBe(true);
    expect(isModelEnabled({ enabled: false })).toBe(false);
  });
  it("keeps disabled rows in search results so they can be shown as turned off", () => {
    const models = [{ id: "a", provider: "openai", enabled: false }, { id: "b", provider: "openai", enabled: true }];
    expect(filterModels(models, "", "").map(model => model.id)).toEqual(["a", "b"]);
    expect(filterModels(models, "", "").filter(isModelEnabled).map(model => model.id)).toEqual(["b"]);
  });
  it("keeps the enabled flag through the session cache", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) };
    const scope = { backendId: "b1" };
    writeModelCatalog(scope, { models: [{ id: "a", provider: "openai", price: "", contextWindowTokens: null, source: "account", enabled: false }], providerId: null, diagnostics: [], roles: [] }, storage);
    expect(readModelCatalog(scope, storage)?.models[0]?.enabled).toBe(false);
  });
});
