import { expect, test } from "vitest";
import { sortSidebarChats } from "../../../dashboard/src/console/sidebar-chat-order";
import type { SessionRailRow } from "../../../dashboard/src/console/session-rail-order";
const row = (key: string, title: string, updatedAt: string, timestamp: number): SessionRailRow => ({ kind: "live", key, timestamp, session: { id: key, title, updatedAt } as Extract<SessionRailRow, { kind: "live" }>["session"] });
test("recent activity wins over creation order and alphabetical sort filters without changing input", () => {
  const rows = [row("old", "Zulu report", "2026-10-23T12:00:00Z", 1), row("new", "Alpha audit", "2026-10-22T12:00:00Z", 2)];
  expect(sortSidebarChats(rows, "updated").map(item => item.key)).toEqual(["old", "new"]);
  expect(sortSidebarChats(rows, "name").map(item => item.key)).toEqual(["new", "old"]);
  expect(sortSidebarChats(rows, "name", " REPORT ").map(item => item.key)).toEqual(["old"]);
  expect(rows.map(item => item.key)).toEqual(["old", "new"]);
});
