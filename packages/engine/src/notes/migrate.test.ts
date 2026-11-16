// Fixtures follow the formats the old writers produced: hunt-memory JSONL (one HuntRecord per
// line, codebase notes carry a root), craft-memory JSONL (level/content/source), SQLite rows
// for lessons (learning_knowledge.body JSON) and triage memories (triage_memories columns).
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { learningProjectId } from "../storage/learning.js";
import { createShimmedDatabase } from "../storage/wasm-shim.js";
import { migrateOldMemory, migrationReportPath } from "./migrate.js";
import { createFileNoteStore } from "./store.js";

let home: string; let repo: string; let db: string; let craft: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mig-")); repo = join(home, "repo"); db = join(home, "x.db"); craft = join(home, "craft.jsonl");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function seedOldStores(): void {
  mkdirSync(join(home, "repo")); repo = realpathSync(join(home, "repo"));
  mkdirSync(join(home, ".0", "hunt-memory"), { recursive: true });
  const base = { kind: "note", target: "*", vulnClass: "other", tags: [], schemaVersion: 1 };
  writeFileSync(join(home, ".0", "hunt-memory", "patterns.jsonl"), [
    { ...base, id: "h1", title: "Auth entry", summary: "Sessions are checked in auth.ts.", createdAt: 1_700_000_000_000, source: "console:1", codebase: { root: repo, files: [{ path: "auth.ts", digest: "sha256:aa" }] } },
    { ...base, id: "h2", title: "Repair outcome: IDOR", summary: "Repair VERIFIED after 1 attempt(s).", tags: ["secure-lifecycle", "verified"], createdAt: 1_700_000_100_000, source: "secure:r1", codebase: { root: repo, files: [] } },
    { ...base, id: "h3", kind: "finding", target: "shop.example.com", vulnClass: "sqli", title: "SQLi in search", summary: "Error-based SQLi on /search.", createdAt: 1_700_000_200_000, source: "scan:1" },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  const sql = createShimmedDatabase(db);
  sql.exec("CREATE TABLE learning_knowledge(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL)");
  const lesson = (id: string, summary: string, status: string) => sql.prepare("INSERT INTO learning_knowledge VALUES(?,?,?,?)").run(id, learningProjectId(repo), JSON.stringify({ id, projectId: learningProjectId(repo), summary, status, createdAt: "2026-01-01T00:00:00.000Z" }), "2026-01-01");
  lesson("k1", "Sessions are checked in auth.ts.", "current");
  lesson("k2", "Only visible in the lessons store.", "stale");
  lesson("k3", "The user switched this one off.", "disabled");
  sql.exec("CREATE TABLE triage_memories (id TEXT PRIMARY KEY, scope TEXT, scope_value TEXT, category TEXT, pattern TEXT, reasoning TEXT, created_at INTEGER, applied_count INTEGER)");
  sql.prepare("INSERT INTO triage_memories VALUES(?,?,?,?,?,?,?,?)").run("t1", "global", null, "xss", "React escapes output", "JSX encodes by default", 1_700_000_300_000, 0);
  sql.close();
  writeFileSync(craft, [{ id: "c1", level: "procedural", content: "Minimal MNG needs a signature first.", source: "task-1", createdAt: 3 }, { id: "c2", level: "principle", content: "Seeded text.", source: "preseed", createdAt: 4 }].map(r => JSON.stringify(r)).join("\n") + "\n");
}

describe("migrateOldMemory", () => {
  it("imports every old store once, without loss, leaving old files untouched", () => {
    seedOldStores();
    const huntFile = join(home, ".0", "hunt-memory", "patterns.jsonl");
    const before = readFileSync(huntFile, "utf8");
    const store = createFileNoteStore({ home });
    const report = migrateOldMemory(store, { home, dbPath: db, craftPaths: [craft] });
    const notes = store.list(); const texts = notes.map(n => n.text);
    expect(texts).toContain("Auth entry: Sessions are checked in auth.ts.");
    expect(texts).toContain("SQLi in search: Error-based SQLi on /search.");
    expect(texts).toContain("Minimal MNG needs a signature first.");
    expect(texts).toContain("Only visible in the lessons store.");
    expect(texts.some(t => t.includes("React escapes output") && t.includes("JSX encodes"))).toBe(true);
    expect(texts.some(t => t.includes("switched this one off"))).toBe(false);
    expect(texts.some(t => t.includes("Seeded text"))).toBe(false);
    expect(notes.find(n => n.text.includes("Repair outcome"))).toMatchObject({ kind: "fix-decision", folder: repo, source: "0" });
    expect(notes.find(n => n.text.includes("React"))?.kind).toBe("avoid");
    expect(notes.find(n => n.text.includes("Only visible"))).toMatchObject({ scope: "folder", folder: repo });
    expect(notes.find(n => n.text.startsWith("Auth entry"))?.created).toBe("2023-11-14T22:13:20.000Z");
    expect(report.sources.hunt).toMatchObject({ found: 3, imported: 3 });
    expect(report.sources.lessons).toMatchObject({ found: 3, imported: 1, duplicates: 1, skipped: 1 });
    expect(report.sources.triage.imported).toBe(1);
    expect(report.sources.craft).toMatchObject({ found: 1, imported: 1 });
    expect(readFileSync(huntFile, "utf8")).toBe(before);
    const count = notes.length;
    expect(migrateOldMemory(store, { home, dbPath: db, craftPaths: [craft] })).toEqual(report);
    expect(store.list().length).toBe(count);
  });
  it("is idempotent even when the report is lost, and skips damaged lines", () => {
    seedOldStores();
    appendFileSync(join(home, ".0", "hunt-memory", "patterns.jsonl"), "{not json\n");
    const store = createFileNoteStore({ home });
    migrateOldMemory(store, { home, dbPath: db });
    const count = store.list().length;
    rmSync(migrationReportPath(home));
    expect(migrateOldMemory(store, { home, dbPath: db }).total).toBe(0);
    expect(store.list().length).toBe(count);
  });
  it("is a no-op with no old stores", () => {
    const store = createFileNoteStore({ home });
    expect(migrateOldMemory(store, { home, dbPath: join(home, "none.db") }).total).toBe(0);
    expect(store.list()).toEqual([]);
  });
});
