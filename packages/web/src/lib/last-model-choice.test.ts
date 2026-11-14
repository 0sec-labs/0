import { beforeEach, describe, expect, it } from "vitest";
import { readLastModelChoice, readRecentModels, recordRecentModel, rememberModelChoice, resolveRecentModels, usableModelChoice, withRememberedModel } from "./last-model-choice";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } } });
});

describe("last model choice", () => {
  it("round-trips per backend and ignores junk", () => {
    expect(readLastModelChoice("local")).toBeUndefined();
    rememberModelChoice("local", { providerId: "openrouter", model: "z-ai/glm-5.3-flash" });
    expect(readLastModelChoice("local")).toEqual({ providerId: "openrouter", model: "z-ai/glm-5.3-flash" });
    expect(readLastModelChoice("other")).toBeUndefined();
    store.set("0-last-model:bad", "{nope");
    expect(readLastModelChoice("bad")).toBeUndefined();
  });
  it("applies only to plain missions without an explicit runtime", () => {
    rememberModelChoice("local", { providerId: "openrouter", model: "m" });
    expect(withRememberedModel("local", { title: "x" })).toEqual({ title: "x", runtime: { providerId: "openrouter", model: "m" } });
    const own = { runtime: { model: "y" } };
    expect(withRememberedModel("local", own)).toBe(own);
    const bound = { workflowId: "w" };
    expect(withRememberedModel("local", bound)).toBe(bound);
  });
});

describe("recent models", () => {
  const a = { providerId: "openai", model: "gpt-5.5" }, b = { providerId: "anthropic", model: "claude-opus-4-5" }, c = { providerId: "deepseek", model: "deepseek-chat" }, d = { providerId: "openai", model: "gpt-4.1" };
  it("keeps the last three distinct picks per backend, most recent first", () => {
    for (const choice of [a, b, c, a, d]) recordRecentModel("local", choice);
    expect(readRecentModels("local")).toEqual([d, a, c]);
    expect(readRecentModels("other")).toEqual([]);
  });
  it("is fed by rememberModelChoice and survives junk", () => {
    rememberModelChoice("local", a);
    expect(readRecentModels("local")).toEqual([a]);
    store.set("0-recent-models:bad", JSON.stringify([null, { providerId: 1 }, a, a]));
    expect(readRecentModels("bad")).toEqual([a]);
    store.set("0-recent-models:bad2", "{nope");
    expect(readRecentModels("bad2")).toEqual([]);
  });
  it("drops stale or disabled ids that left the catalog", () => {
    const catalog = [{ id: "gpt-5.5", provider: "openai" }, { id: "deepseek-chat", provider: "deepseek", enabled: false }, { id: "claude-opus-4-5", provider: "anthropic" }];
    expect(resolveRecentModels([c, a, d, b], catalog).map(row => row.id)).toEqual(["gpt-5.5", "claude-opus-4-5"]);
  });
  it("trusts the remembered choice only while its provider lists it", () => {
    expect(usableModelChoice(a, undefined)).toBe(a);
    expect(usableModelChoice(a, [{ id: "gpt-5.5", provider: "openai" }])).toBe(a);
    expect(usableModelChoice(a, [{ id: "gpt-5.5", provider: "azure" }])).toBeUndefined();
    expect(usableModelChoice(a, [{ id: "gpt-5.5", provider: "openai", enabled: false }])).toBeUndefined();
    expect(usableModelChoice(undefined, [])).toBeUndefined();
  });
});
