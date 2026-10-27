import { expect, test } from "vitest";
import type { ConsoleSessionSnapshot, DesktopConsoleEvent, ConsoleTurnOutcome } from "@0/shared";
import { reduceConversation, reduceTurns } from "../../../dashboard/src/console/transcript.js";

const image = { type: "image" as const, mediaType: "image/png", data: "iVBORw0KGgo=", name: "screenshot.png" };
const attachment = { kind: "image" as const, value: `data:${image.mediaType};base64,${image.data}`, name: image.name };
const startedAt = "2026-10-20T06:30:00.000Z";
const endedAt = "2026-10-20T06:31:15.000Z";
const outcome: ConsoleTurnOutcome = { assistantText: "A screenshot.", stopReason: "end_turn", budget: { tokensUsed: 20, tokenBudget: 1000, iterations: 1, maxToolIterations: 10 } };
function event(sequence: number, payload: Record<string, unknown>, occurredAt = startedAt): DesktopConsoleEvent {
  return { schemaVersion: 1, sessionId: "chat-images", sequence, occurredAt, ...payload } as DesktopConsoleEvent;
}
function snapshot(events: DesktopConsoleEvent[] = [], messages: ConsoleSessionSnapshot["messages"] = [
  { role: "user", content: [image] },
  { role: "assistant", content: [{ type: "text", text: "A screenshot." }] },
]): ConsoleSessionSnapshot {
  return { session: { status: "ready" }, pendingDecisions: [], lastOutcome: null, events, messages } as unknown as ConsoleSessionSnapshot;
}

test("saved image-only user messages remain real conversation turns", () => {
  const turns = reduceConversation(snapshot());
  expect(turns).toHaveLength(1);
  expect(turns[0].id).toBe("message-0");
  expect(turns[0].user).toMatchObject({ text: "", attachments: [attachment] });
  expect(turns[0].assistantText).toBe("A screenshot.");
  expect(turns[0].isComplete).toBe(true);
});

test("live image events retain attachments and elapsed turn timestamps", () => {
  const turns = reduceTurns([
    event(1, { type: "user", text: "", attachments: [attachment] }),
    event(2, { type: "assistant-delta", text: "A screenshot." }),
    event(3, { type: "turn-complete", ...outcome }, endedAt),
  ], "ready");
  expect(turns).toHaveLength(1);
  expect(turns[0].user.attachments).toEqual([attachment]);
  expect(turns[0].startedAt).toBe(startedAt);
  expect(turns[0].endedAt).toBe(endedAt);
  expect(Date.parse(turns[0].endedAt!) - Date.parse(turns[0].startedAt!)).toBe(75_000);
});

test("live and saved image history reconciles once and preserves timestamps", () => {
  const turns = reduceConversation(snapshot([
    event(1, { type: "user", text: "", attachments: [attachment] }),
    event(2, { type: "turn-complete", ...outcome }, endedAt),
  ]));
  expect(turns).toHaveLength(1);
  expect(turns[0].user.attachments).toEqual([attachment]);
  expect(turns[0].assistantText).toBe("A screenshot.");
  expect(turns[0]).toMatchObject({ id: "turn-1", startedAt, endedAt, isComplete: true });
});

test("repeated image-only messages reconcile in order without merging turns", () => {
  const second = { ...image, data: "R0lGODlh", mediaType: "image/gif", name: "second.gif" };
  const secondAttachment = { kind: "image" as const, value: `data:${second.mediaType};base64,${second.data}`, name: second.name };
  const turns = reduceConversation(snapshot([
    event(1, { type: "user", text: "", attachments: [attachment] }),
    event(2, { type: "turn-complete", ...outcome }, endedAt),
    event(3, { type: "user", text: "", attachments: [secondAttachment] }, "2026-10-20T06:32:00.000Z"),
  ], [{ role: "user", content: [image] }, { role: "assistant", content: [{ type: "text", text: "A screenshot." }] }, { role: "user", content: [second] }]));
  expect(turns).toHaveLength(2);
  expect(turns.map(turn => turn.user.attachments)).toEqual([[attachment], [secondAttachment]]);
  expect(turns[0]).toMatchObject({ startedAt, endedAt });
  expect(turns[1].startedAt).toBe("2026-10-20T06:32:00.000Z");
  expect(turns[1].endedAt).toBeUndefined();
});
