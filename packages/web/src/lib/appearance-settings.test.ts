import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, accentsForTheme, migrateAppearance, modesForTheme, parseAppearance } from "./appearance-settings";

describe("parseAppearance", () => {
  it("falls back to the defaults for nothing, junk and wrong types", () => {
    expect(parseAppearance({})).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance({ mode: "sepia", theme: "nope", accent: 4, background: "matrix", fontSize: "huge", motion: null })).toEqual(DEFAULT_APPEARANCE);
  });
  it("keeps valid values", () => {
    expect(parseAppearance({ mode: "dark", theme: "zero", accent: "blue", background: "ink", fontSize: "large", motion: "reduce" })).toEqual({ mode: "dark", theme: "zero", accent: "blue", background: "ink", fontSize: "large", motion: "reduce" });
  });
  it("reads a removed background as Dither and keeps none", () => {
    for (const old of ["aurora", "grid", "scanline", "code-rain", "waves", "ripple", "constellation", "topography"]) expect(parseAppearance({ background: old }).background, old).toBe("dither-top");
    expect(parseAppearance({ background: "none" }).background).toBe("none");
  });
  it("drops an accent the theme cannot take", () => {
    expect(parseAppearance({ theme: "nord", accent: "rose" }).accent).toBe("neutral");
    expect(accentsForTheme("nord")).toEqual([]);
    expect(accentsForTheme("zero").length).toBeGreaterThan(1);
    expect(modesForTheme("zero")).toEqual(["system", "light", "dark"]);
  });
});

describe("migrateAppearance", () => {
  const reader = (data: Record<string, string>) => (key: string) => data[key] ?? null;
  it("reads the current keys", () => {
    const { settings, writes } = migrateAppearance(reader({ "zero-web-theme": "light", "zero-web-background": "contours", "zero-web-font-size": "small", "zero-web-motion": "full", "zero-web-accent-v2": "green" }));
    expect(settings).toMatchObject({ mode: "light", background: "contours", fontSize: "small", motion: "full", accent: "green" });
    expect(writes).toEqual({});
  });
  it("carries over a legacy non-orange accent once and ignores the old orange default", () => {
    expect(migrateAppearance(reader({ "zero-web-accent": "violet" }))).toMatchObject({ settings: { accent: "violet" }, writes: { "zero-web-accent-v2": "violet" } });
    expect(migrateAppearance(reader({ "zero-web-accent": "orange" }))).toMatchObject({ settings: { accent: "neutral" }, writes: {} });
  });
  it("prefers the new accent key over the legacy one", () => {
    expect(migrateAppearance(reader({ "zero-web-accent": "blue", "zero-web-accent-v2": "rose" })).settings.accent).toBe("rose");
  });
});
