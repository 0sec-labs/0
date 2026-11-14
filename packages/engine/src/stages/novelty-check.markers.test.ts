import { describe, expect, it } from "vitest";
import { OWN_FROM_MARKERS, ownFromMarkers } from "./novelty-check.js";

describe("own From markers", () => {
  it("defaults to only the org-neutral project domain", () => {
    expect([...OWN_FROM_MARKERS]).toEqual(["0.ai"]);
    expect(ownFromMarkers({})).toEqual(["0.ai"]);
  });
  it("extends the default from ZERO_OWN_FROM_MARKERS, trimming and de-duplicating", () => {
    expect(ownFromMarkers({ ZERO_OWN_FROM_MARKERS: " alice@ , bob@example.org,,0.ai " })).toEqual(["0.ai", "alice@", "bob@example.org"]);
  });
  it("ignores a blank value", () => {
    expect(ownFromMarkers({ ZERO_OWN_FROM_MARKERS: "  " })).toEqual(["0.ai"]);
  });
});
