import { describe, expect, it } from "vitest";
import type { ConsoleSessionSnapshot, DesktopConsoleEvent } from "@0/engine/shared";
import { applyEvents } from "./workspace-events";

const snapshot = { cursor: 1, events: [], messages: [], runtime: { providerId: "openai", model: "mock-fast" }, session: { id: "s" } } as unknown as ConsoleSessionSnapshot;

describe("applyEvents", () => {
  it("adopts the runtime of a session event so a changed model survives a reload", () => {
    const event = { type: "session", sequence: 2, session: { id: "s", runtime: { providerId: "openai", model: "mock-smart" } } } as unknown as DesktopConsoleEvent;
    expect(applyEvents(snapshot, [event], 2).runtime?.model).toBe("mock-smart");
  });
  it("keeps the runtime when the session event carries none", () => {
    const event = { type: "session", sequence: 2, session: { id: "s" } } as unknown as DesktopConsoleEvent;
    expect(applyEvents(snapshot, [event], 2).runtime?.model).toBe("mock-fast");
  });
  it("adopts the folder of a session event so the picker never shows a stale workspace", () => {
    const first = { type: "session", sequence: 2, session: { id: "s", workspacePath: "/a" } } as unknown as DesktopConsoleEvent;
    const back = { type: "session", sequence: 3, session: { id: "s", workspacePath: "/b c" } } as unknown as DesktopConsoleEvent;
    const next = applyEvents(applyEvents(snapshot, [first], 2), [back], 3);
    expect(next.workspacePath).toBe("/b c");
    expect(applyEvents(next, [{ type: "session", sequence: 4, session: { id: "s" } } as unknown as DesktopConsoleEvent], 4).workspacePath).toBe("/b c");
  });
});
