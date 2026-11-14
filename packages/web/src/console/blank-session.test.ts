import { describe, expect, test } from "vitest";
import type { DesktopConsoleSession } from "@0/engine/shared";
import { findBlankSession, isBlankSession } from "./blank-session";
import { mergeSessionAliases } from "./use-session-aliases";

const session = (over: Partial<DesktopConsoleSession>) =>
  ({ id: "a", title: "New mission", target: "", status: "ready", messageCount: 0, ...over }) as DesktopConsoleSession;

describe("blank sessions", () => {
  test("ready, empty, untitled sessions are blank", () => {
    expect(isBlankSession(session({}), null)).toBe(true);
    expect(isBlankSession(session({ messageCount: 2 }), null)).toBe(false);
    expect(isBlankSession(session({ status: "working" }), null)).toBe(false);
  });
  test("finds the first reusable blank and skips team mode", () => {
    const list = [session({ id: "x", target: "t" }), session({ id: "y" }), session({ id: "z" })];
    expect(findBlankSession(list, null, false)?.id).toBe("y");
    expect(findBlankSession(list, null, true)).toBeUndefined();
    expect(findBlankSession([session({ title: "Audit foo" })], null, false)).toBeUndefined();
  });
});

describe("session aliases", () => {
  test("keeps identity when nothing changed", () => {
    const first = mergeSessionAliases({}, [session({ id: "a", savedId: "s1", messageCount: 1 })]);
    expect(first).toEqual({ a: { savedId: "s1", messageCount: 1 } });
    expect(mergeSessionAliases(first, [session({ id: "a", savedId: "s1", messageCount: 1 })])).toBe(first);
  });
});
