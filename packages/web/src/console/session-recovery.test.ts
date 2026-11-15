import { describe, expect, it } from "vitest";
import type { ConsoleSavedSession, DesktopConsoleSession } from "@0/engine/shared";
import { isMissingSession, recoveredSessionPath, rememberSessionAlias, remapSessionDrafts, resolveSessionAlias, staleSessionRecovery } from "./session-recovery";

const live = (id: string, extra: Partial<DesktopConsoleSession> = {}) => ({ id, status: "ready", ...extra }) as DesktopConsoleSession;
const saved = (id: string) => ({ id }) as ConsoleSavedSession;

describe("staleSessionRecovery", () => {
  it("leaves a live id alone", () => expect(staleSessionRecovery("a", [live("a")], [], {})).toBeUndefined());
  it("resumes a saved-but-not-live thread by its durable id", () => {
    expect(staleSessionRecovery("a", [], [saved("a")], {})).toEqual({ kind: "saved", id: "a", durableId: "a" });
  });
  it("follows an alias to the live session that owns the saved transcript", () => {
    expect(staleSessionRecovery("old", [live("new", { savedId: "a" })], [saved("a")], { old: { savedId: "a" } })).toEqual({ kind: "live", id: "new", durableId: "a" });
  });
  it("only a known-empty alias becomes a blank thread", () => {
    expect(staleSessionRecovery("x", [], [], { x: { savedId: "x", messageCount: 0 } })?.kind).toBe("blank");
    expect(staleSessionRecovery("x", [], [], { x: { savedId: "x", messageCount: 3 } })).toBeUndefined();
  });
  it("an id that never existed has no recovery", () => expect(staleSessionRecovery("ghost", [live("a")], [saved("b")], {})).toBeUndefined());
});

describe("isMissingSession", () => {
  const base = { sessionId: "ghost", hasSnapshot: false, recovering: false, loading: false, listsSettled: true, offline: false, error: "That thread isn't available here.", sessions: [], saved: [], aliases: {} };
  it("sends an unknown id Home", () => expect(isMissingSession(base)).toBe(true));
  it("recognises raw server wording", () => {
    expect(isMissingSession({ ...base, error: "Console thread was not found." })).toBe(true);
    expect(isMissingSession({ ...base, error: "Console session not found." })).toBe(true);
  });
  it("also fires when the rosters failed to load (settled)", () => expect(isMissingSession({ ...base, sessions: [], saved: [] })).toBe(true));
  it("waits while the rosters are still loading", () => expect(isMissingSession({ ...base, listsSettled: false })).toBe(false));
  it("waits while the backend is offline or reconnecting", () => expect(isMissingSession({ ...base, offline: true })).toBe(false));
  it("does not fire for a recoverable saved id", () => expect(isMissingSession({ ...base, sessionId: "a", saved: [saved("a")] })).toBe(false));
  it("does not fire while a recovery is running or for transient errors", () => {
    expect(isMissingSession({ ...base, recovering: true })).toBe(false);
    expect(isMissingSession({ ...base, error: "Connection interrupted. Reconnecting…" })).toBe(false);
    expect(isMissingSession({ ...base, error: undefined })).toBe(false);
  });
});

describe("recovery routing", () => {
  it("replaces the stale id and keeps the query string", () => {
    expect(recoveredSessionPath("L2", "host=local")).toBe("/chats/L2?host=local");
    expect(recoveredSessionPath("L2", "")).toBe("/chats/L2");
  });
  it("carries composer drafts to the new id", () => {
    expect(remapSessionDrafts({ "old:root": "hi" }, "old", "L2")["L2:root"]).toBe("hi");
  });
});

describe("resolveSessionAlias", () => {
  it("passes unknown ids through and follows chains without looping", () => {
    expect(resolveSessionAlias("a", {})).toBe("a");
    expect(resolveSessionAlias(undefined, {})).toBeUndefined();
    expect(resolveSessionAlias("a", { a: "b", b: "c" })).toBe("c");
    expect(resolveSessionAlias("a", { a: "b", b: "a" })).toBe("b");
  });
  it("persists the alias so the old URL keeps resolving", () => {
    rememberSessionAlias("old", "live2");
    expect(resolveSessionAlias("old")).toBe("live2");
    rememberSessionAlias("old", "live3");
    expect(resolveSessionAlias("old")).toBe("live3");
  });
});

describe("staleSessionRecovery (migrated edge cases)", () => {
  it("finds already resumed history by saved id", () => {
    expect(staleSessionRecovery("old", [live("new", { savedId: "old" })], [], {})).toEqual({ kind: "live", id: "new", durableId: "old" });
    expect(staleSessionRecovery("ephemeral", [live("new", { savedId: "durable" })], [], { ephemeral: { savedId: "durable", messageCount: 20 } })?.id).toBe("new");
  });
  it("does not blank a history-bearing alias", () => {
    expect(staleSessionRecovery("history", [], [], { history: { savedId: "saved", messageCount: 10 } })).toBeUndefined();
    expect(staleSessionRecovery("unknown", [], [], {})).toBeUndefined();
  });
  it("moves root and worker drafts and attachment values without overwriting newer drafts", () => {
    expect(remapSessionDrafts({ "old:root": "unsent", "old:worker": "worker text", "new:root": "newer" }, "old", "new")).toMatchObject({ "new:root": "newer", "new:worker": "worker text" });
    const image = { id: "image", value: "data:image/png;base64,abcd" };
    expect(remapSessionDrafts({ "old:root": [image] }, "old", "new")["new:root"]).toEqual([image]);
  });
});
