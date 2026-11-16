import { appendFileSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HuntMemoryStore } from "../memory/hunt-memory.js";
import { CraftMemoryStore } from "../craft-memory/store.js";
import { LearningService } from "../learning-service.js";
import { LearningStore, learningProjectId } from "../storage/learning.js";
import { osecDB } from "../storage/database.js";
import { migrateOldMemory, migrationReportPath } from "./migrate.js";
import { createFileNoteStore } from "./store.js";

let home: string; let repo: string; let db: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mig-")); repo = join(home, "repo"); db = join(home, "x.db");
  mkdirSync(repo); writeFileSync(join(repo, "auth.ts"), "export const a = 1;\n");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function seedOldStores(): string {
  const hunt = new HuntMemoryStore({ home });
  hunt.rememberCodebase({ root: repo, paths: ["auth.ts"], title: "Auth entry", summary: "Sessions are checked in auth.ts.", source: "console:1" });
  hunt.rememberCodebase({ root: repo, paths: ["auth.ts"], title: "Repair outcome: IDOR", summary: "Repair VERIFIED after 1 attempt(s).", tags: ["secure-lifecycle", "verified"], source: "secure:r1" });
  const learning = new LearningStore(db);
  new LearningService(learning).importCodebaseNotes(learningProjectId(repo), repo, hunt);
  learning.close();
  const sql = new osecDB(db);
  sql.insertTriageMemory({ id: "t1", scope: "global", category: "xss", pattern: "React escapes output", reasoning: "JSX encodes by default", createdAt: 1_700_000_000_000 });
  sql.close();
  const craft = new CraftMemoryStore(join(home, "craft.jsonl"));
  craft.remember({ level: "procedural", content: "Minimal MNG needs a signature first.", source: "task-1" });
  craft.remember({ level: "principle", content: "Seeded text.", source: "preseed" });
  return join(home, "craft.jsonl");
}

describe("migrateOldMemory", () => {
  it("imports every old store once, without loss, leaving old files untouched", () => {
    const craft = seedOldStores();
    const huntFile = join(home, ".0", "hunt-memory", "patterns.jsonl");
    const before = readFileSync(huntFile, "utf8");
    const store = createFileNoteStore({ home });
    const report = migrateOldMemory(store, { home, dbPath: db, craftPaths: [craft] });
    const texts = store.list().map(n => n.text);
    expect(texts.some(t => t.includes("Sessions are checked in auth.ts"))).toBe(true);
    expect(texts).toContain("Minimal MNG needs a signature first.");
    expect(texts.some(t => t.includes("React escapes output") && t.includes("JSX encodes"))).toBe(true);
    expect(store.list().find(n => n.text.includes("Repair outcome"))).toMatchObject({ kind: "fix-decision", folder: realpathSync(repo), source: "0" });
    expect(store.list().find(n => n.text.includes("React"))?.kind).toBe("avoid");
    expect(texts.some(t => t.includes("Seeded text"))).toBe(false);
    expect(report.sources.hunt.imported).toBe(2);
    expect(report.sources.lessons).toMatchObject({ found: 2, imported: 0, duplicates: 2 });
    expect(report.sources.triage.imported).toBe(1);
    expect(readFileSync(huntFile, "utf8")).toBe(before);
    const count = store.list().length;
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
  });
});
