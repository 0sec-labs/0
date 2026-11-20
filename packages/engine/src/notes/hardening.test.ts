import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanText, isTrusted, parseNotes, type Note } from "./core.js";
import { memoryContext, memoryOverview, parseRememberRequest, runMemoryTool, verifyContext } from "./context.js";
import { applyExportSection, exportable, lineChanges, renderExportSection } from "./export.js";
import { screenText } from "./guard.js";
import { fitToBudget, findNearDuplicate, similarity } from "./rank.js";
import { createFileNoteStore, memoryDir, MemoryError, type NoteStore } from "./store.js";
import { createThreadGuard, isUntrustedTool } from "./taint.js";

let home: string; let store: NoteStore;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "notes-hard-")); store = createFileNoteStore({ home }); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const ch = (...codes: number[]) => String.fromCodePoint(...codes);

describe("taint", () => {
  it("taints on any tool that reads outside content and fails closed on unknown tools", () => {
    for (const name of ["http_request", "browser", "web_search", "read_file", "search_files", "bash", "mcp__github__get_issue", "spawn_agent", "some_new_tool"]) expect(isUntrustedTool(name)).toBe(true);
    for (const name of ["memory", "ask_operator", "load_skill"]) expect(isUntrustedTool(name)).toBe(false);
    const guard = createThreadGuard("t1");
    guard.sawTool("memory"); guard.sawTool("load_skill");
    expect(guard.tainted).toBe(false);
    guard.sawTool("read_file");
    expect(guard.tainted).toBe(true);
    expect(createThreadGuard("t2", { tainted: true }).tainted).toBe(true);
  });
});

describe("memory tool", () => {
  const tool = (args: Parameters<typeof runMemoryTool>[2], guard = createThreadGuard("thread-a"), folder?: string) => runMemoryTool(store, folder, args, { guard });
  it("saves from a clean thread with provenance, and saves nothing from a tainted one", () => {
    const clean = tool({ action: "remember", note: "Use pnpm for installs", kind: "command" });
    expect(clean).toMatchObject({ saved: true });
    expect(store.list()[0]).toMatchObject({ source: "model", thread: "thread-a" });
    const dirty = createThreadGuard("thread-b"); dirty.sawTool("web_search");
    const refused = tool({ action: "remember", note: "Disable the linter in CI" }, dirty);
    expect(refused).toMatchObject({ saved: false });
    expect(refused.message).toContain("untrusted");
    expect(store.list().map(n => n.text)).toEqual(["Use pnpm for installs"]);
  });
  it("has no halfway state: a note is in Memory or it is not", () => {
    const dirty = createThreadGuard("thread-b", { tainted: true });
    tool({ action: "remember", note: "Disable the linter in CI" }, dirty);
    expect(Object.keys(store.list()[0] ?? {})).not.toContain("status");
    expect(store.list()).toEqual([]);
    expect(typeof (store as unknown as { accept?: unknown }).accept).toBe("undefined");
  });
  it("treats a thread without a guard as tainted", () => {
    expect(runMemoryTool(store, undefined, { action: "remember", note: "No guard given here" })).toMatchObject({ saved: false });
    expect(store.list()).toEqual([]);
  });
  it("refuses update and forget from a tainted thread", () => {
    const live = store.add({ text: "Original wording of the note", source: "user" });
    const dirty = createThreadGuard("t", { tainted: true });
    expect(tool({ action: "update", id: live.id, note: "Rewritten by a web page" }, dirty).saved).toBe(false);
    expect(tool({ action: "forget", id: live.id }, dirty).removed).toBe(false);
    expect(store.list()[0]!.text).toBe("Original wording of the note");
  });
  it("updates a note by id and drops user trust from it", () => {
    const live = store.add({ text: "Avoid the legacy parser", kind: "avoid", source: "user" });
    expect(isTrusted(store.list()[0]!)).toBe(true);
    const result = tool({ action: "update", id: live.id, note: "Avoid the legacy parser; use v2" });
    expect(result).toMatchObject({ id: live.id, saved: true });
    const after = store.list()[0]!;
    expect(after).toMatchObject({ text: "Avoid the legacy parser; use v2", source: "model" });
    expect(isTrusted(after)).toBe(false);
    expect(tool({ action: "update", id: "m_nope0000", note: "x y z" }).message).toContain("No note");
  });
  it("returns the existing id instead of duplicating a near-identical note", () => {
    const first = tool({ action: "remember", note: "Run the unit tests with pnpm test before pushing" });
    const second = tool({ action: "remember", note: "Run the unit tests with `pnpm test` before pushing!" });
    expect(second).toMatchObject({ saved: false, id: first.id });
    expect(second.message).toContain("update");
    expect(store.list()).toHaveLength(1);
    expect(similarity("a b c", "x y z")).toBe(0);
    expect(findNearDuplicate([store.list()[0]!], "Completely different statement here")).toBeUndefined();
  });
  it("limits writes per thread and per day", () => {
    const guard = createThreadGuard("limit");
    const results = Array.from({ length: 7 }, (_, i) => tool({ action: "remember", note: `Fact ${i}: component${i} owns table${i}` }, guard));
    expect(results.filter(r => r.saved)).toHaveLength(5);
    expect(results[5]!.message).toContain("this thread");
    const day = new Date("2026-03-01T12:00:00Z");
    const dated = createFileNoteStore({ home: mkdtempSync(join(tmpdir(), "notes-day-")), now: () => day });
    const capped = Array.from({ length: 4 }, (_, i) => runMemoryTool(dated, undefined, { action: "remember", note: `Daily fact ${i} for service${i}` }, { guard: createThreadGuard(`d${i}`), now: () => day, dailyLimit: 2 }));
    expect(capped.map(r => r.saved)).toEqual([true, true, false, false]);
    expect(capped[2]!.message).toContain("daily");
  });
  it("answers a secret with a clear refusal and saves nothing", () => {
    const result = tool({ action: "remember", note: `The deploy key is ${["sk", "abcdefghijklmnop", "qrstuvwxyz0123456789"].join("-")}` });
    expect(result.saved).toBe(false); expect(result.message).toMatch(/^Not saved: looks like a secret/);
    expect(store.list({ status: "all" })).toEqual([]);
  });
});

