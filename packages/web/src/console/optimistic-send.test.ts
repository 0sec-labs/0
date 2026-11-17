import { describe, expect, it } from "vitest";
import type { ConsoleSessionSnapshot } from "@0/engine/shared";
import { createOptimisticSend, settledSends, withOptimisticSends } from "./optimistic-send";
import { reduceConversation } from "./transcript";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
function snap(messages: unknown[], extra: object = {}): ConsoleSessionSnapshot {
  return { session: { id: "s", status: "ready" }, cursor: 1, messages, events: [], pendingDecisions: [], workers: [], queuedMessages: [], lastOutcome: null, ...extra } as unknown as ConsoleSessionSnapshot;
}
const texts = (s: ConsoleSessionSnapshot) => reduceConversation(s).map((t) => t.user.text);

describe("optimistic sends", () => {
  it("shows a follow-up message in a thread that already has turns before the server has it", () => {
    const server = snap([user("one"), assistant("a")]);
    const item = createOptimisticSend(server, "s", { text: "two" });
    const shown = withOptimisticSends(server, "s", [item]);
    expect(texts(shown)).toEqual(["one", "two"]);
    expect(shown.session.status).toBe("working");
  });
  it("does not paint the previous turn's outcome onto the new message", () => {
    const server = snap([user("one"), assistant("a")], { lastOutcome: { stopReason: "end_turn", assistantText: "a" } });
    const shown = withOptimisticSends(server, "s", [createOptimisticSend(server, "s", { text: "two" })]);
    const turns = reduceConversation(shown);
    expect(turns[1].assistantText).toBe("");
    expect(turns[1].isComplete).toBeFalsy();
  });
  it("keeps one bubble, in the same place, once the server echoes it", () => {
    const server = snap([user("one"), assistant("a")]);
    const item = createOptimisticSend(server, "s", { text: "two" });
    const echoed = snap([user("one"), assistant("a"), user("two")], { session: { id: "s", status: "working" } });
    expect(settledSends(echoed, [item])).toEqual([item]);
    expect(texts(withOptimisticSends(echoed, "s", [item]))).toEqual(["one", "two"]);
  });
  it("tells repeated identical messages apart (rapid double send)", () => {
    const server = snap([]);
    const first = createOptimisticSend(server, "s", { text: "go" });
    const second = createOptimisticSend(withOptimisticSends(server, "s", [first]), "s", { text: "go" });
    expect(texts(withOptimisticSends(server, "s", [first, second]))).toEqual(["go", "go"]);
    const one = snap([user("go")]);
    expect(settledSends(one, [first, second])).toEqual([first]);
    expect(texts(withOptimisticSends(one, "s", [first, second]))).toEqual(["go", "go"]);
  });
  it("shows a message sent while a turn runs as queued at once", () => {
    const server = snap([user("one")], { session: { id: "s", status: "working" } });
    const item = createOptimisticSend(server, "s", { text: "later", mode: "queue" });
    const shown = withOptimisticSends(server, "s", [item]);
    expect(shown.queuedMessages.map((m) => m.text)).toEqual(["later"]);
    expect(texts(shown)).toEqual(["one"]);
    const confirmed = snap([user("one")], { session: { id: "s", status: "working" }, queuedMessages: [{ id: "q1", text: "later", createdAt: "" }] });
    expect(settledSends(confirmed, [item])).toEqual([item]);
  });
  it("shows image attachments in the bubble", () => {
    const server = snap([]);
    const item = createOptimisticSend(server, "s", { text: "look", attachments: [{ kind: "image", value: "data:image/png;base64,AAAA", name: "a.png" }] });
    expect(reduceConversation(withOptimisticSends(server, "s", [item]))[0].user.attachments).toHaveLength(1);
  });
  it("ignores other threads", () => {
    const server = snap([]);
    expect(withOptimisticSends(server, "other", [createOptimisticSend(server, "s", { text: "x" })])).toBe(server);
  });
});
