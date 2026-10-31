import { expect, test } from "vitest";
import { staleSessionRecovery, remapSessionDrafts } from "../../../dashboard/src/console/session-recovery.js";
import type { DesktopConsoleSession, ConsoleSavedSession } from "@0/shared";
const live = (id: string, savedId?: string) => ({ id, savedId, status: "ready" }) as DesktopConsoleSession;
const saved = (id: string) => ({ id }) as ConsoleSavedSession;
test("stale routes find already resumed history by saved ID", () => {
  expect(staleSessionRecovery("old", [live("new", "old")], [], {})).toEqual({ kind: "live", id: "new", durableId: "old" });
  expect(staleSessionRecovery("ephemeral", [live("new", "durable")], [], { ephemeral: { savedId: "durable", messageCount: 20 } })?.id).toBe("new");
});
test("resumes saved history before considering replacement blanks", () => {
  expect(staleSessionRecovery("old", [], [saved("old")], {})).toEqual({ kind: "saved", id: "old", durableId: "old" });
  expect(staleSessionRecovery("old", [], [], { old: { savedId: "old", messageCount: 0 } })?.kind).toBe("blank");
  expect(staleSessionRecovery("unknown", [], [], {})).toBeUndefined();
  expect(staleSessionRecovery("history", [], [], { history: { savedId: "saved", messageCount: 10 } })).toBeUndefined();
  expect(staleSessionRecovery("live", [live("live")], [], {})).toBeUndefined();
});
test("moves root and worker drafts and attachment values without overwriting newer drafts", () => {
  expect(remapSessionDrafts({ "old:root": "unsent", "old:worker": "worker text", "new:root": "newer" }, "old", "new")).toMatchObject({ "new:root": "newer", "new:worker": "worker text" });
  const image = { id: "image", value: "data:image/png;base64,abcd" };
  expect(remapSessionDrafts({ "old:root": [image] }, "old", "new")["new:root"]).toEqual([image]);
});
