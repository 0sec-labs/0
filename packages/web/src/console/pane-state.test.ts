import { describe, expect, it } from "vitest";
import { chatPaneState, type ChatPaneInput } from "./pane-state";

const base: ChatPaneInput = { hasSnapshot: false, loading: false, recovering: false, hasSession: false, homeLanding: false, failed: false, timedOut: false, ownLayout: false };
const pane = (patch: Partial<ChatPaneInput>) => chatPaneState({ ...base, ...patch });

describe("chat pane state", () => {
  it("shows a loaded mission whatever else is true", () => {
    expect(pane({ hasSnapshot: true, loading: true, failed: true, timedOut: true, homeLanding: true })).toBe("conversation");
  });
  it("renders Home at once on bare /chats and while its new mission loads, never a skeleton", () => {
    expect(pane({ homeLanding: true })).toBe("home");
    expect(pane({ homeLanding: true, hasSession: true, loading: true })).toBe("home");
    expect(pane({ homeLanding: true, hasSession: true, loading: true, failed: true, timedOut: true })).toBe("home");
  });
  it("shows Home, not a skeleton flash, for a route id nothing knows", () => {
    expect(pane({ unknownRoute: true, hasSession: true, loading: true })).toBe("home");
    expect(pane({ unknownRoute: true, hasSession: true, loading: true, ownLayout: true })).toBe("skeleton");
  });
  it("keeps embedded, saved and read-only views on their own layout", () => {
    expect(pane({ homeLanding: true, ownLayout: true, hasSession: true, loading: true })).toBe("skeleton");
    expect(pane({ homeLanding: true, ownLayout: true })).toBe("blank");
  });
  it("shows the thread skeleton only while an existing mission is opening", () => {
    expect(pane({ hasSession: true, loading: true })).toBe("skeleton");
    expect(pane({ hasSession: true, recovering: true })).toBe("skeleton");
  });
  it("never leaves a failed or overdue open on a skeleton", () => {
    expect(pane({ hasSession: true, loading: false, failed: true })).toBe("failed");
    expect(pane({ hasSession: true, loading: true, timedOut: true })).toBe("failed");
    expect(pane({ hasSession: true, recovering: true, timedOut: true })).toBe("failed");
  });
  it("leaves the pane blank only when nothing is being opened", () => {
    expect(pane({})).toBe("blank");
  });
});
