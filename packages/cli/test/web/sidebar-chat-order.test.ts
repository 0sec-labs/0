import { expect, test } from "vitest";
import { rememberSidebarActivity, sortSidebarChats } from "../../../dashboard/src/console/sidebar-chat-order";
import type { SessionRailRow } from "../../../dashboard/src/console/session-rail-order";
const row = (key: string, title: string, updatedAt: string, timestamp: number): SessionRailRow => ({ kind: "live", key, timestamp, session: { id: key, title, updatedAt } as Extract<SessionRailRow, { kind: "live" }>["session"] });
test("remembered activity order ignores last-opened timestamps and alphabetical filtering leaves input unchanged", () => {
  const rows = [row("old", "Zulu report", "2026-10-23T12:00:00Z", 1), row("new", "Alpha audit", "2026-10-22T12:00:00Z", 2)];
  expect(sortSidebarChats(rows, "updated").map(item => item.key)).toEqual(["new", "old"]);
  expect(sortSidebarChats(rows, "name").map(item => item.key)).toEqual(["new", "old"]);
  expect(sortSidebarChats(rows, "name", " REPORT ").map(item => item.key)).toEqual(["old"]);
  expect(rows.map(item => item.key)).toEqual(["old", "new"]);
});

test("opening a chat cannot promote it, but a new message can", () => {
  const activity = new Map();
  const rows = [row("recent", "Recent", "2026-10-23T12:00:00Z", 2), row("older", "Older", "2026-10-22T12:00:00Z", 1)];
  rows.forEach(item => { item.session.messageCount = 4; });
  const order = () => sortSidebarChats(rememberSidebarActivity(rows, activity), "updated").map(item => item.key);
  expect(order()).toEqual(["recent", "older"]);
  rows[1].session.updatedAt = "2026-10-24T12:00:00Z";
  expect(order()).toEqual(["recent", "older"]);
  rows[1].session.messageCount = 5;
  expect(order()).toEqual(["older", "recent"]);
});
