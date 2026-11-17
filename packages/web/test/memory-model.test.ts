import { describe, expect, it } from "vitest";
import { filterNotes, folderLabel, noteDetail, overflowNotice, proposalDetail, type MemoryNote } from "../src/memory-model";

const note = (over: Partial<MemoryNote>): MemoryNote => ({ id: "m_1", text: "Run tests with pnpm test", scope: "global", source: "user", status: "live", created: "2026-01-01T00:00:00.000Z", ...over });

describe("memory model", () => {
  it("shows the real path with its leading slash, the home directory as ~, and a repository by name", () => {
    expect(folderLabel("/Users/me/code/app")).toBe("~/code/app");
    expect(folderLabel("/home/me")).toBe("~");
    expect(folderLabel("/private/tmp/work")).toBe("/private/tmp/work");
    expect(folderLabel("/srv/app", "/srv")).toBe("~/app");
    expect(folderLabel("/")).toBe("/");
    expect(folderLabel("git:github.com/acme/app")).toBe("acme/app");
  });
  it("describes where a note applies, its kind and who wrote it, in plain words", () => {
    expect(noteDetail(note({}))).toBe("Everywhere · You");
    expect(noteDetail(note({ scope: "folder", folder: "/a/b/c", kind: "avoid", source: "model" }))).toBe("/a/b/c · Avoid · Suggested by a thread");
    expect(noteDetail(note({ source: "import" }))).toBe("Everywhere · Imported");
  });
  it("labels a repository identity as owner/name and says when a proposal read outside content", () => {
    expect(folderLabel("git:github.com/acme/app")).toBe("acme/app");
    expect(proposalDetail(note({ source: "model", status: "proposed", tainted: true }))).toBe("Everywhere · Suggested by a thread · This thread read web pages or other outside content before suggesting this note.");
    expect(proposalDetail(note({ source: "model", status: "proposed" }))).toBe("Everywhere · Suggested by a thread");
  });
  it("says how many notes the model is not shown, for the selected filter", () => {
    const overflow = [{ count: 2, ids: ["m_1", "m_2"], reason: "the memory budget of 2000 tokens is full; older notes are left out first" }, { folder: "/a", count: 3, ids: ["m_2", "m_3", "m_4"] }];
    expect(overflowNotice([], "all")).toBe("");
    expect(overflowNotice(overflow, "all")).toContain("4 notes are not shown to the model: the memory budget of 2000 tokens is full");
    expect(overflowNotice(overflow, "global")).toContain("2 notes are not shown");
    expect(overflowNotice(overflow, "/b")).toContain("2 notes are not shown");
    expect(overflowNotice([{ count: 1, ids: ["m_1"] }], "all")).toContain("1 note is not shown");
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