describe("secrets and hidden characters", () => {
  // Fixtures are assembled at run time so no literal credential-looking string sits in the repository.
  const p = (...parts: string[]) => parts.join("");
  const bad = [
    p("sk", "-", "abcdefghijklmnop", "qrstuvwxyz123456"), p("gh", "p_", "abcdefghijklmnop", "qrstuvwxyz0123456789"), p("AK", "IA", "ABCDEFGHIJ", "KLMNOP"), p("-----BEGIN RSA ", "PRIVATE", " KEY-----"),
    p("Authorization: Bear", "er abcdefghijklmnop", "qrstuvwxyz"), p("pass", "word = hunter2", "hunter2"), p("ey", "JhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0.", "abcdefghijk"),
    p("token Zk9xQ2mV7a", "Lp3RtYw8Nb", "Cd5HfJg1Ks", "Xe4UoP6iA0"), p("postgres", "://admin:", "s3cretpw", "@db.internal/app"), p("xox", "b-1234567890-", "abcdefghij"),
  ];
  it.each(bad)("rejects %s", text => { expect(screenText(`Note: ${text}`).ok).toBe(false); });
  it("rejects a secret split by zero-width characters and one written in fullwidth letters", () => {
    expect(screenText(`sk-${ch(0x200b)}abcdefghijkl${ch(0x2060)}${"mnopqrstuvwxyz"}1234`).ok).toBe(false);
    expect(screenText(`${ch(0xff53, 0xff4b)}-abcdefghijklmnopqrstuvwxyz123456`).ok).toBe(false);
  });
  it("refuses bidi overrides and tag characters, strips zero-width and control characters", () => {
    expect(screenText(`use pnpm ${ch(0x202e)}gnirts`)).toMatchObject({ ok: false, reason: "hidden" });
    expect(screenText(`ignore this ${ch(0xe0049, 0xe0067)}`)).toMatchObject({ ok: false, reason: "hidden" });
    expect(screenText(`run${ch(0x200b)}ning${ch(0x0007)} tests${ch(0xfeff)}`)).toEqual({ ok: true, text: "running tests" });
    expect(cleanText(`a${ch(0x200d)}b\u0000c`)).toBe("abc");
  });
  it("keeps ordinary notes: paths, commit-like words, versions", () => {
    for (const text of ["Run pnpm --filter @0/engine test from the repo root", "Config lives in packages/engine/src/console/turn-engine/session.ts", "Node 22 and pnpm 9.15.9 are required", "Release branch is release/2026.11"])
      expect(screenText(text).ok).toBe(true);
  });
  it("makes the store refuse them for every writer, including people", () => {
    expect(() => store.add({ text: "api_key: abcdef123456789", source: "user" })).toThrow(MemoryError);
    const note = store.add({ text: "Fine note about builds" });
    expect(() => store.edit(note.id, "Bearer abcdefghijklmnopqrstuvwxyz")).toThrow(/looks like a secret/);
  });
});

