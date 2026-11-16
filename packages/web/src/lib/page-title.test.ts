import { describe, expect, it } from "vitest";
import { pageTitleFor } from "./page-title";

describe("pageTitleFor", () => {
  it("titles each route and flags unknown paths", () => {
    expect(pageTitleFor("/findings/abc")).toBe("Findings · 0security");
    expect(pageTitleFor("/plugins/skills")).toBe("Skills · 0security");
    expect(pageTitleFor("/extensions")).toBe("Extensions · 0security");
    expect(pageTitleFor("/plugins/foo")).toBe("Plugins · 0security");
    expect(pageTitleFor("/nope")).toBe("Page not found · 0security");
  });
});
