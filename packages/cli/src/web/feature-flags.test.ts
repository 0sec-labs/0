import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FEATURE_FLAG_DEFINITIONS, describeFeatureFlags } from "./feature-flags.js";

const source = readFileSync(new URL("../../../engine/src/agent/features.ts", import.meta.url), "utf8");

describe("feature flag registry", () => {
  it("covers every ZERO_FEATURE_ flag the engine reads, with the same default", () => {
    const engine = new Map([...source.matchAll(/env\("(ZERO_FEATURE_[A-Z_]+)",\s*([^)]*(?:\([^)]*\)[^)]*)*)\)/g)].map(m => [m[1]!, m[2]!.trim()]));
    expect(engine.size).toBeGreaterThan(45);
    expect(new Set(FEATURE_FLAG_DEFINITIONS.map(f => f.env))).toEqual(new Set(engine.keys()));
    for (const flag of FEATURE_FLAG_DEFINITIONS) {
      const raw = engine.get(flag.env)!;
      if (raw === "true" || raw === "false") expect(flag.default, flag.env).toBe(raw === "true");
    }
    expect(new Set(FEATURE_FLAG_DEFINITIONS.map(f => f.id)).size).toBe(FEATURE_FLAG_DEFINITIONS.length);
  });
  it("reports env, preset and default sources and stays read-only", () => {
    const read = (value: boolean) => () => value;
    const byEnv = describeFeatureFlags({ ZERO_FEATURE_POV_GATE: "1" }, read(true));
    expect(byEnv.flags.find(f => f.id === "povGate")).toMatchObject({ source: "env", value: true, tier: "experimental", settable: false });
    const preset = describeFeatureFlags({ ZERO_FEATURE_PRESET: "fp-moat" }, id => id === "povGate");
    expect(preset.preset).toBe("fp-moat");
    expect(preset.flags.find(f => f.id === "povGate")?.source).toBe("preset");
    expect(preset.flags.find(f => f.id === "loopDetection")).toMatchObject({ source: "default", tier: "stable" });
    expect(preset.settable).toBe(false);
  });
  it("never includes non-flag environment values", () => {
    const json = JSON.stringify(describeFeatureFlags({ OPENAI_API_KEY: "sk-secret-value", ZERO_FEATURE_PRESET: "x" }, () => false));
    expect(json).not.toContain("sk-secret-value");
  });
});
