import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASES } from "./releases";
import { compareVersions, releaseIndex, shouldAutoOpenWhatsNew, showWhatsNewCard } from "./whats-new";

describe("release data", () => {
  it("only shows a picture a release really has: an image is optional and must exist in public/", () => {
    for (const release of RELEASES) if (release.image) expect(existsSync(join(__dirname, "../../public", release.image)), `${release.version} image ${release.image}`).toBe(true);
    expect(RELEASES.filter((release) => release.image).map((release) => release.image)).not.toContain("/releases/0.29.0.jpg");
  });
  it("is newest first with unique versions", () => {
    for (let i = 1; i < RELEASES.length; i++) expect(compareVersions(RELEASES[i - 1]!.version, RELEASES[i]!.version)).toBe(1);
  });
  it("has 3 to 4 complete highlights per release", () => {
    for (const release of RELEASES) {
      for (const value of [release.version, release.date, release.title, release.summary]) expect(value.trim()).not.toBe("");
      expect(release.highlights.length).toBeGreaterThanOrEqual(3);
      expect(release.highlights.length).toBeLessThanOrEqual(4);
      for (const item of release.highlights) for (const value of [item.icon, item.title, item.text]) expect(value.trim()).not.toBe("");
    }
  });
});

describe("seen and dismiss logic", () => {
  it("compares dotted versions numerically", () => {
    expect(compareVersions("0.29.0", "0.28.11")).toBe(1);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });
  it("shows the card until the latest version is seen", () => {
    expect(showWhatsNewCard("0.29.0", "")).toBe(true);
    expect(showWhatsNewCard("0.29.0", "0.28.11")).toBe(true);
    expect(showWhatsNewCard("0.29.0", "0.29.0")).toBe(false);
    expect(showWhatsNewCard("0.29.0", "0.30.0")).toBe(false);
  });
  it("auto-opens once per version and never over the setup card", () => {
    const base = { latest: "0.29.0", seen: "0.28.11", autoOpened: "0.28.11", setupCardVisible: false };
    expect(shouldAutoOpenWhatsNew(base)).toBe(true);
    expect(shouldAutoOpenWhatsNew({ ...base, setupCardVisible: true })).toBe(false);
    expect(shouldAutoOpenWhatsNew({ ...base, autoOpened: "0.29.0" })).toBe(false);
    expect(shouldAutoOpenWhatsNew({ ...base, seen: "0.29.0" })).toBe(false);
  });
  it("falls back to the newest release for an unknown version", () => {
    expect(releaseIndex("9.9.9")).toBe(0);
    expect(releaseIndex(RELEASES[1]!.version)).toBe(1);
  });
});
