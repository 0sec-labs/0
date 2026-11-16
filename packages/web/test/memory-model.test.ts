import { describe, expect, it } from "vitest";
import { filterNotes, folderLabel, noteDetail, type MemoryNote } from "../src/memory-model";

const note = (over: Partial<MemoryNote>): MemoryNote => ({ id: "m_1", text: "Run tests with pnpm test", scope: "global", source: "you", created: "2026-01-01T00:00:00.000Z", ...over });

describe("memory model", () => {
  it("names a folder by its last two segments", () => {
    expect(folderLabel("/Users/me/code/app")).toBe("code/app");
    expect(folderLabel("/")).toBe("/");
  });
  it("describes where a note applies, its kind and who wrote it, in plain words", () => {
    expect(noteDetail(note({}))).toBe("Everywhere · You");
    expect(noteDetail(note({ scope: "folder", folder: "/a/b/c", kind: "avoid", source: "0" }))).toBe("b/c · Avoid · 0");
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