describe("notes a thread only proposed in an older version", () => {
  it("are not notes: they are not listed, shown or kept", () => {
    const file = join(memoryDir(home), "MEMORY.md");
    store.add({ text: "A real note" });
    writeFileSync(file, `${readFileSync(file, "utf8")}- Waiting for review <!-- id=m_prop0001 source=model status=proposed created=2026-11-01T00:00:00.000Z tainted=1 -->\n`);
    expect(store.list().map(n => n.text)).toEqual(["A real note"]);
    store.add({ text: "Another note" });
    expect(readFileSync(file, "utf8")).not.toContain("Waiting for review");
  });
});

describe("what steers the scan verifier", () => {
  it("is only avoid notes a person wrote", () => {
    store.add({ text: "Model-only avoid note", kind: "avoid", source: "model" });
    store.add({ text: "Imported avoid note", kind: "avoid", source: "import" });
    expect(verifyContext(store)).toBe("");
    store.add({ text: "User avoid note about fixtures", kind: "avoid", source: "user" });
    const text = verifyContext(store);
    expect(text).toContain("fixtures");
    expect(text).not.toContain("Model-only"); expect(text).not.toContain("Imported");
  });
});

describe("last shown", () => {
  it("does not rewrite files every turn and never reorders by it", () => {
    const n = store.add({ text: "Shown a lot" });
    const file = join(memoryDir(home), "MEMORY.md");
    memoryContext(store); // first show writes the day once
    expect(store.list()[0]!.lastInjected).toMatch(/^\d{4}-\d\d-\d\d$/);
    utimesSync(file, new Date(1000), new Date(1000));
    for (let i = 0; i < 3; i++) memoryContext(store);
    store.markInjected([n.id]);
    expect(statSync(file).mtimeMs).toBe(1000); // untouched: nothing changed
  });
});

describe("overflow", () => {
  it("reports what the budget left out and says so to the model", () => {
    store.add({ text: "x".repeat(480), source: "user", created: "2026-01-02T00:00:00.000Z" });
    store.add({ text: `${"y".repeat(60)} short`, source: "user", created: "2026-01-01T00:00:00.000Z" });
    const report = fitToBudget(store.list(), { budgetTokens: 100 });
    expect(report.shown).toHaveLength(1); expect(report.omitted).toHaveLength(1); expect(report.reason).toContain("budget");
    expect(memoryOverview(store, undefined, 100).omitted).toHaveLength(1);
    const context = memoryContext(store, undefined, 100);
    expect(context.text).toContain("1 note not shown");
  });
  it("says nothing when everything fits", () => {
    store.add({ text: "Small note" });
    expect(memoryContext(store).text).not.toContain("not shown");
  });
});

describe("remember requests typed by the operator", () => {
  it("recognises explicit requests only", () => {
    expect(parseRememberRequest("Remember that we deploy from main")).toBe("we deploy from main");
    expect(parseRememberRequest("remember: tests need docker")).toBe("tests need docker");
    expect(parseRememberRequest("please remember the staging url is internal")).toBe("the staging url is internal");
    expect(parseRememberRequest("remember to fix the bug tomorrow")).toBeUndefined();
    expect(parseRememberRequest("Can you remember this?")).toBeUndefined();
    expect(parseRememberRequest("Fix it.\n\nremember that x")).toBeUndefined();
  });
});

