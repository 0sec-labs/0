import { describe, expect, it } from "vitest";

import { buildMarketItems, type MarketRegistryView } from "./market-layout.js";

/** A representative registry: two plugins, two themes, plus noise to be dropped. */
const REGISTRY: MarketRegistryView = {
  entries: [
    {
      id: "acme.scanner",
      version: "1.2.0",
      manifest: {
        name: "Acme Scanner",
        tools: [
          { name: "scan", description: "scan a thing" },
          { name: "probe", description: "probe a thing" },
        ],
      },
      capabilities: ["network", "filesystem-read"],
      signatureState: "unverified",
    },
    {
      id: "beta.reporter",
      version: "0.3.1",
      manifest: { name: "Beta Reporter", tools: [{ name: "report", description: "write a report" }] },
      capabilities: ["findings-write"],
      signatureState: "verified",
    },
  ],
  artifacts: [
    {
      kind: "theme",
      id: "acme.midnight",
      version: "1.0.0",
      manifest: {
        name: "Acme Midnight",
        theme: { label: "Midnight", description: "A dark, low-glare palette." },
      },
      signatureState: "unverified",
    },
    {
      kind: "theme",
      id: "acme.daybreak",
      version: "2.0.0",
      manifest: { name: "Acme Daybreak", theme: { label: "Daybreak", description: "A light palette." } },
      signatureState: "verified",
    },
    // Noise: a config artifact and a malformed entry — both must be dropped.
    { kind: "config", id: "acme.config", version: "1.0.0", manifest: { name: "cfg" } },
    { kind: "theme", id: "", version: "1.0.0", manifest: { theme: { label: "nameless" } } },
  ],
};

const ITEMS = buildMarketItems(REGISTRY);

describe("buildMarketItems", () => {
  it("normalises plugins from entries and themes from theme artifacts", () => {
    expect(ITEMS.map((item) => `${item.kind}:${item.id}`).sort()).toEqual([
      "plugin:acme.scanner",
      "plugin:beta.reporter",
      "theme:acme.daybreak",
      "theme:acme.midnight",
    ]);
  });

  it("drops config artifacts, unknown kinds and malformed rows", () => {
    expect(ITEMS.some((item) => item.id === "acme.config")).toBe(false);
    expect(ITEMS.some((item) => item.id === "")).toBe(false);
  });

  it("carries a plugin's capabilities and a theme's empty capability set", () => {
    const plugin = ITEMS.find((item) => item.id === "acme.scanner");
    expect(plugin?.capabilities).toEqual(["network", "filesystem-read"]);
    const theme = ITEMS.find((item) => item.id === "acme.midnight");
    expect(theme?.capabilities).toEqual([]);
  });

  it("derives a one-line description for a plugin and reads a theme's own", () => {
    const plugin = ITEMS.find((item) => item.id === "acme.scanner");
    expect(plugin?.description).toBe("2 tools: scan, probe");
    const theme = ITEMS.find((item) => item.id === "acme.midnight");
    expect(theme?.description).toBe("A dark, low-glare palette.");
  });

  it("maps the signature state to verified/unverified", () => {
    expect(ITEMS.find((item) => item.id === "beta.reporter")?.signature).toBe("verified");
    expect(ITEMS.find((item) => item.id === "acme.scanner")?.signature).toBe("unverified");
  });

  it("returns nothing for an absent or malformed registry", () => {
    expect(buildMarketItems(undefined)).toEqual([]);
    expect(buildMarketItems({})).toEqual([]);
    expect(buildMarketItems({ entries: [], artifacts: [] })).toEqual([]);
  });
});
