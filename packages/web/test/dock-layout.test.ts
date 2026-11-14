import { expect, test } from "vitest";
import { restoreDockLayout } from "../src/console/dock-layout.js";
const layout = () => ({ grid: { width: 1200, height: 800, orientation: "HORIZONTAL", root: { type: "branch", data: [
  { type: "leaf", size: 800, data: { id: "left", views: ["chat", "chat:old"], activeView: "chat:old" } },
  { type: "leaf", size: 400, data: { id: "right", views: ["agents", "view:overview", "view:browser", "chat:deleted"], activeView: "view:browser" } },
] } }, panels: Object.fromEntries(["chat", "chat:old", "agents", "view:overview", "view:browser", "chat:deleted"].map(id => [id, { id, contentComponent: "slot", title: id }])), activeGroup: "right" });
test("preserves chat geometry while remapping chats and leaving view panels to per-chat persistence", () => {
  const original = layout(); const restored = restoreDockLayout(original, ["new"], { old: "new", deleted: null })!;
  expect(restored.activeGroup).toBeUndefined(); expect(restored.grid.width).toBe(1200);
  const groups = restored.grid.root.data as any[];
  expect(groups.map(group => group.size)).toEqual([800]);
  expect(groups[0].data).toMatchObject({ views: ["chat", "chat:new"], activeView: "chat:new" });
  expect(restored.panels.agents).toBeUndefined(); expect(restored.panels["view:overview"]).toBeUndefined(); expect(restored.panels["view:browser"]).toBeUndefined();
  expect(restored.panels["chat:new"].id).toBe("chat:new"); expect(restored.panels["chat:old"]).toBeUndefined();
  expect(original.panels["chat:old"]).toBeDefined();
});
test("drops missing chat-only groups without retaining orphan panel definitions", () => {
  const value = layout(); value.grid.root.data.push({ type: "leaf", size: 200, data: { id: "gone", views: ["chat:missing"], activeView: "chat:missing" } });
  value.panels["chat:missing"] = { id: "chat:missing", contentComponent: "slot", title: "Missing" };
  const result = restoreDockLayout(value, [])!;
  expect((result.grid.root.data as any[])).toHaveLength(1); expect(result.panels["chat:missing"]).toBeUndefined();
});
test("invalid persisted data falls back instead of opening arbitrary components", () => {
  expect(restoreDockLayout(null, [])).toBeUndefined(); expect(restoreDockLayout({ panels: {} }, [])).toBeUndefined();
  const value = layout(); value.panels.chat.contentComponent = "untrusted";
  expect(restoreDockLayout(value, [])?.panels.chat.contentComponent).toBe("slot");
});

import { dockChatsBeforeSessions, dockChatsForRender } from "../src/console/dock-layout.js";
test("mounts persisted tabs before the sessions list: valid, deduplicated, never the primary chat", () => {
  const chats = dockChatsBeforeSessions([
    { id: "a", title: "A\nline", savedId: "sa" }, { id: "a", title: "dup" }, { id: "primary", title: "P" },
    { id: "b", title: "B", backendId: "remote" }, { id: "bad id", title: "x" }, null, { id: 3 },
  ], { primary: { backendId: "local", id: "primary" }, defaultBackendId: "local" });
  expect(chats).toEqual([{ id: "a", backendId: "local", title: "A line", savedId: "sa" }, { id: "b", backendId: "remote", title: "B" }]);
  expect(dockChatsBeforeSessions("nope", { defaultBackendId: "local" })).toEqual([]);
});
test("renders the persisted roster until sessions load, then the reconciled one", () => {
  expect(dockChatsForRender({ sessionsLoaded: false, reconciled: [], persisted: ["p"] })).toEqual(["p"]);
  expect(dockChatsForRender({ sessionsLoaded: true, reconciled: [], persisted: ["p"] })).toEqual([]);
});
