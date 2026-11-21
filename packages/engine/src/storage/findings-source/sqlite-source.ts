import { statSync } from "node:fs";
import { osecDB } from "../database.js";
import type { FindingsSource, FindingsSourceKind, SourceSnapshot } from "./types.js";

export interface SqliteSourceOptions {
  /** Families kept per database; bounds memory for very large databases. */
  familyLimit?: number;
  /** Replace how the database is opened, e.g. to reuse a long-lived handle for the shared database. */
  open?: (mode: "read" | "write") => osecDB | Promise<osecDB>;
}

/** Adapter over one SQLite database file. Run databases are read through short-lived read-only handles. */
export class SqliteFindingsSource implements FindingsSource {
  readonly id: string;
  constructor(path: string, readonly kind: FindingsSourceKind, private readonly options: SqliteSourceOptions = {}) { this.id = path; }

  version(): string | undefined {
    try { const stat = statSync(this.id); return `${stat.mtimeMs}:${stat.size}`; } catch { return undefined; }
  }

  async withDatabase<T>(mode: "read" | "write", fn: (db: osecDB) => T | Promise<T>): Promise<T> {
    const db = this.options.open ? await this.options.open(mode) : new osecDB(this.id, mode === "read" ? { readOnly: true } : {});
    try { return await fn(db); } finally { db.close(); }
  }

  async read(): Promise<SourceSnapshot> {
    try {
      return await this.withDatabase("read", db => ({
        families: db.listFindingFamiliesBySeverity({ limit: this.options.familyLimit ?? 1000 }),
        scans: db.listScans(100),
      }));
    } catch {
      // An unreadable or half-written run database holds nothing we can show; the next change retries it.
      return { families: [], scans: [] };
    }
  }
}
