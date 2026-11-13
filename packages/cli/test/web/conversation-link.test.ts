import { expect, test } from "vitest";
import { conversationLink } from "../../../dashboard/src/console/conversation-link.js";
import { staleSessionRecovery } from "../../../dashboard/src/console/session-recovery.js";
import type { DesktopConsoleSession, ConsoleSavedSession } from "@0/shared";

test("copied links retain the saved identity and execution host across live replacements", () => {
  const first = conversationLink("https://console.example.test", "remote-lab", { id: "live-one", savedId: "saved-history" });
  const replacement = conversationLink("https://console.example.test", "remote-lab", { id: "live-two", savedId: "saved-history" });
  expect(first).toBe("https://console.example.test/console/saved-history?host=remote-lab");
  expect(replacement).toBe(first);
  const id = new URL(first).pathname.split("/").at(-1)!;
  const live = { id: "live-two", savedId: "saved-history", status: "ready" } as DesktopConsoleSession;
  expect(staleSessionRecovery(id, [live], [], {})).toEqual({ kind: "live", id: "live-two", durableId: "saved-history" });
  expect(staleSessionRecovery(id, [], [{ id } as ConsoleSavedSession], {})).toEqual({ kind: "saved", id, durableId: id });
});

test("new and retained conversations include the local host explicitly without stale route state", () => {
  expect(conversationLink("https://console.example.test/console/old?worker=old&host=other", "local", { id: "new-chat" }))
    .toBe("https://console.example.test/console/new-chat?host=local");
  expect(conversationLink("https://console.example.test", "local", { id: "saved-chat" }))
    .toBe("https://console.example.test/console/saved-chat?host=local");
});
