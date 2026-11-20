import { describe, expect, it } from "vitest";
import { filterNotes, folderLabel, noteDetail, type MemoryNote } from "../src/memory-model";

const note = (over: Partial<MemoryNote>): MemoryNote => ({ id: "m_1", text: "Run tests with pnpm test", scope: "global", source: "user", created: "2026-01-01T00:00:00.000Z", ...over });

describe("memory model", () => {
  it("shows the real path with its leading slash, the home directory as ~, and a repository by name", () => {
    expect(folderLabel("/Users/me/code/app")).toBe("~/code/app");
    expect(folderLabel("/home/me")).toBe("~");
    expect(folderLabel("/private/tmp/work")).toBe("/private/tmp/work");
    expect(folderLabel("/srv/app", "/srv")).toBe("~/app");
    expect(folderLabel("/")).toBe("/");
    expect(folderLabel("git:github.com/acme/app")).toBe("acme/app");
  });
  it("describes where a note applies and its kind, and nothing about who wrote it", () => {
    expect(noteDetail(note({}))).toBe("Everywhere");
    expect(noteDetail(note({ scope: "folder", folder: "/a/b/c", kind: "avoid", source: "model" }))).toBe("/a/b/c · Avoid");
    expect(noteDetail(note({ source: "import" }))).toBe("Everywhere");
    expect(noteDetail(note({ source: "model" }))).not.toMatch(/suggest|propos|thread/i);
  });
  it("labels a repository identity as owner/name", () => {
    expect(folderLabel("git:github.com/acme/app")).toBe("acme/app");
  });
  it("filters by folder, everywhere or all, and by search text", () => {
    const notes = [note({ id: "m_1" }), note({ id: "m_2", scope: "folder", folder: "/a", text: "Prefer small PRs" }), note({ id: "m_3", scope: "folder", folder: "/b", text: "Use tabs" })];
    expect(filterNotes(notes, "all", "").map(n => n.id)).toEqual(["m_1", "m_2", "m_3"]);
    expect(filterNotes(notes, "global", "").map(n => n.id)).toEqual(["m_1"]);
    expect(filterNotes(notes, "/a", "").map(n => n.id)).toEqual(["m_2"]);
    expect(filterNotes(notes, "all", " SMALL ").map(n => n.id)).toEqual(["m_2"]);
    expect(filterNotes([], "all", "")).toEqual([]);
  });
});
