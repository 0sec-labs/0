import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveSession, sessionsDir } from "../tui/session-store.js";
import { chatText, matchChat, searchSavedChats } from "./chat-search.js";

const homes: string[] = [];
const home = () => { const value = mkdtempSync(join(tmpdir(), "0-search-test-")); homes.push(value); return value; };
const messages = [{ role: "user", content: [{ type: "text", text: "Review customer ownership." }] }, { role: "assistant", content: [{ type: "text", text: "Check tenant isolation before export." }, { type: "tool_use", input: { token: "SECRET_ONLY_ARGUMENT" } }] }, { role: "user", content: [{ type: "tool_result", content: "SECRET_ONLY_OUTPUT" }] }];
afterEach(() => { for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true }); });
describe("chat search", () => {
  it("matches later replies and combined query words while excluding tool output and reasoning", () => {
    const document = { id: "a", title: "Customer API", updatedAt: "2026-10-02T00:00:00Z", archived: false, source: "live" as const, messages };
    expect(matchChat(document, "API isolation")?.preview).toContain("tenant isolation");
    expect(matchChat(document, "secret_only_output")).toBeNull();
    expect(matchChat(document, "secret_only_argument")).toBeNull();
    expect(chatText([{ role: "tool", content: "SECRET" }, { role: "assistant", content: [{ type: "thinking", text: "SECRET" }] }])).toBe("");
  });
  it("returns a bounded excerpt around a late match", () => {
    const result = matchChat({ id: "a", title: "Test", updatedAt: "", archived: false, source: "saved", messages: [{ role: "user", content: `${"prefix ".repeat(100)}needle suffix` }] }, "needle");
    expect(result?.preview).toContain("needle"); expect(result?.preview.startsWith("…")).toBe(true); expect(result!.preview.length).toBeLessThanOrEqual(182);
  });
  it("includes archived history, ignores corrupt files and excludes live-owned saved transcripts", async () => {
    const directory = home();
    for (const id of ["saved", "owned"]) saveSession({ id, savedAt: 100, cwd: "/fixture", messageCount: 0, preview: "", summary: "API review", archived: true, messages }, directory);
    writeFileSync(join(sessionsDir(directory), "corrupt.json"), "no json");
    const page = await searchSavedChats(directory, "isolation", new Set(["owned"]));
    expect(page.results).toEqual([expect.objectContaining({ id: "saved", archived: true, source: "saved" })]);
    expect(page.truncated).toBe(false);
    expect(await searchSavedChats(home(), "", new Set())).toEqual({ results: [], truncated: false });
  });
  it("hides empty saved chats and derives placeholder titles from the conversation", async () => {
    const directory = home();
    for (const id of ["empty", "tool-only", "conversation"]) saveSession({ id, savedAt: 100, cwd: "/fixture", messageCount: 0, preview: "", summary: "New chat", messages: id === "empty" ? [] : id === "tool-only" ? [{ role: "user", content: [{ type: "tool_result", content: "Tool output" }] }] : [{ role: "user", content: "Investigate customer isolation" }] }, directory);
    const page = await searchSavedChats(directory, "", new Set());
    expect(page.results).toEqual([expect.objectContaining({ id: "conversation", title: "Investigate customer isolation" })]);
  });
  it("reports skipped oversized history instead of reading it into memory", async () => {
    const directory = home(); mkdirSync(sessionsDir(directory), { recursive: true });
    writeFileSync(join(sessionsDir(directory), "large.json"), " ".repeat(8 * 1024 * 1024 + 1));
    expect(await searchSavedChats(directory, "", new Set())).toEqual({ results: [], truncated: true });
  });
});
