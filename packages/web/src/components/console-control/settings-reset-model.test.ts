import { describe, expect, it } from "vitest";
import { describeSettingValue, isProtectedSetting, planReset } from "./settings-reset-model";

const defs = [
  { key: "density", label: "Density", default: "comfortable" },
  { key: "showCost", label: "Cost", default: true },
  { key: "analyticsLevel", label: "Usage metrics", default: "usage" },
  { key: "allowModelSelfExtension", label: "Plugins", default: true },
  { key: "showStatusBar", label: "Terminal", default: true },
];
describe("planReset", () => {
  const values = { density: "compact", showCost: true, analyticsLevel: "off", allowModelSelfExtension: false, showStatusBar: false };
  it("display scope excludes safety and privacy keys and lists only real changes", () => {
    const plan = planReset("display", defs, values);
    expect(plan.keys).toEqual(["density"]);
    expect(plan.changes[0]).toMatchObject({ from: "On", to: "Off" });
    expect(plan.untouched.map(item => item.key)).toEqual(["analyticsLevel", "allowModelSelfExtension"]);
  });
  it("protected scope covers only safety and privacy keys", () => {
    const plan = planReset("protected", defs, values);
    expect(plan.keys).toEqual(["analyticsLevel", "allowModelSelfExtension"]);
    expect(plan.untouched).toEqual([]);
  });
  it("never includes terminal-only keys and honours explicit lists", () => {
    expect(planReset(["showStatusBar", "density"], defs, values).keys).toEqual(["density"]);
  });
  it("formats values", () => {
    expect(describeSettingValue("showCost", false)).toBe("Off");
    expect(isProtectedSetting("updatePolicy")).toBe(true);
    expect(isProtectedSetting("density")).toBe(false);
  });
});
