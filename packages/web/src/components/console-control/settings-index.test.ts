import { describe, expect, it } from "vitest";
import { categoriesOfPage, searchSettings, settingsPageId, settingsPages, settingsRedirect } from "./settings-index";

describe("settings pages", () => {
  it("stay a short list", () => { expect(settingsPages.length).toBeLessThanOrEqual(10); });
  it("redirect removed sections to the closest page or route", () => {
    expect(settingsRedirect("transcript")).toBe("/settings?section=missions");
    expect(settingsRedirect("privacy")).toBe("/settings?section=agents");
    expect(settingsRedirect("repositories")).toBe("/settings?section=git");
    expect(settingsRedirect("finding-states")).toBe("/findings");
    expect(settingsRedirect("integrations")).toBe("/plugins");
    expect(settingsRedirect("skills")).toBe("/plugins/skills");
    expect(settingsRedirect("members")).toBe("/team");
    expect(settingsRedirect("git")).toBeUndefined();
    expect(settingsRedirect(null)).toBeUndefined();
  });
  it("resolve any section value to a page", () => {
    expect(settingsPageId("telemetry")).toBe("missions");
    expect(settingsPageId("audit-log")).toBe("audit-log");
    expect(settingsPageId("bogus")).toBe("general");
    expect(settingsPageId(null)).toBe("general");
  });
  it("show merged categories as sections of one page", () => {
    expect(categoriesOfPage("missions")).toEqual(["conversation", "transcript", "telemetry"]);
    expect(categoriesOfPage("agents")).toEqual(["agents", "privacy"]);
  });
  it("search reaches rows on merged pages", () => {
    const hits = searchSettings("elapsed");
    expect(hits.map(group => group.category.id)).toEqual(["missions"]);
    expect(searchSettings("repository search")[0]?.category.id).toBe("git");
    expect(searchSettings("finding states")).toEqual([]);
  });
});
