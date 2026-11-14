import { describe, expect, it } from "vitest";
import { panelViewRegistry, panelViews, viewDefinition, viewTitle } from "../src/console/panel/registry";
import { STATIC_VIEW_IDS, agentViewId, findingViewId, panelViewEntity, panelViewKind, parsePanelViewId } from "../src/console/panel/types";
import { isEditableTarget, matchViewShortcut } from "../src/console/panel/use-view-shortcuts";
import { shortcutLabel } from "../src/console/panel/shortcut-label";

describe("panel view registry", () => {
  it("defines every static id and keeps overview permanent", () => {
    expect(panelViews.map(view => view.id)).toEqual([...STATIC_VIEW_IDS]);
    expect(panelViewRegistry.overview.closable).toBe(false);
    for (const id of STATIC_VIEW_IDS) expect(panelViewRegistry[id].title.length).toBeGreaterThan(0);
  });
  it("has unique shortcuts", () => {
    const keys = panelViews.flatMap(view => view.shortcut ? [view.shortcut.key] : []);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("b");
  });
  it("parses and classifies ids", () => {
    expect(parsePanelViewId("findings")).toBe("findings");
    expect(parsePanelViewId("agent:w1")).toBe("agent:w1");
    expect(parsePanelViewId("agent:")).toBeUndefined();
    expect(parsePanelViewId("nope")).toBeUndefined();
    expect(parsePanelViewId(3)).toBeUndefined();
    expect(panelViewKind(agentViewId("w1"))).toBe("agent");
    expect(panelViewKind(findingViewId("fp"))).toBe("finding");
    expect(panelViewEntity(agentViewId("w1"))).toBe("w1");
    expect(panelViewEntity("fixes")).toBeUndefined();
  });
  it("titles per-entity views", () => {
    expect(viewTitle("findings")).toBe("Findings");
    expect(viewTitle("agent:w1", "Agent 2")).toBe("Agent: Agent 2");
    expect(viewDefinition("agent:w1").id).toBe("agents");
  });
});

describe("view shortcuts", () => {
  const event = (key: string, init: Partial<KeyboardEvent> = {}) => ({ key, metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, ...init });
  it("matches shift+mod combos", () => {
    expect(matchViewShortcut(event("F"))).toEqual({ type: "open-view", id: "findings" });
    expect(matchViewShortcut(event("l", { metaKey: false, ctrlKey: true }))).toEqual({ type: "open-view", id: "browser" });
    expect(matchViewShortcut(event("B"))).toEqual({ type: "toggle-panel" });
  });
  it("ignores plain, unshifted and alt combos", () => {
    expect(matchViewShortcut(event("F", { shiftKey: false }))).toBeUndefined();
    expect(matchViewShortcut(event("F", { metaKey: false }))).toBeUndefined();
    expect(matchViewShortcut(event("F", { altKey: true }))).toBeUndefined();
    expect(matchViewShortcut(event("z"))).toBeUndefined();
  });
  it("detects editable targets", () => {
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", closest: () => ({}) })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", closest: () => null })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
  it("formats labels per platform", () => {
    expect(shortcutLabel({ key: "f", mod: true, shift: true }, true)).toBe("⇧⌘F");
    expect(shortcutLabel({ key: "f", mod: true, shift: true }, false)).toBe("Ctrl+Shift+F");
  });
});
