import { describe, expect, it } from "vitest";
import { panelViews } from "@/console/panel/registry";
import { SHORTCUTS, bindingBlocked, bindingKeys, findBindingCollisions, isTypingTarget, matchShortcut, shortcutAria, shortcutHint, shortcutMatchesQuery, type Shortcut } from "./shortcuts";

const ev = (key: string, extra: Record<string, unknown> = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra });
const field = { tagName: "TEXTAREA" };
const editor = { tagName: "DIV", isContentEditable: true };

describe("shortcut registry", () => {
  it("has unique ids, a handler key and at least one binding for every entry", () => {
    expect(new Set(SHORTCUTS.map(s => s.id)).size).toBe(SHORTCUTS.length);
    for (const s of SHORTCUTS) { expect(s.handler, s.id).toBeTruthy(); expect(s.bindings.length, s.id).toBeGreaterThan(0); }
  });
  it("has no two shortcuts sharing a binding in overlapping scopes", () => {
    expect(findBindingCollisions()).toEqual([]);
  });
  it("detects a collision when one is introduced", () => {
    const dup: Shortcut = { ...SHORTCUTS[0]!, id: "dup", scope: "mission" };
    expect(findBindingCollisions([...SHORTCUTS, dup]).length).toBeGreaterThan(0);
    const sameScope: Shortcut[] = [{ ...dup, id: "a" }, { ...dup, id: "b" }];
    expect(findBindingCollisions(sameScope)).toEqual([["a", "b"]]);
  });
  it("lists exactly the panel view shortcuts the panel registry handles", () => {
    const registered = SHORTCUTS.filter(s => s.id.startsWith("panel.") && s.id !== "panel.toggle").map(s => s.bindings[0]!.key).sort();
    expect(registered).toEqual(panelViews.filter(v => v.shortcut).map(v => v.shortcut!.key).sort());
  });
});

describe("matching and focus gating", () => {
  it("binds the sidebar to Cmd+B with Shift+Cmd+S as secondary, and Shift+Cmd+B stays the panel", () => {
    expect(matchShortcut(ev("b", { metaKey: true }))?.id).toBe("sidebar.toggle");
    expect(matchShortcut(ev("S", { metaKey: true, shiftKey: true }))?.id).toBe("sidebar.toggle");
    expect(matchShortcut(ev("B", { ctrlKey: true, shiftKey: true }), ["global", "mission"])?.id).toBe("panel.toggle");
    expect(matchShortcut(ev("B", { ctrlKey: true, shiftKey: true }))).toBeUndefined();
  });
  it("does not fire Cmd+B while typing but still allows Cmd+K and Shift+Cmd+S", () => {
    expect(matchShortcut({ ...ev("b", { metaKey: true }), target: field })).toBeUndefined();
    expect(matchShortcut({ ...ev("b", { metaKey: true }), target: editor })).toBeUndefined();
    expect(matchShortcut({ ...ev("k", { metaKey: true }), target: field })?.id).toBe("palette.open");
    expect(matchShortcut({ ...ev("s", { metaKey: true, shiftKey: true }), target: field })?.id).toBe("sidebar.toggle");
  });
  it("ignores plain keys while typing and matches ? with Shift", () => {
    expect(matchShortcut({ ...ev("?", { shiftKey: true }), target: field })).toBeUndefined();
    expect(matchShortcut({ ...ev("?", { shiftKey: true }), target: { tagName: "BODY" } })?.id).toBe("shortcuts.open");
    expect(matchShortcut({ ...ev("/"), target: { tagName: "DIV" } })?.id).toBe("palette.open");
    expect(matchShortcut(ev("a"))).toBeUndefined();
  });
  it("rejects Alt chords and composer rows", () => {
    expect(matchShortcut(ev("b", { metaKey: true, altKey: true }))).toBeUndefined();
    expect(matchShortcut(ev("Enter"), ["composer"])).toBeUndefined();
  });
  it("detects typing targets", () => {
    expect(isTypingTarget(field)).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", closest: () => ({}) })).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(bindingBlocked({ key: "k", mod: true }, field)).toBe(false);
  });
});

describe("labels", () => {
  it("renders platform specific keys and hints", () => {
    expect(bindingKeys({ key: "s", mod: true, shift: true }, true)).toEqual(["⇧", "⌘", "S"]);
    expect(bindingKeys({ key: "s", mod: true, shift: true }, false)).toEqual(["Shift", "Ctrl", "S"]);
    expect(shortcutHint("sidebar.toggle", true)).toBe("⌘B");
    expect(shortcutHint("sidebar.toggle", false)).toBe("Ctrl+B");
    expect(shortcutAria("sidebar.toggle")).toContain("Meta+B Control+B");
  });
  it("filters by action, keys and group", () => {
    const sidebar = SHORTCUTS.find(s => s.id === "sidebar.toggle")!;
    expect(shortcutMatchesQuery(sidebar, "sidebar")).toBe(true);
    expect(shortcutMatchesQuery(sidebar, "⇧⌘S", true)).toBe(true);
    expect(shortcutMatchesQuery(sidebar, "navigation")).toBe(true);
    expect(shortcutMatchesQuery(sidebar, "zzz")).toBe(false);
  });
});
