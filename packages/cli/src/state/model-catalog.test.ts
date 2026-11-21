import { describe, expect, it, vi } from "vitest";

import { MODEL_PRICING, modelProvider } from "@0/engine/shared";

import { buildModelCatalog, formatModelPrice } from "./model-catalog.js";

const SOME_MODEL = "gpt-5.5";

describe("formatModelPrice", () => {
  it("renders input/output dollars per million", () => {
    expect(formatModelPrice(5, 30)).toBe("$5/30 per M");
    expect(formatModelPrice(2.5, 15)).toBe("$2.5/15 per M");
    expect(formatModelPrice(0.075, 0.6)).toBe("$0.075/0.6 per M");
  });

  it("collapses a zero-rate model to 'free'", () => {
    expect(formatModelPrice(0, 0)).toBe("free");
  });

  it("only says 'free' when BOTH rates are zero", () => {
    expect(formatModelPrice(0, 15)).toBe("$0/15 per M");
    expect(formatModelPrice(3, 0)).toBe("$3/0 per M");
  });
});

describe("buildModelCatalog", () => {
  it("is non-empty and covers the pricing table", () => {
    const catalog = buildModelCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    // Every priced model except the synthetic fallback row is offered.
    expect(catalog).toHaveLength(Object.keys(MODEL_PRICING).length - 1);
    expect(catalog.some((model) => model.id === "default")).toBe(false);
  });

  it("gives every entry a real id, provider, and price", () => {
    for (const model of buildModelCatalog()) {
      expect(model.id.length).toBeGreaterThan(0);
      expect(model.provider.length).toBeGreaterThan(0);
      expect(model.provider).toBe(modelProvider(model.id));
      expect(model.price === "free" || model.price.endsWith(" per M")).toBe(true);
    }
  });

  it("puts the current model first", () => {
    const catalog = buildModelCatalog("glm-5.3");
    expect(catalog[0].id).toBe("glm-5.3");
    // ...and does not duplicate it further down the list.
    expect(catalog.filter((model) => model.id === "glm-5.3")).toHaveLength(1);
  });

  it("sorts the rest by provider then id", () => {
    const rest = buildModelCatalog(SOME_MODEL).slice(1);
    for (let i = 1; i < rest.length; i += 1) {
      const previous = rest[i - 1];
      const current = rest[i];
      const ordered =
        previous.provider < current.provider ||
        (previous.provider === current.provider && previous.id < current.id);
      expect(ordered, `${previous.provider}/${previous.id} before ${current.provider}/${current.id}`).toBe(true);
    }
  });

  it("is deterministic across calls and independent of the current model", () => {
    expect(buildModelCatalog()).toEqual(buildModelCatalog());

    const withCurrent = buildModelCatalog(SOME_MODEL);
    const plain = buildModelCatalog();
    // Removing the pinned row must leave exactly the unpinned ordering.
    expect(withCurrent.slice(1)).toEqual(plain.filter((model) => model.id !== SOME_MODEL));
  });

  it("returns a fresh array each call", () => {
    const first = buildModelCatalog();
    first.length = 0;
    expect(buildModelCatalog().length).toBeGreaterThan(0);
  });

  it("never prints while pricing the catalog", () => {
    // getRates warns on an unknown model; every catalog id comes FROM the
    // price table, so a warning here means the derivation drifted.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      buildModelCatalog(SOME_MODEL);
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
