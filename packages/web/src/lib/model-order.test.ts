import { describe, expect, it } from "vitest";
import { compareVersions, hideSnapshots, orderModels, orderProviders, parseModelId, rankSearch } from "./model-order";

const m = (id: string, provider = "openai", enabled?: boolean) => ({ id, provider, enabled });
const ids = (rows: { id: string }[]) => rows.map(row => row.id);

describe("parseModelId", () => {
  it("reads versions, tiers and snapshots", () => {
    expect(parseModelId("gpt-5.2-pro")).toMatchObject({ version: [5, 2], tier: 0, snapshot: false });
    expect(parseModelId("gpt-5.2-pro-2025-12-11")).toMatchObject({ version: [5, 2], snapshot: true, alias: "gpt-5.2-pro" });
    expect(parseModelId("claude-sonnet-4-5-20250929")).toMatchObject({ version: [4, 5], snapshot: true, tier: 1 });
    expect(parseModelId("claude-3-5-haiku")).toMatchObject({ version: [3, 5], tier: 2 });
    expect(parseModelId("gpt-4o-mini")).toMatchObject({ tier: 2 });
    expect(parseModelId("gemini-2.5-flash-lite").tier).toBe(3);
    expect(parseModelId("anthropic/claude-opus-4.5")).toMatchObject({ vendor: "anthropic", version: [4, 5], tier: 0 });
    expect(parseModelId("deepseek-chat").version).toEqual([]);
  });
  it("compares versions numerically, not as strings", () => {
    expect(compareVersions([5, 10], [5, 9])).toBeGreaterThan(0);
    expect(compareVersions([5, 1], [5])).toBeGreaterThan(0);
    expect(compareVersions([10], [9])).toBeGreaterThan(0);
  });
});

describe("orderModels", () => {
  it("puts the newest generation first and keeps 4.1 above 4o", () => {
    const rows = ["gpt-4o", "gpt-5.2", "gpt-4.1", "gpt-5.6-terra", "gpt-5.5", "gpt-5.10"].map(id => m(id));
    expect(ids(orderModels(rows))).toEqual(["gpt-5.10", "gpt-5.6-terra", "gpt-5.5", "gpt-5.2", "gpt-4.1", "gpt-4o"]);
    expect(ids(orderModels(["claude-sonnet-4-5", "claude-sonnet-5", "claude-sonnet-4"].map(id => m(id, "anthropic"))))).toEqual(["claude-sonnet-5", "claude-sonnet-4-5", "claude-sonnet-4"]);
  });
  it("ranks flagship, then standard, then compact inside a generation", () => {
    const rows = ["gpt-5.2-nano", "gpt-5.2-mini", "gpt-5.2", "gpt-5.2-pro"].map(id => m(id));
    expect(ids(orderModels(rows))).toEqual(["gpt-5.2-pro", "gpt-5.2", "gpt-5.2-mini", "gpt-5.2-nano"]);
    expect(ids(orderModels(["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"].map(id => m(id, "anthropic"))))).toEqual(["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"]);
  });
  it("is deterministic regardless of input order", () => {
    const rows = ["gpt-5", "gpt-4o", "gpt-5.5", "o3-mini", "gpt-4.1"].map(id => m(id));
    expect(ids(orderModels([...rows].reverse()))).toEqual(ids(orderModels(rows)));
  });
  it("groups gateway ids by maker", () => {
    const rows = ["openai/gpt-4o", "anthropic/claude-opus-4.5", "openai/gpt-5", "anthropic/claude-sonnet-4"].map(id => m(id, "openrouter"));
    expect(ids(orderModels(rows))).toEqual(["openai/gpt-5", "openai/gpt-4o", "anthropic/claude-opus-4.5", "anthropic/claude-sonnet-4"]);
  });
});

describe("hideSnapshots", () => {
  it("hides dated ids whose alias is listed and keeps orphans", () => {
    const rows = [m("gpt-5"), m("gpt-5-2025-08-07"), m("gpt-5.2-pro"), m("gpt-5.2-pro-2025-12-11"), m("gpt-5.5-pro-2026-04-23"), m("gpt-5-2025-08-07", "azure")];
    expect(hideSnapshots(rows).map(row => `${row.provider}:${row.id}`)).toEqual(["openai:gpt-5", "openai:gpt-5.2-pro", "openai:gpt-5.5-pro-2026-04-23", "azure:gpt-5-2025-08-07"]);
  });
});

describe("orderProviders", () => {
  const models = [m("a", "openai"), m("b", "openai"), m("c", "anthropic"), m("d", "deepseek"), m("e", "deepseek"), m("f", "deepseek"), m("g", "google", false)];
  const providers = ["openai", "anthropic", "deepseek", "google"];
  it("lists the selected provider first, then recents, then by healthy models", () => {
    expect(orderProviders(models, providers, { selectedProvider: "anthropic" })).toEqual(["anthropic", "deepseek", "openai", "google"]);
    expect(orderProviders(models, providers, { selectedProvider: "openai", recentProviders: ["google", "anthropic"] })).toEqual(["openai", "google", "anthropic", "deepseek"]);
  });
  it("puts failing providers last, even the selected one", () => {
    expect(orderProviders(models, providers, { selectedProvider: "deepseek", failing: new Set(["deepseek"]) }).at(-1)).toBe("deepseek");
  });
});

describe("rankSearch", () => {
  it("leads with name prefixes, then word starts, then substrings, then the normal order", () => {
    const rows = [m("my-gpt-5"), m("gpt-4o"), m("xgpt"), m("gpt-5.5"), m("gpt-5.2")];
    expect(ids(rankSearch(rows, "gpt"))).toEqual(["gpt-5.5", "gpt-5.2", "gpt-4o", "my-gpt-5", "xgpt"]);
  });
});
