import { describe, expect, it } from "vitest";
import { buildViewMenu, flattenMenuRows } from "./view-menu-model";

const ids = (counts?: Parameters<typeof buildViewMenu>[0]["counts"]) => flattenMenuRows(buildViewMenu({ counts })).flatMap(row => (row.kind === "show-all" ? [] : [row.id]));

describe("Preview menu entry", () => {
  it("is hidden unless self-edit is enabled", () => {
    expect(ids({})).not.toContain("preview");
    expect(ids({ preview: 0 })).not.toContain("preview");
  });
  it("is listed without a badge when enabled", () => {
    expect(ids({ preview: "enabled" })).toContain("preview");
    const row = flattenMenuRows(buildViewMenu({ counts: { preview: "enabled" } })).find(entry => entry.kind === "view" && entry.id === "preview");
    expect(row).toMatchObject({ kind: "view", badge: undefined });
  });
});
