import { describe, expect, it } from "vitest";

import { buildMarketItems, type MarketRegistryView } from "./market-layout.js";

/** A representative registry: two plugins, plus noise to be dropped. */
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
    // Noise: theme and config artifacts and a malformed entry — all must be dropped.
    { kind: "theme", id: "acme.midnight", version: "1.0.0", manifest: { theme: { label: "Midnight" } } },
    { kind: "config", id: "acme.config", version: "1.0.0", manifest: { name: "cfg" } },
    { kind: "plugin", id: "", version: "1.0.0" },
  ],
} as MarketRegistryView;

const ITEMS = buildMarketItems(REGISTRY);

describe("buildMarketItems", () => {
  it("normalises plugins from entries", () => {
    expect(ITEMS.map((item) => `${item.kind}:${item.id}`).sort()).toEqual([
      "plugin:acme.scanner",
      "plugin:beta.reporter",
    ]);
  });

  it("drops theme and config artifacts, unknown kinds and malformed rows", () => {
    expect(ITEMS.some((item) => item.id === "acme.config")).toBe(false);
    expect(ITEMS.some((item) => item.id === "")).toBe(false);
  });

  it("carries a plugin's capabilities", () => {
    const plugin = ITEMS.find((item) => item.id === "acme.scanner");
    expect(plugin?.capabilities).toEqual(["network", "filesystem-read"]);
    expect(ITEMS.some((item) => item.id === "acme.midnight")).toBe(false);
  });

  it("derives a one-line description for a plugin", () => {
    const plugin = ITEMS.find((item) => item.id === "acme.scanner");
    expect(plugin?.description).toBe("2 tools: scan, probe");
  });

  it("maps the signature state to verified/unverified", () => {
    expect(ITEMS.find((item) => item.id === "beta.reporter")?.signature).toBe("verified");
    expect(ITEMS.find((item) => item.id === "acme.scanner")?.signature).toBe("unverified");
  });

  it("returns nothing for an absent or malformed registry", () => {
    expect(buildMarketItems(undefined)).toEqual([]);
    expect(buildMarketItems({})).toEqual([]);
    expect(buildMarketItems({ entries: [] })).toEqual([]);
  });
});
