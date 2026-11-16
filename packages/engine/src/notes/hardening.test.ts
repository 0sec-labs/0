import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanText, isTrusted, parseNotes, type Note } from "./core.js";
import { memoryContext, memoryOverview, parseRememberRequest, runMemoryTool, verifyContext } from "./context.js";
import { applyExportSection, exportable, lineChanges, renderExportSection } from "./export.js";
import { screenText } from "./guard.js";
import { fitToBudget, findNearDuplicate, similarity } from "./rank.js";
import { createFileNoteStore, memoryDir, MemoryError, type NoteStore } from "./store.js";
import { createThreadGuard, isUntrustedTool, modelNoteStatus } from "./taint.js";

let home: string; let store: NoteStore;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "notes-hard-")); store = createFileNoteStore({ home }); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const ch = (...codes: number[]) => String.fromCodePoint(...codes);

describe("taint", () => {
  it("taints on any tool that reads outside content and fails closed on unknown tools", () => {
    for (const name of ["http_request", "browser", "web_search", "read_file", "search_files", "bash", "mcp__github__get_issue", "spawn_agent", "some_new_tool"]) expect(isUntrustedTool(name)).toBe(true);
    for (const name of ["memory", "ask_operator", "update_todos", "plan"]) expect(isUntrustedTool(name)).toBe(false);
    const guard = createThreadGuard("t1");
    guard.sawTool("memory"); guard.sawTool("update_todos");
    expect(guard.tainted).toBe(false); expect(modelNoteStatus(guard)).toBe("live");
    guard.sawTool("read_file");
    expect(guard.tainted).toBe(true); expect(modelNoteStatus(guard)).toBe("proposed");
    expect(createThreadGuard("t2", { tainted: true }).tainted).toBe(true);
  });
});

describe("memory tool", () => {
  const tool = (args: Parameters<typeof runMemoryTool>[2], guard = createThreadGuard("thread-a"), folder?: string) => runMemoryTool(store, folder, args, { guard });
  it("commits from a clean thread with provenance and proposes from a tainted one", () => {
    const clean = tool({ action: "remember", note: "Use pnpm for installs", kind: "command" });
    expect(clean).toMatchObject({ saved: true, status: "live" });
    expect(store.list()[0]).toMatchObject({ source: "model", status: "live", thread: "thread-a" });
    const dirty = createThreadGuard("thread-b"); dirty.sawTool("web_search");
    const proposed = tool({ action: "remember", note: "Disable the linter in CI" }, dirty);
    expect(proposed).toMatchObject({ saved: true, status: "proposed" });
    expect(proposed.message).toContain("review");
    expect(store.list().map(n => n.text)).toEqual(["Use pnpm for installs"]);
    expect(store.list({ status: "proposed" })[0]).toMatchObject({ source: "model", tainted: true, thread: "thread-b" });
  });
  it("treats a thread without a guard as tainted", () => {
    expect(runMemoryTool(store, undefined, { action: "remember", note: "No guard given here" })).toMatchObject({ status: "proposed" });
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

describe("proposals", () => {
  it("lists, accepts (optionally edited) and rejects proposals; accepted notes become reviewed and live", () => {
    const a = store.add({ text: "Prefer small pull requests", source: "model", status: "proposed", tainted: true, thread: "t" });
    const b = store.add({ text: "Staging deploys need the flag", source: "model", status: "proposed", kind: "avoid" });
    expect(store.list()).toEqual([]);
    expect(store.list({ status: "proposed" })).toHaveLength(2);
    expect(store.accept(a.id)).toMatchObject({ status: "live", reviewed: true, source: "model" });
    expect(store.accept(b.id, "Staging deploys need the --staging flag")).toMatchObject({ text: "Staging deploys need the --staging flag", status: "live" });
    expect(store.accept(a.id)).toBeUndefined(); // already live
    const c = store.add({ text: "Reject me please", source: "model", status: "proposed" });
    expect(store.remove(c.id)).toBe(true);
    expect(store.list({ status: "proposed" })).toEqual([]);
    expect(readFileSync(join(memoryDir(home), "MEMORY.md"), "utf8")).toContain("reviewed=1");
  });
  it("lets only trusted avoid notes steer the scan verifier", () => {
    store.add({ text: "Known false positive: debug route", kind: "avoid", source: "model", status: "proposed" });
    store.add({ text: "Model-only avoid note", kind: "avoid", source: "model" });
    store.add({ text: "Imported avoid note", kind: "avoid", source: "import" });
    expect(verifyContext(store)).toBe("");
    store.add({ text: "User avoid note about fixtures", kind: "avoid", source: "user" });
    const accepted = store.add({ text: "Accepted avoid note about mocks", kind: "avoid", source: "model", status: "proposed" });
    store.accept(accepted.id);
    const text = verifyContext(store);
    expect(text).toContain("fixtures"); expect(text).toContain("mocks");
    expect(text).not.toContain("debug route"); expect(text).not.toContain("Model-only"); expect(text).not.toContain("Imported");
  });
  it("promotes a proposal when the same note is then added by a person", () => {
    store.add({ text: "Same fact", source: "model", status: "proposed" });
    expect(store.add({ text: "Same fact", source: "user" })).toMatchObject({ status: "live", reviewed: true });
    expect(store.list()).toHaveLength(1);
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
  const note = (over: Partial<Note>): Note => ({ id: "m_1", text: "t", scope: "folder", source: "user", status: "live", created: "2026-01-01T00:00:00.000Z", ...over });
  it("exports only user-written or accepted live notes, grouped, and replaces its own block on re-export", () => {
    const notes = [note({ id: "m_a", text: "Run pnpm test", kind: "command" }), note({ id: "m_b", text: "Never edit generated files", kind: "avoid", source: "model", reviewed: true }),
      note({ id: "m_c", text: "Unreviewed model note", source: "model" }), note({ id: "m_d", text: "Proposal", source: "model", status: "proposed" }), note({ id: "m_e", text: "Imported", source: "import" })];
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
    store.add({ text: "Provenance check", source: "model", status: "proposed", thread: "thr-1", tainted: true });
    const [n] = store.list({ status: "all" });
    expect(n).toMatchObject({ source: "model", status: "proposed", thread: "thr-1", tainted: true });
    expect(parseNotes("- Old note <!-- id=m_abcd1234 source=you created=2026-01-01T00:00:00.000Z used=2026-02-02 -->", "global", undefined, "z")[0])
      .toMatchObject({ source: "user", status: "live", lastInjected: "2026-02-02" });
  });
});
