import { describe, expect, it } from "vitest";
import { filterFlags, flagDetail, groupFlags, toggleHint, type FeatureFlagRow } from "./experiments-model";

const flag = (patch: Partial<FeatureFlagRow>): FeatureFlagRow => ({ id: "x", env: "ZERO_FEATURE_X", label: "Alpha", description: "Does alpha things", default: false, value: false, source: "default", tier: "experimental", settable: false, ...patch });

describe("experiments model", () => {
  it("groups by tier and sorts by label", () => {
    const groups = groupFlags([flag({ label: "B" }), flag({ label: "A" }), flag({ label: "C", tier: "stable", default: true, value: true })]);
    expect(groups.experimental.map(f => f.label)).toEqual(["A", "B"]);
    expect(groups.stable.map(f => f.label)).toEqual(["C"]);
  });
  it("filters on label, description and variable name", () => {
    const flags = [flag({ label: "Loop detection", env: "ZERO_FEATURE_LOOP_DETECTION" }), flag({ label: "Other", description: "mentions web search" })];
    expect(filterFlags(flags, "loop")).toHaveLength(1);
    expect(filterFlags(flags, "web search")).toHaveLength(1);
    expect(filterFlags(flags, "feature_loop")).toHaveLength(1);
    expect(filterFlags(flags, "")).toHaveLength(2);
    expect(filterFlags(flags, "zzz")).toHaveLength(0);
  });
  it("describes source and the variable to export", () => {
    expect(flagDetail(flag({ default: true, value: false, source: "env" }))).toBe("Default on · Set by environment");
    expect(flagDetail(flag({ default: true })) ).toBe("Default on");
    expect(flagDetail(flag({ source: "preset" }))).toBe("Default off · Raised by preset");
    expect(toggleHint(flag({ value: false }))).toBe("ZERO_FEATURE_X=1");
    expect(toggleHint(flag({ value: true }))).toBe("ZERO_FEATURE_X=0");
  });
});
