import { beforeEach, describe, expect, it } from "vitest";
import { readLastModelChoice, rememberModelChoice, withRememberedModel } from "./last-model-choice";

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
