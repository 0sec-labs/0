import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeSharedDbs, evictSharedDb, openSharedDb } from "./shared-db.js";
import { readThrough, invalidateReadCache } from "./read-cache.js";

const dirs: string[] = [];
afterEach(() => { closeSharedDbs(); invalidateReadCache(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const dbFile = () => { const dir = mkdtempSync(join(tmpdir(), "0-shared-db-")); dirs.push(dir); return join(dir, "t.db"); };

describe("openSharedDb", () => {
  it("opens once per path and ignores close()", async () => {
    const path = dbFile();
    const a = await openSharedDb(path);
    const b = await openSharedDb(path);
    expect(b).toBe(a);
    a.close();
    expect(Array.isArray(b.listScans(10))).toBe(true); // still usable after close()
  });

  it("reopens after eviction and after the file is replaced", async () => {
    const path = dbFile();
    const a = await openSharedDb(path);
    await evictSharedDb(path);
    const b = await openSharedDb(path);
    expect(b).not.toBe(a);
    rmSync(path);
    const c = await openSharedDb(path);
    expect(c).not.toBe(b);
    expect(Array.isArray(c.listScans(10))).toBe(true);
  });

  it("creates the timestamp index used by recent-event queries", async () => {
    const path = dbFile();
    const db = await openSharedDb(path);
    const plan = (db as unknown as { sqlite: { prepare(sql: string): { all(): Array<Record<string, unknown>> } } }).sqlite
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM pipeline_events ORDER BY timestamp DESC LIMIT 250").all();
    expect(JSON.stringify(plan)).toContain("idx_events_timestamp");
    expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE");
  });
});

describe("readThrough", () => {
  it("coalesces concurrent calls, caches briefly, and invalidates on demand", async () => {
    let runs = 0;
    const compute = async () => { runs += 1; await new Promise(r => setTimeout(r, 10)); return runs; };
    const [a, b] = await Promise.all([readThrough("k", compute), readThrough("k", compute)]);
    expect([a, b, runs]).toEqual([1, 1, 1]);
    expect(await readThrough("k", compute)).toBe(1);
    invalidateReadCache();
    expect(await readThrough("k", compute)).toBe(2);
  });

  it("does not cache failures", async () => {
    let runs = 0;
    const flaky = async () => { runs += 1; if (runs === 1) throw new Error("boom"); return "ok"; };
    await expect(readThrough("f", flaky)).rejects.toThrow("boom");
    expect(await readThrough("f", flaky)).toBe("ok");
  });
});
