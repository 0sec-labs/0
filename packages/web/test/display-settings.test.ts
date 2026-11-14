import { describe, expect, it } from "vitest";
import { DEFAULT_DISPLAY_SETTINGS, readDisplaySettings } from "../src/lib/display-settings";
import { searchSettings } from "../src/components/console-control/settings-index";

describe("display settings", () => {
  it("maps engine values onto browser behaviour and falls back to engine defaults", () => {
    expect(readDisplaySettings(undefined)).toEqual(DEFAULT_DISPLAY_SETTINGS);
    expect(readDisplaySettings({ density: "compact", toolCardStyle: "hidden", transcriptDetail: "expanded", elapsedTimer: "off", showCost: false })).toMatchObject({ density: "compact", toolCardStyle: "hidden", transcriptDetail: "expanded", elapsedTimer: false, showCost: false, showContextMeter: true });
    expect(readDisplaySettings({ toolCardStyle: "rail", showCost: "no" })).toMatchObject({ toolCardStyle: "visible", showCost: true });
  });
  it("makes every new setting and page searchable", () => {
    const hit = (query: string, key: string) => searchSettings(query).some(group => group.entries.some(entry => entry.key === key));
    expect(hit("cost", "showCost")).toBe(true);
    expect(hit("tokens", "showTokenUsage")).toBe(true);
    expect(hit("context", "showContextMeter")).toBe(true);
    expect(hit("timestamps", "showTimestamps")).toBe(true);
    expect(hit("spacing", "density")).toBe(true);
    expect(hit("work log", "transcriptDetail")).toBe(true);
    expect(searchSettings("usage").some(group => group.category.id === "usage")).toBe(true);
  });
});
