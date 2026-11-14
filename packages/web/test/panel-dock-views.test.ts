import { describe, expect, it } from "vitest";
import { RIGHT_GROUP_RATIO, closeViewPanel, focusViewPanel, listViewPanels, normalizePersistedViews, openViewPanel, restoreViewPanels, snapshotViewPanels, toggleViewPanels, viewIdOfPanel, viewPanelId, type DockAddPanelOptions, type DockApiLike, type DockPanelLike } from "../src/console/panel/dock-views";

function fakeDock(width = 1000) {
  const sizes: Record<string, number | undefined> = {};
  const calls: DockAddPanelOptions[] = [];
  const panels: DockPanelLike[] = [];
  let active: DockPanelLike | undefined;
  let groupCount = 0;
  const groups = new Map<string, DockPanelLike["group"]>();
  const makeGroup = () => { const id = `g${++groupCount}`; const group = { id, api: { setSize: (size: { width?: number }) => { sizes[id] = size.width; } } }; groups.set(id, group); return group; };
  const api: DockApiLike = {
    width,
    panels,
    get activePanel() { return active; },
    getPanel: id => panels.find(panel => panel.id === id),
    addPanel(options) {
      calls.push(options);
      const position = options.position;
      const group = position.referenceGroup ? groups.get(position.referenceGroup)! : position.direction === "within" ? panels.find(p => p.id === position.referencePanel)!.group : makeGroup();
      const panel: DockPanelLike = { id: options.id, group, api: { setActive: () => { active = panel; }, close: () => { panels.splice(panels.indexOf(panel), 1); if (active === panel) active = undefined; } } };
      panels.push(panel);
      if (!options.inactive) active = panel;
      return panel;
    },
  };
  const chat = api.addPanel({ id: "chat", title: "Chat", component: "slot", tabComponent: "tab", renderer: "always", params: {} as never, minimumWidth: 240, position: { direction: "right" } });
  calls.length = 0;
  void chat;
  return { api, calls, sizes, panels };
}

describe("openViewPanel", () => {
  it("creates the right group at the 62/38 ratio on first open", () => {
    const { api, calls, sizes } = fakeDock(1000);
    const panel = openViewPanel(api, "overview");
    expect(calls[0]).toMatchObject({ id: "view:overview", title: "Overview", component: "panel-view", params: { viewId: "overview" }, renderer: "onlyWhenVisible", position: { referencePanel: "chat", direction: "right" } });
    expect(sizes[panel.group.id]).toBe(Math.round(1000 * RIGHT_GROUP_RATIO));
  });
  it("reuses the group for later views and focuses existing ones without duplicating", () => {
    const { api, calls, panels } = fakeDock();
    const first = openViewPanel(api, "overview");
    const second = openViewPanel(api, "findings");
    expect(calls[1]!.position).toEqual({ referenceGroup: first.group.id, direction: "within" });
    expect(second.group).toBe(first.group);
    expect(openViewPanel(api, "overview")).toBe(first);
    expect(api.activePanel).toBe(first);
    expect(panels.filter(panel => panel.id.startsWith("view:"))).toHaveLength(2);
  });
  it("uses entity titles and keeps focus when activate is false", () => {
    const { api } = fakeDock();
    openViewPanel(api, "overview");
    const agent = openViewPanel(api, "agent:w1", { title: "Agent: Agent 1", activate: false });
    expect(api.activePanel).not.toBe(agent);
    expect(api.activePanel?.id).toBe("view:overview");
  });
  it("stacks under the anchor in compact mode without resizing", () => {
    const { api, calls, sizes } = fakeDock();
    openViewPanel(api, "findings", { compact: true });
    expect(calls[0]!.position).toEqual({ referencePanel: "chat", direction: "within" });
    expect(Object.keys(sizes)).toHaveLength(0);
  });
});

describe("focus, close, toggle, persistence", () => {
  it("focuses and closes views; overview cannot close", () => {
    const { api } = fakeDock();
    openViewPanel(api, "overview");
    openViewPanel(api, "findings");
    expect(focusViewPanel(api, "overview")).toBe(true);
    expect(focusViewPanel(api, "fixes")).toBe(false);
    expect(closeViewPanel(api, "overview")).toBe(false);
    expect(closeViewPanel(api, "findings")).toBe(true);
    expect(listViewPanels(api).map(panel => panel.id)).toEqual(["view:overview"]);
  });
  it("snapshots and restores views, dropping unknown entities", () => {
    const { api } = fakeDock();
    openViewPanel(api, "overview");
    openViewPanel(api, "evidence");
    expect(snapshotViewPanels(api)).toEqual({ views: ["overview", "evidence"], active: "evidence" });
    const other = fakeDock();
    restoreViewPanels(other.api, { views: ["overview", "agent:gone", "agent:w1", "findings"], active: "findings" }, { titles: { "agent:w1": "Agent: A" }, dropUnknownEntities: true });
    expect(snapshotViewPanels(other.api)).toEqual({ views: ["overview", "agent:w1", "findings"], active: "findings" });
  });
  it("toggles the panel closed, then reopens saved views", () => {
    const { api } = fakeDock();
    openViewPanel(api, "overview");
    openViewPanel(api, "browser");
    const saved = snapshotViewPanels(api);
    expect(toggleViewPanels(api, saved)).toBe(false);
    expect(listViewPanels(api)).toHaveLength(0);
    expect(toggleViewPanels(api, saved)).toBe(true);
    expect(snapshotViewPanels(api).views).toEqual(["overview", "browser"]);
    expect(toggleViewPanels(api)).toBe(false);
    expect(toggleViewPanels(api)).toBe(true);
    expect(snapshotViewPanels(api).views).toEqual(["overview"]);
  });
  it("normalizes untrusted saved state", () => {
    expect(normalizePersistedViews(null)).toEqual({ views: [] });
    expect(normalizePersistedViews({ views: ["findings", "findings", "bogus", 4, "agent:w1"], active: "agent:w1" })).toEqual({ views: ["findings", "agent:w1"], active: "agent:w1" });
    expect(normalizePersistedViews({ views: ["findings"], active: "scope" })).toEqual({ views: ["findings"], active: undefined });
  });
  it("maps panel ids back to views", () => {
    expect(viewIdOfPanel(viewPanelId("fixes"))).toBe("fixes");
    expect(viewIdOfPanel("chat")).toBeUndefined();
    expect(viewIdOfPanel("view:bogus")).toBeUndefined();
  });
});
