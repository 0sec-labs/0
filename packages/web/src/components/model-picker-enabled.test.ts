import { describe, expect, it } from "vitest";
import { arrangeCatalog, filterModels, isModelEnabled } from "./model-picker";
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

describe("catalog arrangement", () => {
  const models = ["gpt-5.2-pro", "gpt-5-2025-08-07", "gpt-5", "gpt-5.2-pro-2025-12-11", "gpt-5.5-pro-2026-04-23", "gpt-4.1", "gpt-5.5", "gpt-4o"].map(id => ({ id, provider: "openai" }))
    .concat([{ id: "claude-sonnet-4-5", provider: "anthropic" }, { id: "claude-opus-4-5", provider: "anthropic" }, { id: "deepseek-chat", provider: "deepseek" }]);
  it("orders newest first, hides snapshots and leads with the selected provider", () => {
    const layout = arrangeCatalog({ models, selectedProvider: "anthropic" });
    expect(layout.groups.map(group => group.id)).toEqual(["anthropic", "openai", "deepseek"]);
    expect(layout.groups[0]!.models.map(row => row.id)).toEqual(["claude-opus-4-5", "claude-sonnet-4-5"]);
    expect(layout.groups[1]!.models.map(row => row.id)).toEqual(["gpt-5.5-pro-2026-04-23", "gpt-5.5", "gpt-5.2-pro", "gpt-5", "gpt-4.1", "gpt-4o"]);
    expect(layout.recent).toEqual([]);
  });
  it("shows recents first, ranks provider by them, and hides them while searching", () => {
    const recents = [{ providerId: "deepseek", model: "deepseek-chat" }, { providerId: "openai", model: "retired-model" }];
    const layout = arrangeCatalog({ models, recents });
    expect(layout.recent.map(row => row.id)).toEqual(["deepseek-chat"]);
    expect(layout.groups[0]!.id).toBe("deepseek");
    expect(arrangeCatalog({ models, recents, query: "claude" }).recent).toEqual([]);
  });
  it("search keeps prefix matches first and lets a date query find snapshots", () => {
    expect(arrangeCatalog({ models, query: "opus" }).groups.flatMap(group => group.models.map(row => row.id))[0]).toBe("claude-opus-4-5");
    expect(arrangeCatalog({ models, query: "2025-08" }).groups[0]!.models.map(row => row.id)).toEqual(["gpt-5-2025-08-07"]);
    expect(arrangeCatalog({ models, query: "gpt-5" }).groups[0]!.models.map(row => row.id)).not.toContain("gpt-5-2025-08-07");
  });
});

describe("failing providers", () => {
  it("never list a failing provider or its models", () => {
    const models = [{ id: "gpt-5", provider: "openai" }, { id: "deepseek-chat", provider: "deepseek" }];
    const layout = arrangeCatalog({ models, diagnostics: [{ providerId: "deepseek" }, { providerId: "azure" }] });
    expect(layout.groups.map(group => group.id)).toEqual(["openai"]);
  });
});
