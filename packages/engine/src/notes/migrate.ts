// One-time, idempotent import of every older memory store into the one Memory. Old data is only
// read, never changed or deleted. Notes from old stores are marked source "import" (triage notes, which people wrote, are marked as yours).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "../shared/index.js";
import { createShimmedDatabase } from "../storage/wasm-shim.js";
import { resolveOsecDbPath } from "../storage/database-lifecycle.js";
import { learningProjectId } from "../storage/learning.js";
import { cleanText, type NoteKind } from "./core.js";
import { memoryDir, type NoteStore } from "./store.js";

export interface MigrationOptions {
  home?: string;
  /** SQLite database holding lessons and triage memories. Defaults to the engine database. */
  dbPath?: string;
  /** Extra craft-memory JSONL files (the benchmark store has no default location). */
  craftPaths?: readonly string[];
  now?: () => Date;
}
export interface SourceReport { found: number; imported: number; duplicates: number; skipped: number }
export interface MigrationReport { version: 1; importedAt: string; sources: Record<"hunt" | "craft" | "lessons" | "triage", SourceReport>; total: number }

interface Candidate { text: string; folder?: string; kind?: NoteKind; created?: string }
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const iso = (ms: unknown): string | undefined => (typeof ms === "number" && Number.isFinite(ms) && ms > 1e11 ? new Date(ms).toISOString() : undefined);
const sentence = (title: string, summary: string): string => cleanText(title && summary && !summary.startsWith(title) ? `${title}: ${summary}` : summary || title);

function jsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf8").split("\n")) { try { if (line.trim()) rows.push(record(JSON.parse(line))); } catch { /* damaged line: skip */ } }
  return rows;
}

/** Hunt memory (and the secure-lifecycle project memory, which wrote into it). */
function fromHunt(home: string | undefined, roots: Map<string, string>): Candidate[] {
  return jsonl(join(homeStateDir(home), "hunt-memory", "patterns.jsonl")).flatMap(row => {
    const text = sentence(str(row["title"]), str(row["summary"]));
    if (!text) return [];
    const root = str(record(row["codebase"])["root"]) || undefined;
    if (root) roots.set(learningProjectId(root), root);
    const tags = Array.isArray(row["tags"]) ? row["tags"].map(String) : [];
    const kind: NoteKind | undefined = str(row["source"]).startsWith("secure:") ? (tags.includes("verified") ? "fix-decision" : "avoid") : undefined;
    return [{ text, folder: root, kind, created: iso(row["createdAt"]) }];
  });
}

function fromCraft(paths: readonly string[]): Candidate[] {
  return paths.flatMap(path => jsonl(path)).flatMap(row => {
    const content = str(row["content"]);
    return content && str(row["source"]) !== "preseed" ? [{ text: cleanText(content), created: iso(row["createdAt"]) }] : [];
  });
}

function rows(dbPath: string, sql: string): Array<Record<string, unknown>> {
  if (!existsSync(dbPath)) return [];
  let db: ReturnType<typeof createShimmedDatabase> | undefined;
  try { db = createShimmedDatabase(dbPath, { readOnly: true }); return db.prepare(sql).all() as Array<Record<string, unknown>>; }
  catch { return []; } // table missing or database unreadable: nothing to import
  finally { try { db?.close(); } catch { /* ignore */ } }
}

function fromLessons(dbPath: string, roots: Map<string, string>): Candidate[] {
  return rows(dbPath, "SELECT body FROM learning_knowledge").flatMap(row => {
    const entry = record((() => { try { return JSON.parse(str(row["body"])); } catch { return {}; } })());
    const text = str(entry["status"]) === "disabled" ? "" : cleanText(str(entry["summary"])); // a lesson the user switched off stays off
    return str(entry["summary"]) ? [{ text, folder: roots.get(str(entry["projectId"])), created: str(entry["createdAt"]) || undefined }] : [];
  });
}

function fromTriage(dbPath: string): Candidate[] {
  return rows(dbPath, "SELECT scope, scope_value, category, pattern, reasoning, created_at FROM triage_memories").map(row => {
    const where = str(row["scope"]) === "global" ? "" : ` (${str(row["scope"])} ${str(row["scope_value"])})`;
    return { text: cleanText(`Treat as false positive${where}, ${str(row["category"])}: ${str(row["pattern"])}. Why: ${str(row["reasoning"])}`), kind: "avoid" as const, created: iso(row["created_at"]) };
  });
}

export function migrationReportPath(home?: string): string { return join(memoryDir(home), "import-report.json"); }

/** Runs once: when a report exists it returns it unchanged. Safe to call on every start. */
export function migrateOldMemory(store: NoteStore, options: MigrationOptions = {}): MigrationReport {
  const reportPath = migrationReportPath(options.home);
  if (existsSync(reportPath)) { try { return JSON.parse(readFileSync(reportPath, "utf8")) as MigrationReport; } catch { /* rewrite a damaged report */ } }
  const dbPath = options.dbPath ?? resolveOsecDbPath();
  const roots = new Map<string, string>();
  const seen = new Set<string>();
  const run = (candidates: Candidate[], reviewed = false): SourceReport => {
    const report: SourceReport = { found: candidates.length, imported: 0, duplicates: 0, skipped: 0 };
    for (const item of candidates) {
      const key = `${item.folder ?? ""}\0${item.text.toLowerCase()}`;
      const lower = item.text.toLowerCase();
      // A lesson mirrors a hunt note's summary (without its title): treat text contained in an imported note as a duplicate.
      if (!item.text || [...seen].some(k => (!item.folder || k.startsWith(`${item.folder}\0`)) && k.slice(k.indexOf("\0") + 1).includes(lower))) { item.text ? report.duplicates++ : report.skipped++; continue; }
      if (seen.has(key)) { report.duplicates++; continue; }
      seen.add(key);
      const before = store.list({ query: item.text }).some(note => note.text === item.text && note.folder === (item.folder ?? undefined));
      try { store.add({ text: item.text, scope: item.folder ? "folder" : "global", folder: item.folder, kind: item.kind, source: reviewed ? "user" : "import", created: item.created }); }
      catch { report.skipped++; continue; } // a secret-looking or empty note is not imported
      if (before) report.duplicates++; else report.imported++;
    }
    return report;
  };
  const hunt = run(fromHunt(options.home, roots));
  const lessons = run(fromLessons(dbPath, roots));
  const triage = run(fromTriage(dbPath), true);
  const craft = run(fromCraft([...(options.craftPaths ?? []), ...(process.env["CYBERGYM_MEMORY_DB"] ? [process.env["CYBERGYM_MEMORY_DB"]] : [])]));
  const sources = { hunt, craft, lessons, triage };
  const report: MigrationReport = { version: 1, importedAt: (options.now?.() ?? new Date()).toISOString(), sources, total: Object.values(sources).reduce((sum, s) => sum + s.imported, 0) };
  mkdirSync(memoryDir(options.home), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}
