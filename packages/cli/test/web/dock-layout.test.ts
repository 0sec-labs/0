import { expect, test } from "vitest";
import { restoreDockLayout } from "../../../dashboard/src/console/dock-layout.js";
const layout = () => ({ grid: { width: 1200, height: 800, orientation: "HORIZONTAL", root: { type: "branch", data: [
  { type: "leaf", size: 800, data: { id: "left", views: ["chat", "chat:old"], activeView: "chat:old" } },
  { type: "leaf", size: 400, data: { id: "right", views: ["agents", "details", "browser", "chat:deleted"], activeView: "browser" } },
] } }, panels: Object.fromEntries(["chat", "chat:old", "agents", "details", "browser", "chat:deleted"].map(id => [id, { id, contentComponent: "slot", title: id }])), activeGroup: "right" });
test("preserves geometry, browser preview and active group while remapping chats and retiring auxiliary panes", () => {
  const original = layout(); const restored = restoreDockLayout(original, ["new"], { old: "new", deleted: null })!;
  expect(restored.activeGroup).toBe("right"); expect(restored.grid.width).toBe(1200);
  const groups = restored.grid.root.data as any[];
  expect(groups.map(group => group.size)).toEqual([800, 400]);
  expect(groups[0].data).toMatchObject({ views: ["chat", "chat:new"], activeView: "chat:new" });
  expect(groups[1].data).toMatchObject({ views: ["browser"], activeView: "browser" });
  expect(restored.panels.agents).toBeUndefined(); expect(restored.panels.details).toBeUndefined();
  expect(restored.panels["chat:new"].id).toBe("chat:new"); expect(restored.panels["chat:old"]).toBeUndefined();
  expect(original.panels["chat:old"]).toBeDefined();
});
test("drops missing chat-only groups without retaining orphan panel definitions", () => {
  const value = layout(); value.grid.root.data.push({ type: "leaf", size: 200, data: { id: "gone", views: ["chat:missing"], activeView: "chat:missing" } });
  value.panels["chat:missing"] = { id: "chat:missing", contentComponent: "slot", title: "Missing" };
  const result = restoreDockLayout(value, [])!;
  expect((result.grid.root.data as any[])).toHaveLength(2); expect(result.panels["chat:missing"]).toBeUndefined();
});
test("invalid persisted data falls back instead of opening arbitrary components", () => {
  expect(restoreDockLayout(null, [])).toBeUndefined(); expect(restoreDockLayout({ panels: {} }, [])).toBeUndefined();
  const value = layout(); value.panels.chat.contentComponent = "untrusted";
  expect(restoreDockLayout(value, [])?.panels.chat.contentComponent).toBe("slot");
});
