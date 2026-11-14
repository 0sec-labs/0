import { describe, expect, it } from "vitest";
import { sessionTitlePending } from "./sidebar-chat-order";

describe("sessionTitlePending", () => {
  const now = Date.parse("2026-01-01T00:00:10Z");
  it("keeps shimmering through the post-turn title call", () => {
    expect(sessionTitlePending({ status: "working", titleSource: "default" }, now)).toBe(true);
    expect(sessionTitlePending({ status: "ready", titleSource: "default", messageCount: 2, updatedAt: "2026-01-01T00:00:08Z" }, now)).toBe(true);
  });
  it("stops once titled, stale, or before any exchange", () => {
    expect(sessionTitlePending({ status: "ready", titleSource: "auto", messageCount: 2, updatedAt: "2026-01-01T00:00:08Z" }, now)).toBe(false);
    expect(sessionTitlePending({ status: "ready", titleSource: "default", messageCount: 2, updatedAt: "2025-12-31T00:00:00Z" }, now)).toBe(false);
    expect(sessionTitlePending({ status: "ready", titleSource: "default", messageCount: 0, updatedAt: "2026-01-01T00:00:08Z" }, now)).toBe(false);
  });
});