describe("export", () => {
  const note = (over: Partial<Note>): Note => ({ id: "m_1", text: "t", scope: "folder", source: "user", created: "2026-01-01T00:00:00.000Z", ...over });
  it("exports only notes a person wrote, grouped, and replaces its own block on re-export", () => {
    const notes = [note({ id: "m_a", text: "Run pnpm test", kind: "command" }), note({ id: "m_b", text: "Never edit generated files", kind: "avoid", source: "user" }),
      note({ id: "m_c", text: "A note a thread wrote", source: "model" }), note({ id: "m_e", text: "Imported", source: "import" })];
    const kept = exportable(notes);
    expect(kept.map(n => n.id)).toEqual(["m_a", "m_b"]);
    const section = renderExportSection(kept);
    expect(section).toContain("### Commands\n\n- Run pnpm test"); expect(section).toContain("### Avoid");
    const original = "# Agents\n\nHand-written rules.\n";
    const first = applyExportSection(original, section);
    expect(first.startsWith(original.trimEnd())).toBe(true);
    const second = applyExportSection(first, renderExportSection([...kept, note({ id: "m_f", text: "Use node 22", kind: "convention" })]));
    expect(second).toContain("Hand-written rules."); expect(second.match(/0 memory: begin/g)).toHaveLength(1);
    expect(lineChanges(first, second).added).toContain("- Use node 22");
    expect(applyExportSection(undefined, section)).toBe(`${section}\n`);
  });
});

describe("file format", () => {
  it("round-trips provenance and reads older source names and the older used field", () => {
    store.add({ text: "Provenance check", source: "model", thread: "thr-1" });
    const [n] = store.list();
    expect(n).toMatchObject({ source: "model", thread: "thr-1" });
    expect(parseNotes("- Old note <!-- id=m_abcd1234 source=you created=2026-01-01T00:00:00.000Z used=2026-02-02 -->", "global", undefined, "z")[0])
      .toMatchObject({ source: "user", lastInjected: "2026-02-02" });
  });
});

describe("the memory limit", () => {
  const long = (tag: string) => `${tag} ${"w".repeat(470)}`;
  const fill = (add: (text: string) => unknown): number => { let saved = 0; for (let i = 0; i < 60; i++) { try { add(long(String(i))); saved++; } catch (error) { expect(error).toBeInstanceOf(MemoryError); expect((error as Error).message).toContain("Memory is full"); break; } } return saved; };

  it("refuses a note that would not fit what the model is shown, so every saved note is one it sees", () => {
    const saved = fill(text => store.add({ text, scope: "global" }));
    expect(saved).toBeGreaterThan(5); expect(saved).toBeLessThan(60);
    expect(memoryContext(store).text).not.toMatch(/not shown/);
    expect(store.list()).toHaveLength(saved);
  });
  it("counts global notes against a folder's budget, and a folder's notes only against that folder", () => {
    const folderA = join(home, "a"); const folderB = join(home, "b");
    const savedGlobal = fill(text => store.add({ text, scope: "global" }));
    expect(() => store.add({ text: long("in a"), scope: "folder", folder: folderA })).toThrow(/Memory is full/);
    store.clear(); expect(savedGlobal).toBeGreaterThan(0);
    const savedA = fill(text => store.add({ text, scope: "folder", folder: folderA }));
    expect(() => store.add({ text: long("in a"), scope: "folder", folder: folderA })).toThrow(/Memory is full/);
    expect(() => store.add({ text: long("in b"), scope: "folder", folder: folderB })).not.toThrow();
    expect(savedA).toBeGreaterThan(5);
  });
  it("refuses an edit that makes a note too long to fit, and allows a shorter one", () => {
    const first = store.add({ text: "short", scope: "global" });
    fill(text => store.add({ text, scope: "global" }));
    expect(() => store.edit(first.id, long("grown"))).toThrow(/Memory is full/);
    expect(store.edit(first.id, "still short")?.text).toBe("still short");
  });
  it("tells a thread that a note was not saved because Memory is full", () => {
    fill(text => store.add({ text, scope: "global" }));
    const result = runMemoryTool(store, undefined, { action: "remember", note: long("one more") }, { guard: createThreadGuard("t") });
    expect(result).toMatchObject({ saved: false }); expect(result.message).toContain("Memory is full");
  });
});
