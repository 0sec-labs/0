import { describe, expect, it } from "vitest";

import {
  KEYBINDINGS,
  KEYBINDING_CATEGORIES,
  REBINDABLE_IDS,
  assessChordAssignment,
  chordFromKey,
  detectConflicts,
  effectiveChords,
  formatChord,
  isAssignableChord,
  isRebindableId,
  keybindingsByCategory,
  matchesBinding,
  parseChord,
  reservedChords,
  sanitizeKeybindingOverrides,
  type Keybinding,
  type KeybindingCategory,
} from "./keybindings.js";

describe("KEYBINDINGS registry", () => {
  it("is non-empty", () => {
    expect(KEYBINDINGS.length).toBeGreaterThan(0);
  });

  it("gives every binding a unique id", () => {
    const ids = KEYBINDINGS.map((binding) => binding.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("fills every string field with non-empty, trimmed text", () => {
    // Only the STRING fields are checked here; `defaultChords` (array) and
    // `rebindable` (boolean) get their own assertions below.
    for (const binding of KEYBINDINGS) {
      for (const field of ["id", "keys", "description", "category", "handler"] as const) {
        const value = binding[field];
        expect(typeof value, `${binding.id}.${field}`).toBe("string");
        expect(value.length, `${binding.id}.${field}`).toBeGreaterThan(0);
        expect(value, `${binding.id}.${field}`).toBe(value.trim());
      }
    }
  });

  it("gives every binding a boolean rebindable flag and at least one parseable default chord", () => {
    for (const binding of KEYBINDINGS) {
      expect(typeof binding.rebindable, `${binding.id}.rebindable`).toBe("boolean");
      expect(binding.defaultChords.length, `${binding.id}.defaultChords`).toBeGreaterThan(0);
      for (const chord of binding.defaultChords) {
        const parsed = parseChord(chord);
        expect(parsed, `${binding.id} chord ${chord}`).not.toBeNull();
        // Canonical: the stored chord must be its own round-trip.
        expect(formatChord(parsed!), `${binding.id} chord ${chord}`).toBe(chord);
      }
    }
  });

  it("gives every rebindable binding at least one assignable default chord", () => {
    // The override always REPLACES with a single assignable chord (enforced by
    // isAssignableChord in the resolver), but a rebindable default may itself
    // be multi-chord (nav.palette Ctrl+P/Ctrl+K, nav.scroll-up PageUp/Ctrl+Up).
    // Every rebindable must expose at least one assignable anchor.
    for (const binding of KEYBINDINGS) {
      if (!binding.rebindable) continue;
      expect(binding.defaultChords.length, binding.id).toBeGreaterThan(0);
      const anyAssignable = binding.defaultChords.some((chord) => isAssignableChord(parseChord(chord)));
      expect(anyAssignable, binding.id).toBe(true);
    }
  });

  it("gives every single-action rebindable binding exactly one default chord", () => {
    const singleChord = [
      "view.left-sidebar",
      "view.right-sidebar",
      "view.transcript-detail",
      "composer.edit-queued",
      "overlay.review-toggle",
      "nav.jump-agents",
      "nav.open-comms",
    ];
    const byId = new Map(KEYBINDINGS.map((binding) => [binding.id, binding]));
    for (const id of singleChord) {
      const binding = byId.get(id);
      expect(binding, id).toBeDefined();
      expect(binding!.rebindable, id).toBe(true);
      expect(binding!.defaultChords.length, id).toBe(1);
      expect(isAssignableChord(parseChord(binding!.defaultChords[0]!)), id).toBe(true);
    }
  });

  it("marks the rethought rebindable set editable and everything else locked", () => {
    expect([...REBINDABLE_IDS].sort()).toEqual(
      [
        "composer.edit-queued",
        "nav.jump-agents",
        "nav.open-comms",
        "nav.palette",
        "nav.scroll-down",
        "nav.scroll-up",
        "overlay.review-toggle",
        "view.left-sidebar",
        "view.right-sidebar",
        "view.transcript-detail",
      ].sort(),
    );
    expect(isRebindableId("view.left-sidebar")).toBe(true);
    expect(isRebindableId("nav.palette")).toBe(true);
    expect(isRebindableId("session.quit")).toBe(false);
    // The protected drift is registered but never rebindable.
    expect(isRebindableId("composer.accept-suggestion")).toBe(false);
    expect(isRebindableId("overlay.review-top")).toBe(false);
    expect(isRebindableId("overlay.review-bottom")).toBe(false);
  });

  it("carries a lockReason on every protected binding and none on rebindable ones", () => {
    for (const binding of KEYBINDINGS) {
      if (binding.rebindable) {
        expect(binding.lockReason, binding.id).toBeUndefined();
      } else {
        expect(typeof binding.lockReason, binding.id).toBe("string");
        expect((binding.lockReason ?? "").length, binding.id).toBeGreaterThan(0);
      }
    }
    // The tokens are drawn from the small documented vocabulary.
    const reasons = new Set(
      KEYBINDINGS.filter((b) => !b.rebindable).map((b) => b.lockReason),
    );
    for (const reason of reasons) {
      expect(["text entry", "modal", "quit", "mode-cycle"]).toContain(reason);
    }
  });

  it("registers the drift ids that chat-screen already implements", () => {
    const byId = new Map(KEYBINDINGS.map((binding) => [binding.id, binding]));
    const drift: Record<string, string> = {
      "overlay.review-toggle": "Ctrl+O",
      "overlay.review-top": "Ctrl+Home",
      "overlay.review-bottom": "Ctrl+End",
      "composer.accept-suggestion": "Right",
      "nav.jump-agents": "Ctrl+G",
      "nav.open-comms": "Ctrl+T",
    };
    for (const [id, keys] of Object.entries(drift)) {
      expect(byId.get(id)?.keys, id).toBe(keys);
    }
  });

  it("only uses known categories", () => {
    for (const binding of KEYBINDINGS) {
      expect(KEYBINDING_CATEGORIES).toContain(binding.category);
    }
  });


  it("documents the load-bearing chords the operator relies on", () => {
    // A regression guard: these are the shortcuts the task called out by name.
    // If a rename or refactor drops one from the registry, this fails loudly.
    const byId = new Map(KEYBINDINGS.map((binding) => [binding.id, binding]));
    const expected: Record<string, { keys: string; category: KeybindingCategory }> = {
      "view.left-sidebar": { keys: "Ctrl+B", category: "View" },
      "view.right-sidebar": { keys: "Ctrl+L", category: "View" },
      "view.transcript-detail": { keys: "Ctrl+R", category: "View" },
      "autonomy.cycle-mode": { keys: "Shift+Tab", category: "Autonomy" },
      "nav.palette": { keys: "Ctrl+P / Ctrl+K", category: "Navigation" },
      "session.quit": { keys: "Ctrl+C", category: "Session" },
      "composer.send": { keys: "Enter", category: "Composer" },
      "composer.edit-queued": { keys: "Ctrl+Y", category: "Composer" },
      "composer.newline": { keys: "Shift+Enter", category: "Composer" },
      "nav.escape": { keys: "Esc", category: "Navigation" },
      "nav.scroll-up": { keys: "PageUp / Ctrl+Up", category: "Navigation" },
      "nav.scroll-down": { keys: "PageDown / Ctrl+Down", category: "Navigation" },
    };
    for (const [id, spec] of Object.entries(expected)) {
      const binding = byId.get(id);
      expect(binding, id).toBeDefined();
      expect(binding?.keys, id).toBe(spec.keys);
      expect(binding?.category, id).toBe(spec.category);
    }
  });
});

describe("keybindingsByCategory", () => {
  it("groups every binding under its category", () => {
    const grouped = keybindingsByCategory();
    const flattened = [...grouped.values()].flat();
    expect(flattened.length).toBe(KEYBINDINGS.length);
    for (const [category, bindings] of grouped) {
      for (const binding of bindings) {
        expect(binding.category).toBe(category);
      }
    }
  });

  it("preserves the canonical category order", () => {
    const grouped = keybindingsByCategory();
    const seen = [...grouped.keys()];
    const expectedOrder = KEYBINDING_CATEGORIES.filter((category) =>
      KEYBINDINGS.some((binding) => binding.category === category),
    );
    expect(seen).toEqual(expectedOrder);
  });

  it("preserves each binding's order within its category", () => {
    const grouped = keybindingsByCategory();
    for (const [category, bindings] of grouped) {
      const fromRegistry = KEYBINDINGS.filter((binding) => binding.category === category);
      expect(bindings.map((b) => b.id)).toEqual(fromRegistry.map((b) => b.id));
    }
  });

  it("only emits categories that have bindings", () => {
    const grouped = keybindingsByCategory();
    for (const bindings of grouped.values()) {
      expect(bindings.length).toBeGreaterThan(0);
    }
  });

  it("surfaces a binding with an unknown category rather than dropping it", () => {
    const rogue: Keybinding = {
      id: "rogue.binding",
      keys: "Ctrl+Z",
      description: "A binding with a category outside the known set.",
      category: "Nonsense" as KeybindingCategory,
      handler: "test-only",
      defaultChords: ["ctrl+z"],
      rebindable: false,
    };
    const grouped = keybindingsByCategory([...KEYBINDINGS, rogue]);
    const flattened = [...grouped.values()].flat();
    expect(flattened.map((b) => b.id)).toContain("rogue.binding");
    // It lands after every known-category binding.
    expect(flattened[flattened.length - 1]?.id).toBe("rogue.binding");
  });

  it("returns an empty map for an empty registry", () => {
    expect(keybindingsByCategory([]).size).toBe(0);
  });
});

describe("chord model", () => {
  it("parses and formats a canonical round-trip", () => {
    for (const chord of ["ctrl+b", "shift+return", "ctrl+up", "pageup", "option+backspace", "escape"]) {
      const parsed = parseChord(chord);
      expect(parsed, chord).not.toBeNull();
      expect(formatChord(parsed!)).toBe(chord);
    }
  });

  it("tolerates case, aliases and whitespace", () => {
    expect(formatChord(parseChord("Ctrl+B")!)).toBe("ctrl+b");
    expect(formatChord(parseChord("  CONTROL + b ")!)).toBe("ctrl+b");
    expect(formatChord(parseChord("Alt+Backspace")!)).toBe("option+backspace");
    expect(formatChord(parseChord("Cmd+K")!)).toBe("meta+k");
    expect(formatChord(parseChord("Esc")!)).toBe("escape");
    expect(formatChord(parseChord("Enter")!)).toBe("return");
  });

  it("orders modifiers canonically regardless of input order", () => {
    expect(formatChord(parseChord("shift+ctrl+b")!)).toBe("ctrl+shift+b");
    expect(formatChord(parseChord("option+meta+ctrl+x")!)).toBe("ctrl+meta+option+x");
  });

  it("returns null for unparseable input", () => {
    for (const bad of ["", "   ", "+", "ctrl+", "a+b", 42, null, undefined, {}]) {
      expect(parseChord(bad as unknown), String(bad)).toBeNull();
    }
  });

  it("builds a chord from a live keypress", () => {
    expect(formatChord(chordFromKey({ name: "b", ctrl: true })!)).toBe("ctrl+b");
    expect(formatChord(chordFromKey({ name: "PageUp" })!)).toBe("pageup");
    expect(chordFromKey({})).toBeNull();
    expect(chordFromKey({ ctrl: true })).toBeNull();
  });

  it("treats only modifier-carrying chords as assignable", () => {
    expect(isAssignableChord(parseChord("ctrl+b"))).toBe(true);
    expect(isAssignableChord(parseChord("option+j"))).toBe(true);
    // Plain and shift-only chords would steal typing.
    expect(isAssignableChord(parseChord("b"))).toBe(false);
    expect(isAssignableChord(parseChord("shift+b"))).toBe(false);
    expect(isAssignableChord(null)).toBe(false);
  });
});

describe("matchesBinding resolver", () => {
  it("matches a rebindable binding on its default chord with no override", () => {
    expect(matchesBinding({ name: "b", ctrl: true }, "view.left-sidebar")).toBe(true);
    expect(matchesBinding({ name: "b", ctrl: true }, "view.left-sidebar", {})).toBe(true);
    expect(matchesBinding({ name: "x", ctrl: true }, "view.left-sidebar")).toBe(false);
  });

  it("matches the override instead of the default when one is set", () => {
    const overrides = { "view.left-sidebar": "ctrl+j" };
    expect(matchesBinding({ name: "j", ctrl: true }, "view.left-sidebar", overrides)).toBe(true);
    // The old default no longer matches.
    expect(matchesBinding({ name: "b", ctrl: true }, "view.left-sidebar", overrides)).toBe(false);
  });

  it("ignores an override on a non-rebindable id", () => {
    // session.quit is protected; an override must not move it.
    expect(matchesBinding({ name: "c", ctrl: true }, "session.quit", { "session.quit": "ctrl+j" })).toBe(true);
    expect(matchesBinding({ name: "j", ctrl: true }, "session.quit", { "session.quit": "ctrl+j" })).toBe(false);
  });

  it("matches any of a multi-chord default", () => {
    expect(matchesBinding({ name: "pageup" }, "nav.scroll-up")).toBe(true);
    expect(matchesBinding({ name: "up", ctrl: true }, "nav.scroll-up")).toBe(true);
  });

  it("resolves an override for each newly rebindable id", () => {
    for (const [id, defaultKey, overrideName] of [
      ["composer.edit-queued", { name: "y", ctrl: true }, "j"],
      ["nav.palette", { name: "p", ctrl: true }, "j"],
      ["nav.scroll-up", { name: "pageup" }, "j"],
      ["nav.scroll-down", { name: "pagedown" }, "j"],
      ["overlay.review-toggle", { name: "o", ctrl: true }, "j"],
      ["nav.jump-agents", { name: "g", ctrl: true }, "j"],
      ["nav.open-comms", { name: "t", ctrl: true }, "j"],
    ] as const) {
      // The default fires with no override.
      expect(matchesBinding(defaultKey, id), `${id} default`).toBe(true);
      // An override redirects the id and abandons the default.
      const overrides = { [id]: `ctrl+${overrideName}` };
      expect(matchesBinding({ name: overrideName, ctrl: true }, id, overrides), `${id} override`).toBe(true);
      expect(matchesBinding(defaultKey, id, overrides), `${id} old default`).toBe(false);
    }
  });

  it("returns false for an unknown id or nameless key", () => {
    expect(matchesBinding({ name: "b", ctrl: true }, "nope.nope")).toBe(false);
    expect(matchesBinding({ ctrl: true }, "view.left-sidebar")).toBe(false);
  });
});

describe("reserved chords + conflict detection", () => {
  it("reserves every protected chord and no rebindable one", () => {
    const reserved = reservedChords();
    expect(reserved.has("ctrl+c")).toBe(true);
    expect(reserved.has("escape")).toBe(true);
    expect(reserved.has("shift+tab")).toBe(true);
    expect(reserved.has("return")).toBe(true);
    // The rebindable defaults are NOT reserved.
    expect(reserved.has("ctrl+b")).toBe(false);
    expect(reserved.has("ctrl+r")).toBe(false);
  });

  it("finds no conflict in the default registry", () => {
    expect(detectConflicts(KEYBINDINGS, {})).toEqual([]);
  });

  it("is deterministic across the larger rebindable set", () => {
    // Every rebindable default (single- and multi-chord) is distinct and none is
    // reserved, so repeated calls agree and the empty-override result is stable.
    const a = detectConflicts(KEYBINDINGS, {});
    const b = detectConflicts(KEYBINDINGS, {});
    expect(a).toEqual(b);
    expect(a).toEqual([]);
    // A rebind that lands on a multi-chord binding's SECOND default chord is
    // still detected (nav.scroll-up owns both pageup and ctrl+up).
    const conflicts = detectConflicts(KEYBINDINGS, { "nav.palette": "ctrl+up" });
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.chord).toBe("ctrl+up");
    expect(conflicts[0]!.ids.sort()).toEqual(["nav.palette", "nav.scroll-up"].sort());
  });

  it("flags two rebindable actions on one chord", () => {
    const conflicts = detectConflicts(KEYBINDINGS, {
      "view.left-sidebar": "ctrl+j",
      "view.right-sidebar": "ctrl+j",
    });
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.chord).toBe("ctrl+j");
    expect(conflicts[0]!.ids.sort()).toEqual(["view.left-sidebar", "view.right-sidebar"]);
  });

  it("flags a rebindable chord landing on a reserved chord", () => {
    const conflicts = detectConflicts(KEYBINDINGS, { "view.left-sidebar": "ctrl+c" });
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.ids).toContain("session.quit");
  });

  it("resolves effective chords with and without an override", () => {
    const binding = KEYBINDINGS.find((b) => b.id === "view.left-sidebar")!;
    expect(effectiveChords(binding, {})).toEqual(["ctrl+b"]);
    expect(effectiveChords(binding, { "view.left-sidebar": "ctrl+j" })).toEqual(["ctrl+j"]);
    // A protected multi-chord binding keeps all its defaults.
    const scroll = KEYBINDINGS.find((b) => b.id === "nav.scroll-up")!;
    expect(effectiveChords(scroll, {})).toEqual(["pageup", "ctrl+up"]);
  });
});

