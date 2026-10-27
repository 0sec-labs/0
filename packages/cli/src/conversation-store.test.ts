import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { searchConversations } from "./conversation-store.js";
import { saveSession, sessionsDir } from "./tui/session-store.js";

const homes: string[] = [];
const home = () => { const directory = mkdtempSync(join(tmpdir(), "0-conversation-store-")); homes.push(directory); return directory; };
afterEach(() => { for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("shared conversation catalog", () => {
  it("ranks title matches before body matches and breaks recency ties by ID", async () => {
    const directory = home();
    for (const [id, savedAt, summary, text] of [["body-b", 2, "Other", "tenant export"], ["body-a", 2, "Other", "tenant export"], ["title", 1, "Tenant export", "Inspection results"]] as const) {
      saveSession({ id, savedAt, cwd: "/project", messageCount: 1, preview: "", summary, messages: [{ role: "assistant", content: text }] }, directory);
    }
    const result = await searchConversations({ homeDir: directory, query: "tenant export" });
    expect(result.conversations.map(match => match.session.id)).toEqual(["title", "body-a", "body-b"]);
    expect((await searchConversations({ homeDir: directory, query: "tenant", excludedIds: new Set(["title"]), cwd: "/elsewhere" })).conversations).toEqual([]);
  });

  it("excludes secrets and private content from matching and excerpts", async () => {
    const directory = home();
    saveSession({ id: "private", savedAt: 1, cwd: "/project", messageCount: 2, preview: "", messages: [
      { role: "user", content: "password=UNIQUE_PASSWORD public prose" },
      { role: "assistant", providerRaw: { output: "PRIVATE_ENVELOPE" }, content: [{ type: "thinking", text: "PRIVATE_REASONING" }, { type: "tool_use", input: { value: "PRIVATE_ARGUMENT" } }, { type: "text", text: "Public response" }] },
    ] }, directory);
    for (const query of ["UNIQUE_PASSWORD", "PRIVATE_ENVELOPE", "PRIVATE_REASONING", "PRIVATE_ARGUMENT"]) {
      expect((await searchConversations({ homeDir: directory, query })).conversations).toEqual([]);
    }
    const result = await searchConversations({ homeDir: directory, query: "public" });
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]?.preview).toContain("[redacted]");
    expect(result.conversations[0]?.preview).not.toContain("UNIQUE_PASSWORD");
  });

  it("ignores symlinks, directories and corrupt transcripts and reports size limits", async () => {
    const directory = home();
    const dir = sessionsDir(directory);
    mkdirSync(dir, { recursive: true });
    const target = join(directory, "external.json");
    writeFileSync(target, JSON.stringify({ savedAt: 1, cwd: "/project", messages: [{ role: "user", content: "External secret" }] }));
    symlinkSync(target, join(dir, "linked.json"));
    mkdirSync(join(dir, "directory.json"));
    writeFileSync(join(dir, "corrupt.json"), "invalid");
    writeFileSync(join(dir, "oversized.json"), " ".repeat(8 * 1024 * 1024 + 1));
    expect(await searchConversations({ homeDir: directory })).toEqual({ conversations: [], truncated: true });
  });
});
