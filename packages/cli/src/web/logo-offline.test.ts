import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "./dashboard-csp.js";

describe("logos and avatars stay on this origin", () => {
  it("keeps the CSP's img-src strict (self, data:, blob: only)", () => {
    const directive = /img-src ([^;]+)/.exec(buildContentSecurityPolicy("<html></html>"))?.[1];
    expect(directive).toBe("'self' data: blob:");
  });
});
