import { describe, expect, it } from "vitest";
import { categoriesOfPage, searchSettings, settingsPageId, settingsRedirect } from "./settings-index";

describe("settings pages", () => {
  it("redirect a removed section and leave live ones alone", () => {
    expect(settingsRedirect("finding-states")).toBe("/findings");
    expect(settingsRedirect("git")).toBeUndefined();
    expect(settingsRedirect(null)).toBeUndefined();
  });
  it("resolve any section value to a page", () => {
    expect(settingsPageId("telemetry")).toBe("threads");
    expect(settingsPageId("audit-log")).toBe("audit-log");
    expect(settingsPageId("bogus")).toBe("general");
    expect(settingsPageId(null)).toBe("general");
  });
  it("show merged categories as sections of one page", () => {
    expect(categoriesOfPage("threads")).toEqual(["conversation", "transcript", "telemetry"]);
    expect(categoriesOfPage("helpers")).toEqual(["agents"]);
    expect(categoriesOfPage("general")).toEqual(["general", "input", "privacy"]);
  });
  it("search reaches rows on merged pages", () => {
    const hits = searchSettings("elapsed");
    expect(hits.map(group => group.category.id)).toEqual(["threads"]);
    expect(searchSettings("repository search")[0]?.category.id).toBe("git");
    expect(searchSettings("finding states")).toEqual([]);
  });
});
