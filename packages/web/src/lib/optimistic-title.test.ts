import { describe, expect, it } from "vitest";
import type { ConsoleSessionSnapshot, DesktopConsoleSession } from "@0/engine/shared";
import { sessionsWithTitle, snapshotWithTitle } from "./optimistic-title";

const session = (id: string, title: string) => ({ id, title, titleSource: "auto" }) as unknown as DesktopConsoleSession;

describe("optimistic title", () => {
  it("renames the matching snapshot and marks it user-owned", () => {
    const snapshot = { title: "Old", session: session("a", "Old") } as unknown as ConsoleSessionSnapshot;
    const next = snapshotWithTitle(snapshot, "a", "New");
    expect(next.title).toBe("New");
    expect(next.session.title).toBe("New");
    expect(next.session.titleSource).toBe("user");
  });
  it("leaves another session's snapshot untouched", () => {
    const snapshot = { title: "Old", session: session("b", "Old") } as unknown as ConsoleSessionSnapshot;
    expect(snapshotWithTitle(snapshot, "a", "New")).toBe(snapshot);
  });
  it("renames one list row and keeps the others", () => {
    const rows = [session("a", "A"), session("b", "B")];
    const next = sessionsWithTitle(rows, "a", "New");
    expect(next[0]!.title).toBe("New");
    expect(next[1]).toBe(rows[1]);
  });
});
