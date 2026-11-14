import { describe, expect, it } from "vitest";
import { contrastRatio, parseAccent, parseColor, parseFontSize, parseMotionPreference, parseThemePreference, resolveReducedMotion, resolveTheme } from "./appearance-model";

describe("contrast maths", () => {
  it("matches known WCAG ratios", () => {
    expect(contrastRatio(parseColor("#000")!, parseColor("#fff")!)).toBeCloseTo(21, 1);
    expect(contrastRatio(parseColor("#767676")!, parseColor("#ffffff")!)).toBeCloseTo(4.54, 1);
    expect(parseColor("oklch(100% 0 0)")!.r).toBeCloseTo(1, 2);
    expect(parseColor("nope")).toBeUndefined();
  });
});

describe("preference parsing", () => {
  it("keeps stored values valid and defaults unchanged", () => {
    expect(["light", "dark", "system"].map(parseThemePreference)).toEqual(["light", "dark", "system"]);
    expect(parseThemePreference(null)).toBe("dark");
    expect(parseThemePreference("sepia")).toBe("dark");
    expect(parseAccent("blue")).toBe("blue");
    expect(parseAccent("pink")).toBe("orange");
    expect(parseFontSize("large")).toBe("large");
    expect(parseFontSize("huge")).toBe("default");
    expect(parseMotionPreference("reduce")).toBe("reduce");
    expect(parseMotionPreference(undefined)).toBe("system");
  });
  it("resolves system mode and motion overrides", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveReducedMotion("system", true)).toBe(true);
    expect(resolveReducedMotion("system", false)).toBe(false);
    expect(resolveReducedMotion("reduce", false)).toBe(true);
    expect(resolveReducedMotion("full", true)).toBe(false);
  });
});
