import { describe, expect, it } from "vitest";
import { BRAND } from "./endpoints.js";
import { DEFAULT_REGISTRY_URL } from "../plugins/registry-client.js";

describe("BRAND", () => {
  it("keeps today's literals", () => {
    expect(BRAND.repo).toBe("0sec-labs/0");
    expect(BRAND.repoUrl).toBe(`https://github.com/${BRAND.repo}`);
    expect(BRAND.foxguardUrl).toBe(`https://github.com/${BRAND.foxguardRepo}`);
    expect(BRAND.registryIndexUrl).toBe("https://raw.githubusercontent.com/0sec-labs/hackstore/main/index.json");
    expect(DEFAULT_REGISTRY_URL).toBe(BRAND.registryIndexUrl);
  });
  it("is internally consistent", () => {
    for (const slug of [BRAND.repo, BRAND.foxguardRepo, BRAND.registryRepo]) expect(slug.startsWith(`${BRAND.githubOrg}/`)).toBe(true);
  });
});
