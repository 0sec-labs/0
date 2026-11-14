import { describe, expect, it } from "vitest";

import { sanitizeKeybindingOverrides } from "./keybindings.js";

describe("sanitizeKeybindingOverrides", () => {
  it("returns an empty map for a non-object", () => {
    for (const bad of [null, undefined, 42, "x", []]) {
      expect(sanitizeKeybindingOverrides(bad)).toEqual({});
    }
  });

  it("keeps a valid override in canonical form", () => {
    expect(sanitizeKeybindingOverrides({ "nav.open-comms": "Ctrl+J" })).toEqual({
      "nav.open-comms": "ctrl+j",
    });
  });

  it("drops unknown ids", () => {
    expect(sanitizeKeybindingOverrides({ "nope.nope": "ctrl+j", "session.quit": "ctrl+j" })).toEqual({});
  });

  it("drops retired transcript-review binding ids as unknown", () => {
    expect(
      sanitizeKeybindingOverrides({
        "nav.open-comms": "ctrl+j",
        "overlay.review-toggle": "ctrl+k",
        "overlay.review-top": "ctrl+l",
        "overlay.review-bottom": "ctrl+m",
      }),
    ).toEqual({ "nav.open-comms": "ctrl+j" });
  });

  it("drops overrides on protected ids, including the registered drift", () => {
    expect(
      sanitizeKeybindingOverrides({
        "composer.accept-suggestion": "ctrl+j", // protected drift (Right)
        "session.quit": "ctrl+j", // protected
        "autonomy.cycle-mode": "ctrl+j", // protected
      }),
    ).toEqual({});
  });

  it("keeps a valid override on a newly rebindable id", () => {
    expect(sanitizeKeybindingOverrides({ "nav.palette": "Ctrl+J" })).toEqual({ "nav.palette": "ctrl+j" });
    expect(sanitizeKeybindingOverrides({ "view.transcript-detail": "Alt+O" })).toEqual({
      "view.transcript-detail": "option+o",
    });
  });

  it("drops unparseable, unassignable and reserved chords", () => {
    expect(
      sanitizeKeybindingOverrides({
        "nav.open-comms": "not a chord",
        "nav.palette": "j", // no modifier
        "view.transcript-detail": "ctrl+c", // reserved
      }),
    ).toEqual({});
  });

  it("drops conflicting overrides, reverting them to defaults", () => {
    // Both want ctrl+j — neither is kept; each falls back to its unique default.
    const sanitized = sanitizeKeybindingOverrides({
      "nav.open-comms": "ctrl+j",
      "view.transcript-detail": "ctrl+j",
    });
    expect(sanitized).toEqual({});
  });

  it("drops an override that collides with another binding's default", () => {
    // The communications binding cannot claim transcript-detail's default chord.
    expect(sanitizeKeybindingOverrides({ "nav.open-comms": "ctrl+r" })).toEqual({});
  });

  it("keeps a clean set of distinct overrides", () => {
    const sanitized = sanitizeKeybindingOverrides({
      "nav.open-comms": "ctrl+j",
      "view.transcript-detail": "ctrl+shift+l",
    });
    expect(sanitized).toEqual({
      "nav.open-comms": "ctrl+j",
      "view.transcript-detail": "ctrl+shift+l",
    });
  });
});
