import { expect, test } from "vitest";
import type { ConsoleSessionSnapshot, DesktopConsoleEvent } from "@0/shared";
import { reduceConversation, reduceTurns } from "../../../dashboard/src/console/transcript.js";

const alice = { userId: "alice", displayName: "Alice" };
const bob = { userId: "bob", displayName: "Bob", proposalId: "proposal-a" };
function user(sequence: number, author?: typeof alice): DesktopConsoleEvent {
  return { schemaVersion: 1, sessionId: "chat-a", sequence, occurredAt: "2026-10-08T12:00:00Z", type: "user", text: "Same request", ...(author ? { author } : {}) };
}
test("live author attribution reconciles repeated canonical prompts to the correct user turn", () => {
  const snapshot = {
    session: { status: "ready" },
    pendingDecisions: [], lastOutcome: null,
    messages: [alice, undefined, bob].flatMap(author => [
      { role: "user", content: [{ type: "text", text: "Same request" }], ...(author ? { author } : {}) },
      { role: "assistant", content: [{ type: "text", text: "Retained answer" }] },
    ]),
    events: [user(1, alice), user(2), user(3, bob)],
  } as unknown as ConsoleSessionSnapshot;
  expect(reduceTurns(snapshot.events, "ready").map(turn => turn.user.author)).toEqual([alice, undefined, bob]);
  expect(reduceConversation(snapshot).map(turn => turn.user.author)).toEqual([alice, undefined, bob]);
});
test("saved canonical authors remain visible when no live event journal is retained", () => {
  const snapshot = {
    session: { status: "ready" },
    pendingDecisions: [], lastOutcome: null,
    messages: [{ role: "user", content: [{ type: "text", text: "Inspect evidence" }], author: bob }],
    events: [],
  } as unknown as ConsoleSessionSnapshot;
  expect(reduceConversation(snapshot)[0]?.user.author).toEqual(bob);
});
