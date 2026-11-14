import { describe, expect, it } from "vitest";
import type { ConsoleSavedSession, DesktopConsoleSession } from "@0/engine/shared";
import { isMissingSession, recoveredSessionPath, remapSessionDrafts, staleSessionRecovery } from "./session-recovery";

const live = (id: string, extra: Partial<DesktopConsoleSession> = {}) => ({ id, status: "ready", ...extra }) as DesktopConsoleSession;
const saved = (id: string) => ({ id }) as ConsoleSavedSession;

describe("staleSessionRecovery", () => {
  it("leaves a live id alone", () => expect(staleSessionRecovery("a", [live("a")], [], {})).toBeUndefined());
  it("resumes a saved-but-not-live mission by its durable id", () => {
    expect(staleSessionRecovery("a", [], [saved("a")], {})).toEqual({ kind: "saved", id: "a", durableId: "a" });
  });
  it("follows an alias to the live session that owns the saved transcript", () => {
    expect(staleSessionRecovery("old", [live("new", { savedId: "a" })], [saved("a")], { old: { savedId: "a" } })).toEqual({ kind: "live", id: "new", durableId: "a" });
  });
  it("only a known-empty alias becomes a blank mission", () => {
    expect(staleSessionRecovery("x", [], [], { x: { savedId: "x", messageCount: 0 } })?.kind).toBe("blank");
    expect(staleSessionRecovery("x", [], [], { x: { savedId: "x", messageCount: 3 } })).toBeUndefined();
  });
  it("an id that never existed has no recovery", () => expect(staleSessionRecovery("ghost", [live("a")], [saved("b")], {})).toBeUndefined());
});

describe("isMissingSession", () => {
  const base = { sessionId: "ghost", hasSnapshot: false, recovering: false, loading: false, sessionsLoaded: true, savedLoaded: true, error: "Console session not found.", sessions: [], saved: [], aliases: {} };
  it("sends an unknown id Home", () => expect(isMissingSession(base)).toBe(true));
  it("waits until both rosters loaded", () => expect(isMissingSession({ ...base, savedLoaded: false })).toBe(false));
  it("does not fire for a recoverable saved id", () => expect(isMissingSession({ ...base, sessionId: "a", saved: [saved("a")] })).toBe(false));
  it("does not fire while a recovery is running or without a not-found error", () => {
    expect(isMissingSession({ ...base, recovering: true })).toBe(false);
    expect(isMissingSession({ ...base, error: "Network down" })).toBe(false);
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
