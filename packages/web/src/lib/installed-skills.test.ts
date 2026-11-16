import { describe, expect, it } from "vitest";
import { installedSource, installedTile, rankInstalled, type InstalledSkill } from "./installed-skills";

const make = (name: string, scope: string, extra: Partial<InstalledSkill> = {}): InstalledSkill => ({ id: name, name, description: `${name} does things.`, scope, source: "", ...extra });

describe("rankInstalled", () => {
  const skills = [make("zeta", "extension", { source: "acme-ext" }), make("beta", "builtin", { category: "Web" }), make("gamma", "workspace"), make("alpha", "builtin"), make("hidden", "builtin", { internal: true }), make("from-gh", "workspace", { origin: { repo: "o/r", sha: "abc" } })];
  it("lists yours, then built-in, then extension skills, each by name, flat", () => {
    expect(rankInstalled(skills).map(s => s.name)).toEqual(["from-gh", "gamma", "alpha", "beta", "zeta"]);
  });
  it("filters by word start across name, summary and source", () => {
    expect(rankInstalled(skills, "acme").map(s => s.name)).toEqual(["zeta"]);
    expect(rankInstalled(skills, "amma").length).toBe(0);
    expect(rankInstalled(skills, "o/r").map(s => s.name)).toEqual(["from-gh"]);
  });
});

describe("installedSource", () => {
  it("names the source", () => {
    expect(installedSource(make("a", "builtin"))).toBe("Built-in");
    expect(installedSource(make("a", "extension", { source: "acme" }))).toBe("acme");
    expect(installedSource(make("a", "workspace", { origin: { repo: "o/r", sha: "x" } }))).toBe("o/r");
    expect(installedSource(make("a", "mounted"))).toBe("Your folder");
    expect(installedSource(make("a", "personal"))).toBe("You");
    expect(installedSource(make("a", "workspace"), true)).toBe("Team");
  });
});

describe("installedTile", () => {
  it("picks the tile by origin", () => {
    expect(installedTile(make("a", "builtin", { category: "Web" }))).toEqual({ kind: "icon", icon: "web" });
    expect(installedTile(make("a", "extension"))).toEqual({ kind: "icon", icon: "extension" });
    expect(installedTile(make("a", "workspace", { origin: { repo: "Owner/r", sha: "x" } }))).toEqual({ kind: "publisher", owner: "owner", name: "Owner" });
    expect(installedTile(make("a", "personal"))).toEqual({ kind: "monogram", name: "a" });
  });
});
