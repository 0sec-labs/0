import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOsecDatabase } from "./database-lifecycle.js";

const alive = () => undefined;
const esrch = () => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); };
const eperm = () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); };

describe("resetOsecDatabase", () => {
  let dir: string;
  let db: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "0-reset-")); db = join(dir, "0.db"); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const age = (p: string, ms: number) => { const t = new Date(Date.now() - ms); utimesSync(p, t, t); };

  it("removes the database and sidecars, including a stale lock directory", () => {
    for (const s of ["", "-wal", "-shm", "-journal"]) writeFileSync(db + s, "x");
    mkdirSync(`${db}.lock`);
    writeFileSync(join(`${db}.lock`, "pid"), "424242");
    expect(resetOsecDatabase(db, { probe: esrch })).toBe(db);
    for (const s of ["", "-wal", "-shm", "-journal", ".lock"]) expect(existsSync(db + s)).toBe(false);
  });

  it("refuses to delete anything when a live process (kill ok) holds the lock", () => {
    writeFileSync(db, "x"); writeFileSync(`${db}-journal`, "j");
    mkdirSync(`${db}.lock`); writeFileSync(join(`${db}.lock`, "pid"), "123");
    expect(() => resetOsecDatabase(db, { probe: alive })).toThrow(/process 123 holds/);
    expect(existsSync(db)).toBe(true);
    expect(existsSync(`${db}-journal`)).toBe(true);
    expect(existsSync(`${db}.lock`)).toBe(true);
  });

  it("treats EPERM as alive and ESRCH as dead", () => {
    writeFileSync(db, "x"); writeFileSync(`${db}.lock`, "321\n");
    expect(() => resetOsecDatabase(db, { probe: eperm })).toThrow(/holds/);
    expect(existsSync(db)).toBe(true);
    resetOsecDatabase(db, { probe: esrch });
    expect(existsSync(db)).toBe(false);
    expect(existsSync(`${db}.lock`)).toBe(false);
  });

  it("without owner evidence, keeps a recent lock and removes an old one", () => {
    writeFileSync(db, "x"); writeFileSync(`${db}-journal`, "j"); mkdirSync(`${db}.lock`);
    expect(() => resetOsecDatabase(db)).toThrow(/modified recently/);
    expect(existsSync(`${db}-journal`)).toBe(true);
    age(`${db}.lock`, 10 * 60_000);
    resetOsecDatabase(db);
    expect(existsSync(`${db}.lock`)).toBe(false);
    expect(existsSync(`${db}-journal`)).toBe(false);
  });

  it("removes -journal only when no lock holder exists (no lock: removed)", () => {
    writeFileSync(db, "x"); writeFileSync(`${db}-journal`, "j");
    resetOsecDatabase(db);
    expect(existsSync(`${db}-journal`)).toBe(false);
  });

  it("refuses a directory database path and keeps its contents", () => {
    mkdirSync(db); writeFileSync(join(db, "precious.txt"), "keep");
    expect(() => resetOsecDatabase(db)).toThrow(/not a regular file/);
    expect(readFileSync(join(db, "precious.txt"), "utf8")).toBe("keep");
  });

  it("does not follow symlinks: removes the link, keeps the target", () => {
    const target = join(dir, "target"); mkdirSync(target); writeFileSync(join(target, "f"), "keep");
    const outside = join(dir, "outside.db"); writeFileSync(outside, "keep");
    symlinkSync(outside, db);
    symlinkSync(target, `${db}.lock`);
    resetOsecDatabase(db, { probe: esrch });
    expect(existsSync(db)).toBe(false);
    expect(existsSync(`${db}.lock`)).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("keep");
    expect(readFileSync(join(target, "f"), "utf8")).toBe("keep");
  });

  it("does not recurse into a directory named like a sidecar other than .lock", () => {
    writeFileSync(db, "x"); mkdirSync(`${db}-wal`); writeFileSync(join(`${db}-wal`, "f"), "keep");
    expect(() => resetOsecDatabase(db)).toThrow();
    expect(existsSync(join(`${db}-wal`, "f"))).toBe(true);
  });
});
