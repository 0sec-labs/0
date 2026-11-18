import { describe, expect, test, vi } from "vitest";
import type { DesktopConsoleSession } from "@0/engine/shared";
import { findBlankSession, isBlankSession, withCreateLock } from "./blank-session";
import { mergeSessionAliases } from "./use-session-aliases";

const session = (over: Partial<DesktopConsoleSession>) =>
  ({ id: "a", title: "New thread", status: "ready", messageCount: 0, ...over }) as DesktopConsoleSession;

describe("blank sessions", () => {
  test("ready, empty, untitled sessions are blank", () => {
    expect(isBlankSession(session({}), null)).toBe(true);
    expect(isBlankSession(session({ messageCount: 2 }), null)).toBe(false);
    expect(isBlankSession(session({ status: "working" }), null)).toBe(false);
  });
  test("finds the first reusable blank and skips team mode", () => {
    const list = [session({ id: "x", title: "Real work" }), session({ id: "y" }), session({ id: "z" })];
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

describe("create lock", () => {
  test("runs tasks one at a time through navigator.locks, and directly without it", async () => {
    let tail: Promise<unknown> = Promise.resolve();
    vi.stubGlobal("navigator", {
      locks: { request: (_name: string, task: () => Promise<unknown>) => (tail = tail.then(task)) },
    });
    const order: string[] = [];
    const slow = withCreateLock(async () => {
      await new Promise((done) => setTimeout(done, 10));
      order.push("a");
    });
    const fast = withCreateLock(async () => void order.push("b"));
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a", "b"]);
    vi.stubGlobal("navigator", {});
    expect(await withCreateLock(async () => 7)).toBe(7);
    vi.unstubAllGlobals();
  });
});

