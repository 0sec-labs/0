import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { osecDB } from "./database.js";
import { createShimmedDatabase } from "./wasm-shim.js";

describe("ordinary database open preserves existing storage", () => {
  it.each([false, true])("rejects unsupported WAL without modifying header or sidecars (readOnly=%s)", readOnly => {
    const dir = mkdtempSync(join(tmpdir(), "0-wal-preserve-"));
    const path = join(dir, "test.db");
    try {
      const db = createShimmedDatabase(path);
      db.exec("CREATE TABLE retained (value TEXT)");
      db.close();
      const header = readFileSync(path);
      header[18] = header[19] = 2;
      writeFileSync(path, header);
      writeFileSync(`${path}-wal`, "committed WAL evidence");
      writeFileSync(`${path}-shm`, "shared memory evidence");
      const before = [path, `${path}-wal`, `${path}-shm`].map(file => readFileSync(file));
      expect(() => new osecDB(path, { readOnly })).toThrow(/native SQLite connection to checkpoint/);
      expect([path, `${path}-wal`, `${path}-shm`].map(file => readFileSync(file))).toEqual(before);
      expect(readdirSync(dir).sort()).toEqual(["test.db", "test.db-shm", "test.db-wal"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not remove an old lock held by a live transaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "0-live-lock-"));
    const path = join(dir, "test.db");
    const writer = createShimmedDatabase(path);
    try {
      writer.exec("CREATE TABLE retained (value TEXT); BEGIN IMMEDIATE; INSERT INTO retained VALUES ('pending')");
      const old = new Date(Date.now() - 60_000);
      utimesSync(`${path}.lock`, old, old);
      expect(() => new osecDB(path)).toThrow(/locked/);
      expect(existsSync(`${path}.lock`)).toBe(true);
      writer.exec("COMMIT");
      expect(writer.prepare("SELECT value FROM retained").all()).toEqual([{ value: "pending" }]);
    } finally { writer.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports malformed storage without backing it up and recreating an empty database", () => {
    const dir = mkdtempSync(join(tmpdir(), "0-malformed-preserve-"));
    const path = join(dir, "test.db");
    try {
      const bytes = Buffer.from("malformed but valuable operator evidence");
      writeFileSync(path, bytes);
      expect(() => new osecDB(path)).toThrow();
      expect(readFileSync(path)).toEqual(bytes);
      expect(readdirSync(dir)).toEqual(["test.db"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
