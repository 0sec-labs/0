import { expect, test } from "vitest";
import type { ConsoleSavedSession, DesktopConsoleSession } from "@0/shared";
import { orderSessionRail } from "../../../dashboard/src/console/session-rail-order";

const saved = (id: string, savedAt: number): ConsoleSavedSession => ({ id, savedAt, cwd: "/repo", messageCount: 8, preview: id });
const live = (id: string, savedId?: string): DesktopConsoleSession => ({
  id, savedId, createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z",
  target: "/repo", role: "review", autonomyMode: "standard", scopeConfigured: false,
  status: "ready", messageCount: 8,
});

test("opening saved chats in any order preserves their history positions and identities", () => {
  const history = [saved("newest", 300), saved("middle", 200), saved("oldest", 100)];
  const original = orderSessionRail([], history, history).map(row => row.key);
  const middle = live("middle-live", "middle");
  expect(orderSessionRail([middle], [history[0]!, history[2]!], history).map(row => row.key)).toEqual(original);
  const oldest = live("oldest-live", "oldest");
  expect(orderSessionRail([oldest, middle], [history[0]!], history).map(row => row.key)).toEqual(original);
  middle.updatedAt = "2026-10-02T12:00:00Z";
  middle.status = "working";
  expect(orderSessionRail([middle, oldest], [history[0]!], history).map(row => row.key)).toEqual(original);
});

test("new conversations and new transcript activity sort by history rather than live status", () => {
  const history = [saved("older", Date.parse("2026-09-30T12:00:00Z"))];
  expect(orderSessionRail([live("new")], history, history).map(row => row.key)).toEqual(["new", "older"]);
  history[0]!.savedAt = Date.parse("2026-10-02T12:00:00Z");
  expect(orderSessionRail([live("new"), live("resumed", "older")], [], history).map(row => row.key)).toEqual(["older", "new"]);
});
