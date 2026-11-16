import { describe, expect, it } from "vitest";
import { BRAND } from "./endpoints.js";

describe("BRAND", () => {
  it("keeps today's literals", () => {
    expect(BRAND.repo).toBe("0sec-labs/0security");
    expect(BRAND.repoUrl).toBe(`https://github.com/${BRAND.repo}`);
    expect(BRAND.foxguardUrl).toBe(`https://github.com/${BRAND.foxguardRepo}`);
  });
  it("is internally consistent", () => {
    for (const slug of [BRAND.repo, BRAND.foxguardRepo]) expect(slug.startsWith(`${BRAND.githubOrg}/`)).toBe(true);
  });
});
