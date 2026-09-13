import { describe, expect, it } from "vitest";

import { suggestCompletion } from "./composer-suggest.js";

describe("suggestCompletion", () => {
  it("returns the suffix when a history entry has the input as a prefix", () => {
    expect(suggestCompletion("depl", ["deploy the frontend"])).toBe("oy the frontend");
  });

  it("returns null when nothing matches", () => {
    expect(suggestCompletion("xyz", ["deploy", "restart"])).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(suggestCompletion("", ["deploy", "restart"])).toBeNull();
  });

  it("returns null when the input equals a full history entry (nothing to add)", () => {
    expect(suggestCompletion("deploy", ["deploy"])).toBeNull();
  });

  it("prefers the most recent match when several entries share the prefix", () => {
    // oldest-first; the newest matching entry wins.
    const history = ["deploy the api", "deploy the worker", "restart"];
    expect(suggestCompletion("deploy the ", history)).toBe("worker");
  });

  it("returns null when the only candidate is shorter than the input", () => {
    expect(suggestCompletion("deployment", ["deploy"])).toBeNull();
  });

  it("is a case-sensitive prefix match", () => {
    expect(suggestCompletion("Dep", ["deploy"])).toBeNull();
    expect(suggestCompletion("dep", ["deploy"])).toBe("loy");
  });

  it("matches the whole line, not per word", () => {
    // "run tests" is not a prefix of "make run tests", so no suggestion.
    expect(suggestCompletion("run tests", ["make run tests"])).toBeNull();
  });

  it("skips an equal entry but still suggests a longer one behind it", () => {
    // newest is an exact match (adds nothing); the older entry extends it.
    const history = ["deploy now", "deploy"];
    expect(suggestCompletion("deploy", history)).toBe(" now");
  });

  it("returns null for empty history", () => {
    expect(suggestCompletion("deploy", [])).toBeNull();
  });
});
