import { describe, expect, it } from "vitest";
import type { ConsolePublicMessage, ConsoleSavedSession, DesktopConsoleSession } from "@0/engine/shared";
import { reduceConversation } from "./transcript";
import { hasOlderMessages, prependMessages } from "./snapshot-window";
import { rememberSessionAlias, resolveSessionAlias } from "./session-recovery";
import { savedRouteTarget, savedTranscriptSnapshot } from "./saved-snapshot";

const meta = { id: "s1", savedAt: 1_700_000_000_000, cwd: "/w", messageCount: 6, preview: "scan the api", summary: "API scan" } as ConsoleSavedSession;
const text = (role: "user" | "assistant", value: string): ConsolePublicMessage => ({ role, content: [{ type: "text", text: value }] }) as ConsolePublicMessage;
const TABLE = "| Host | Risk |\n| --- | --- |\n| api | high |";
const FENCE = "```ts\nconst a = 1;\n```";
const page = (messages: ConsolePublicMessage[], firstIndex = 0, total = messages.length) => ({ meta, messages, total, firstIndex, hasMore: firstIndex > 0 });

describe("savedTranscriptSnapshot", () => {
  it("renders every assistant message and keeps tables and code fences intact", () => {
    const messages: ConsolePublicMessage[] = [
      text("user", "scan"),
      { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "http", input: { url: "https://x.test" } }] } as ConsolePublicMessage,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "200 OK" }] } as ConsolePublicMessage,
      text("assistant", `Result\n\n${TABLE}\n\n${FENCE}`),
      text("user", "and more"),
      text("assistant", "Second answer"),
    ];
    const turns = reduceConversation(savedTranscriptSnapshot("s1", page(messages)));
    expect(turns).toHaveLength(2);
    expect(turns[0]!.user.text).toBe("scan");
    expect(turns[0]!.assistantText).toContain(TABLE);
    expect(turns[0]!.assistantText).toContain(FENCE);
    expect(turns[0]!.toolCalls).toMatchObject([{ id: "t1", name: "http", result: "200 OK", isRunning: false }]);
    expect(turns[1]!.assistantText).toBe("Second answer");
    expect(turns.every((turn) => !turn.isWorking)).toBe(true);
  });

  it("turns a visualize call into an inline visual", () => {
    const visual = { role: "assistant", content: [{ type: "tool_use", id: "v1", name: "visualize", input: { kind: "table", title: "Hosts", summary: "s", spec: { kind: "table", columns: ["a"], rows: [["1"]] } } }] } as unknown as ConsolePublicMessage;
    const turns = reduceConversation(savedTranscriptSnapshot("s1", page([text("user", "show"), visual])));
    expect(turns[0]!.visuals?.map((item) => item.id)).toContain("v1");
  });

  it("is an idle, read-only session addressed by the saved id", () => {
    const snapshot = savedTranscriptSnapshot("s1", page([text("user", "hi")]));
    expect(snapshot.session).toMatchObject({ id: "s1", savedId: "s1", status: "ready", title: "API scan", messageCount: 1 });
    expect(snapshot.workers).toEqual([]);
    expect(snapshot.pendingDecisions).toEqual([]);
    expect(snapshot.events).toEqual([]);
  });

  it("exposes older pages through the window meta and prepends them", () => {
    const newest = savedTranscriptSnapshot("s1", page([text("user", "c"), text("assistant", "d")], 4, 6));
    expect(hasOlderMessages(newest)).toBe(true);
    const merged = prependMessages(newest, { messages: [text("user", "a"), text("assistant", "b"), text("user", "x"), text("assistant", "y")], firstIndex: 0 });
    expect(merged.messages).toHaveLength(6);
    expect(hasOlderMessages(merged)).toBe(false);
  });

  it("falls back to the preview, then a generic title, and tolerates an empty record", () => {
    expect(savedTranscriptSnapshot("s1", { ...page([]), meta: { ...meta, summary: undefined } }).title).toBe("scan the api");
    const empty = savedTranscriptSnapshot("s1", { ...page([]), meta: { ...meta, summary: undefined, preview: "" } });
    expect(empty.title).toBe("Saved mission");
    expect(empty.window?.firstMessageIndex).toBeNull();
  });
});

describe("savedRouteTarget", () => {
  const live = (id: string, extra: Partial<DesktopConsoleSession> = {}) => ({ id, status: "ready", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra }) as DesktopConsoleSession;
  it("opens the transcript when nothing live owns the record", () => {
    expect(savedRouteTarget("s1", [live("other")])).toEqual({ kind: "saved", savedId: "s1" });
    expect(savedRouteTarget("s1", undefined)).toEqual({ kind: "saved", savedId: "s1" });
  });
  it("prefers the live session that was resumed from the record", () => {
    expect(savedRouteTarget("s1", [live("L2", { savedId: "s1" })])).toEqual({ kind: "live", sessionId: "L2" });
  });
  it("ignores closed sessions and a missing id", () => {
    expect(savedRouteTarget("s1", [live("L2", { savedId: "s1", status: "closed" })])).toEqual({ kind: "saved", savedId: "s1" });
    expect(savedRouteTarget(undefined, [])).toBeUndefined();
  });
});

describe("resuming from a saved route", () => {
  it("keeps the saved id resolving to the resumed live session", () => {
    rememberSessionAlias("saved-abc", "live-9");
    expect(resolveSessionAlias("saved-abc")).toBe("live-9");
    expect(savedRouteTarget("saved-abc", [{ id: "live-9", savedId: "saved-abc", status: "working", createdAt: "", updatedAt: "" } as DesktopConsoleSession])).toEqual({ kind: "live", sessionId: "live-9" });
  });
});
