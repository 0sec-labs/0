import { resolveStartChoice } from "@/console/provider-health";
import { beforeEach, describe, expect, it } from "vitest";
import { readLastModelChoice, readRecentModels, recordRecentModel, rememberModelChoice, resolveRecentModels, setRecommendedDefault, setResolvedStartModel, setSavedPreference, startingModelChoice, usableModelChoice, withRememberedModel } from "./last-model-choice";

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
  it("applies only to plain threads without an explicit runtime", () => {
    rememberModelChoice("local", { providerId: "openrouter", model: "m" });
    expect(withRememberedModel("local", { title: "x" })).toEqual({ title: "x", runtime: { providerId: "openrouter", model: "m" } });
    const own = { runtime: { model: "y" } };
    expect(withRememberedModel("local", own)).toBe(own);
    const bound = { workflowId: "w" };
    expect(withRememberedModel("local", bound)).toBe(bound);
  });
});

describe("host default model", () => {
  it("starts new threads when nothing is remembered, and loses to a remembered pick", () => {
    setRecommendedDefault("local", { providerId: "openai", model: "recommended" });
    setSavedPreference("local", { providerId: "anthropic", model: "saved" });
    expect(startingModelChoice("local")).toEqual({ providerId: "anthropic", model: "saved" });
    rememberModelChoice("local", { providerId: "openrouter", model: "picked" });
    expect(startingModelChoice("local")).toEqual({ providerId: "openrouter", model: "picked" });
    setSavedPreference("local", undefined); setRecommendedDefault("local", undefined);
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

describe("startingModelChoice", () => {
  it("is the model Home shows: the remembered pick, else the recommended default", () => {
    setRecommendedDefault("start-test", { providerId: "openai", model: "rec" });
    expect(startingModelChoice("start-test")).toEqual({ providerId: "openai", model: "rec" });
    rememberModelChoice("start-test", { providerId: "openrouter", model: "mine" });
    expect(startingModelChoice("start-test")).toEqual({ providerId: "openrouter", model: "mine" });
  });
});

describe("start model resolution", () => {
  const xai = { providerId: "xai", model: "gpt-xai-pro" };
  const openai = { providerId: "openai", model: "gpt-4.1" };
  const listed = [{ id: "gpt-4.1", provider: "openai" }, { id: "deepseek-flash", provider: "deepseek" }];
  // The composer applies the catalog check to every candidate, then picks the first that survives.
  const resolve = (candidates: Parameters<typeof resolveStartChoice>[0], models?: typeof listed) => resolveStartChoice({
    remembered: usableModelChoice(candidates.remembered, models), explicit: usableModelChoice(candidates.explicit, models),
    recommended: usableModelChoice(candidates.recommended, models), saved: usableModelChoice(candidates.saved, models),
  }, new Set()).choice;
  it("drops a remembered pick the catalog no longer lists and falls through", () => {
    expect(resolve({ remembered: xai, saved: openai }, listed)).toEqual(openai);
    expect(resolve({ remembered: xai }, listed)).toBeUndefined();
    expect(resolve({ remembered: xai }, [{ id: "gpt-xai-pro", provider: "xai", enabled: false } as never, ...listed])).toBeUndefined();
  });
  it("uses the provider-configured model last, so the label and the mission agree", () => {
    expect(resolve({ saved: openai }, listed)).toEqual(openai);
    expect(resolve({ recommended: { providerId: "deepseek", model: "deepseek-flash" }, saved: openai }, listed)).toEqual({ providerId: "deepseek", model: "deepseek-flash" });
    setResolvedStartModel("home", { choice: openai });
    expect(startingModelChoice("home")).toEqual(openai);
    expect(withRememberedModel("home", {})).toEqual({ runtime: openai });
    setResolvedStartModel("home", undefined);
  });
  it("starts on exactly what Home resolved, never the stale stored pick", () => {
    rememberModelChoice("stale", xai);
    expect(startingModelChoice("stale")).toEqual(xai); // catalog not loaded yet: trusted
    setResolvedStartModel("stale", { choice: undefined });
    expect(startingModelChoice("stale")).toBeUndefined();
    expect(withRememberedModel("stale", { title: "x" })).toEqual({ title: "x" });
    setResolvedStartModel("stale", undefined);
  });
  it("trusts every candidate until a catalog has loaded", () => {
    expect(resolve({ remembered: xai })).toEqual(xai);
  });
});
