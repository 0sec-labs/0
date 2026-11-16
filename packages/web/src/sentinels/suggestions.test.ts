import { describe, expect, it } from "vitest";
import { addedSuggestions, suggestedSchedule, type SentinelPresetAutomation } from "./model";

const item = (name: string, templateId: string | undefined, kind: "schedule" | "manual" = "manual"): SentinelPresetAutomation => ({ name, templateId, trigger: { kind }, runIn: "new-mission" });

describe("suggested schedule", () => {
  it("starts each cadence at a reviewable time in the given zone", () => {
    expect(suggestedSchedule("hourly", "Europe/Zurich")).toEqual({ frequency: "hourly", timezone: "Europe/Zurich" });
    expect(suggestedSchedule("daily", "UTC")).toEqual({ frequency: "daily", time: "09:00", timezone: "UTC" });
    expect(suggestedSchedule("weekly", "UTC")).toEqual({ frequency: "weekly", weekday: 1, time: "09:00", timezone: "UTC" });
    expect(suggestedSchedule(undefined, "UTC")).toBeUndefined();
  });
});

describe("added suggestions", () => {
  it("counts one owned automation per suggestion, so two suggestions on one template are not both added by one", () => {
    const items = [item("Daily secrets sweep", "repository-review", "schedule"), item("Sweep on demand", "repository-review")];
    expect(addedSuggestions(items, [])).toEqual([false, false]);
    expect(addedSuggestions(items, ["repository-review"])).toEqual([true, false]);
    expect(addedSuggestions(items, ["repository-review", "repository-review"])).toEqual([true, true]);
    expect(addedSuggestions([item("Manual", undefined)], ["repository-review"])).toEqual([false]);
  });
});
