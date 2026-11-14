import { describe, expect, test, vi } from "vitest";
import type { DesktopConsoleSession } from "@0/engine/shared";
import { findBlankSession, isBlankSession, withCreateLock } from "./blank-session";
import { partitionVisualCalls } from "./visuals";
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

describe("saved visualize calls", () => {
  test("renders valid visualize calls inline and keeps other tools", () => {
    const calls = [
      { id: "t1", name: "bash", arguments: { command: "ls" } },
      { id: "t2", name: "visualize", arguments: { kind: "table", title: "Hosts", summary: "Open hosts", spec: { columns: [], rows: [] } } },
      { id: "t3", name: "visualize", arguments: "not-an-object" },
    ];
    const { visuals, others } = partitionVisualCalls(calls);
    expect(visuals.map((item) => item.id)).toEqual(["t2"]);
    expect(others.map((item) => item.id)).toEqual(["t1", "t3"]);
  });
});
