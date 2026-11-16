import { resolve } from "node:path";
import type { osecDB } from "../database.js";
import { resolveOsecDbPath } from "../database.js";
import { discoverRunDatabases, type DiscoveryOptions } from "./discovery.js";
import { mergeSnapshots, type MergeInput } from "./merge.js";
import { SqliteFindingsSource } from "./sqlite-source.js";
import type { FindingsSource, MergedFamily, ScanRow, SourceSnapshot } from "./types.js";

export interface FindingsServiceOptions extends DiscoveryOptions {
  /** The shared engine database (console, Agents, imports). Defaults to the usual location. */
  sharedDbPath?: string;
  /** Reuse a long-lived handle for the shared database instead of opening it per read. */
  openShared?: (mode: "read" | "write") => osecDB | Promise<osecDB>;
  /** False reads only the shared database (an explicit --db-path names one database). */
  includeRuns?: boolean;
  runFamilyLimit?: number;
  sharedFamilyLimit?: number;
}

export interface MergedFindings { families: MergedFamily[]; scans: ScanRow[]; skippedRuns: number }
const EMPTY: SourceSnapshot = { families: [], scans: [] };
const yieldToEventLoop = () => new Promise<void>(done => setImmediate(done));

/**
 * One Findings view over the shared database and every per-run scan database. Reads are merged by
 * fingerprint; writes go to each database that holds the finding. Run databases are read through a
 * cache keyed by file mtime and size, so a poll touches the file system but not SQLite unless a run changed.
 */
export class FindingsService {
  readonly #cache = new Map<string, { version: string; snapshot: SourceSnapshot }>();
  #inflight: Promise<{ inputs: MergeInput<FindingsSource>[]; skippedRuns: number }> | undefined;
  constructor(private readonly options: FindingsServiceOptions = {}) {}

  get sharedPath(): string { return resolve(resolveOsecDbPath(this.options.sharedDbPath)); }

  sources(): { sources: FindingsSource[]; skippedRuns: number } {
    const shared = this.sharedPath;
    const runs = this.options.includeRuns === false ? { paths: [], skipped: 0 } : discoverRunDatabases(this.options);
    const sources: FindingsSource[] = [new SqliteFindingsSource(shared, "shared", { familyLimit: this.options.sharedFamilyLimit ?? 5000, ...(this.options.openShared ? { open: this.options.openShared } : {}) })];
    for (const path of runs.paths) if (path !== shared) sources.push(new SqliteFindingsSource(path, "run", { familyLimit: this.options.runFamilyLimit ?? 1000 }));
    return { sources, skippedRuns: runs.skipped };
  }

  async #snapshots(): Promise<{ inputs: MergeInput<FindingsSource>[]; skippedRuns: number }> {
    this.#inflight ??= (async () => {
      const { sources, skippedRuns } = this.sources();
      const inputs: MergeInput<FindingsSource>[] = [];
      const live = new Set<string>();
      for (const source of sources) {
        const version = source.version();
        if (version === undefined) { inputs.push({ source, snapshot: EMPTY }); continue; }
        live.add(source.id);
        const cached = this.#cache.get(source.id);
        if (cached?.version === version) { inputs.push({ source, snapshot: cached.snapshot }); continue; }
        // A cold database is a synchronous SQLite read; let requests and timers run between them.
        await yieldToEventLoop();
        const snapshot = await source.read();
        this.#cache.set(source.id, { version, snapshot });
        inputs.push({ source, snapshot });
      }
      for (const id of this.#cache.keys()) if (!live.has(id)) this.#cache.delete(id);
      return { inputs, skippedRuns };
    })().finally(() => { this.#inflight = undefined; });
    return this.#inflight;
  }

  async list(limit = 5000): Promise<MergedFindings> {
    const { inputs, skippedRuns } = await this.#snapshots();
    return { ...mergeSnapshots(inputs, limit), skippedRuns };
  }

  /** Sources holding rows for this fingerprint, newest representative first. */
  async ownersOf(fingerprint: string): Promise<FindingsSource[]> {
    const { inputs } = await this.#snapshots();
    const held = inputs.filter(({ snapshot }) => snapshot.families.some(family => family.key === fingerprint));
    if (held.length) return held.map(({ source }) => source);
    // Beyond a database's family limit: ask each database directly.
    const found: FindingsSource[] = [];
    for (const { source } of inputs) {
      if (source.version() === undefined) continue;
      try { if (await source.withDatabase("read", db => db.getLatestFindingByFingerprint(fingerprint))) found.push(source); } catch { /* Unreadable. */ }
    }
    return found;
  }

  /** Read from every database that holds this finding family; results are in owner order. */
  async readFamily<T>(fingerprint: string, fn: (db: osecDB, source: FindingsSource) => T): Promise<T[]> {
    const out: T[] = [];
    for (const source of await this.ownersOf(fingerprint)) out.push(await source.withDatabase("read", db => fn(db, source)));
    return out;
  }

  /** Apply a change to every database holding the family and return how many were updated. */
  async writeFamily(fingerprint: string, fn: (db: osecDB) => void): Promise<number> {
    const owners = await this.ownersOf(fingerprint);
    for (const source of owners) { await source.withDatabase("write", fn); this.#cache.delete(source.id); }
    return owners.length;
  }

  /** The database that holds this finding id (or unambiguous prefix), or undefined. */
  async sourceOfFinding(id: string, options: { prefix?: boolean } = {}): Promise<FindingsSource | undefined> {
    const matches = (candidate: string) => candidate === id || (options.prefix === true && candidate.startsWith(id));
    const { inputs } = await this.#snapshots();
    const cached = inputs.find(({ snapshot }) => snapshot.families.some(family => matches(family.latest.id)));
    if (cached) return cached.source;
    for (const { source } of inputs) {
      if (source.version() === undefined) continue;
      try {
        const hit = await source.withDatabase("read", db => options.prefix ? db.listFindings({ limit: 5000 }).some(row => matches(row.id)) : Boolean(db.getFinding(id)));
        if (hit) return source;
      } catch { /* Unreadable. */ }
    }
    return undefined;
  }

  async sourceOfScan(scanId: string): Promise<FindingsSource | undefined> {
    const { inputs } = await this.#snapshots();
    return inputs.find(({ snapshot }) => snapshot.scans.some(scan => scan.id === scanId))?.source;
  }
}