describe("assessChordAssignment", () => {
  it("accepts a free, assignable chord", () => {
    const result = assessChordAssignment("view.left-sidebar", { name: "j", ctrl: true }, {});
    expect(result).toEqual({ kind: "ok", chord: "ctrl+j" });
  });

  it("rejects a chord with no modifier", () => {
    const result = assessChordAssignment("view.left-sidebar", { name: "j" }, {});
    expect(result?.kind).toBe("unassignable");
  });

  it("rejects a chord already owned by another rebindable action", () => {
    const result = assessChordAssignment("view.left-sidebar", { name: "r", ctrl: true }, {});
    expect(result?.kind).toBe("conflict");
    if (result?.kind === "conflict") expect(result.conflictId).toBe("view.transcript-detail");
  });

  it("rejects a chord owned by a protected key", () => {
    const result = assessChordAssignment("view.left-sidebar", { name: "c", ctrl: true }, {});
    expect(result?.kind).toBe("conflict");
    if (result?.kind === "conflict") expect(result.conflictId).toBe("session.quit");
  });

  it("returns null for a non-rebindable id", () => {
    expect(assessChordAssignment("session.quit", { name: "j", ctrl: true }, {})).toBeNull();
  });
});

describe("sanitizeKeybindingOverrides", () => {
  it("returns an empty map for a non-object", () => {
    for (const bad of [null, undefined, 42, "x", []]) {
      expect(sanitizeKeybindingOverrides(bad)).toEqual({});
    }
  });

  it("keeps a valid override in canonical form", () => {
    expect(sanitizeKeybindingOverrides({ "view.left-sidebar": "Ctrl+J" })).toEqual({
      "view.left-sidebar": "ctrl+j",
    });
  });

  it("drops unknown ids", () => {
    expect(sanitizeKeybindingOverrides({ "nope.nope": "ctrl+j", "session.quit": "ctrl+j" })).toEqual({});
  });

  it("drops overrides on protected ids, including the registered drift", () => {
    expect(
      sanitizeKeybindingOverrides({
        "composer.accept-suggestion": "ctrl+j", // protected drift (Right)
        "overlay.review-top": "ctrl+j", // protected (Ctrl+Home)
        "overlay.review-bottom": "ctrl+j", // protected (Ctrl+End)
        "autonomy.cycle-mode": "ctrl+j", // protected
      }),
    ).toEqual({});
  });

  it("keeps a valid override on a newly rebindable id", () => {
    expect(sanitizeKeybindingOverrides({ "nav.palette": "Ctrl+J" })).toEqual({ "nav.palette": "ctrl+j" });
    expect(sanitizeKeybindingOverrides({ "overlay.review-toggle": "Alt+O" })).toEqual({
      "overlay.review-toggle": "option+o",
    });
  });

  it("drops unparseable, unassignable and reserved chords", () => {
    expect(
      sanitizeKeybindingOverrides({
        "view.left-sidebar": "not a chord",
        "view.right-sidebar": "j", // no modifier
        "view.transcript-detail": "ctrl+c", // reserved
      }),
    ).toEqual({});
  });

  it("drops conflicting overrides, reverting them to defaults", () => {
    // Both want ctrl+j — neither is kept; each falls back to its unique default.
    const sanitized = sanitizeKeybindingOverrides({
      "view.left-sidebar": "ctrl+j",
      "view.right-sidebar": "ctrl+j",
    });
    expect(sanitized).toEqual({});
  });

  it("drops an override that collides with another binding's default", () => {
    // ctrl+r is transcript-detail's default (not overridden) — left-sidebar
    // cannot claim it.
    expect(sanitizeKeybindingOverrides({ "view.left-sidebar": "ctrl+r" })).toEqual({});
  });

  it("keeps a clean set of distinct overrides", () => {
    const sanitized = sanitizeKeybindingOverrides({
      "view.left-sidebar": "ctrl+j",
      "view.right-sidebar": "ctrl+shift+l",
    });
    expect(sanitized).toEqual({
      "view.left-sidebar": "ctrl+j",
      "view.right-sidebar": "ctrl+shift+l",
    });
    // And the result is conflict-free.
    expect(detectConflicts(KEYBINDINGS, sanitized)).toEqual([]);
  });
});
