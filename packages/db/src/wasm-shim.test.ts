import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { createShimmedDatabase, isBunRuntime } from "./wasm-shim.js";

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
describe.skipIf(process.platform === "win32")("disk database creation permissions", () => {
  for (const runtime of ["node", "bun"] as const) {
    it.skipIf(runtime === "bun" && !bunAvailable)(`${runtime} creates private databases without changing existing files`, () => {
      const root = mkdtempSync(join(tmpdir(), "0-shim-private-"));
      chmodSync(root, 0o755);
      try {
        const modulePath = join(root, "shim.mjs");
        writeFileSync(modulePath, transpileModule(readFileSync(new URL("./wasm-shim.ts", import.meta.url), "utf8"), {
          compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2024 },
        }).outputText);
        symlinkSync(new URL("../node_modules", import.meta.url), join(root, "node_modules"));
        const script = `
          import { createShimmedDatabase } from ${JSON.stringify(pathToFileURL(modulePath).href)};
          import { chmodSync, readFileSync, readdirSync, statSync } from 'node:fs';
          import { join } from 'node:path';
          process.umask(0o022);
          const root = ${JSON.stringify(root)};
          const path = join(root, 'private.db');
          const fresh = createShimmedDatabase(path);
          const modeAtOpen = statSync(path).mode & 0o777;
          fresh.exec('CREATE TABLE evidence(id INTEGER PRIMARY KEY); INSERT INTO evidence VALUES(1)');
          fresh.close();
          chmodSync(path, 0o644);
          const existing = createShimmedDatabase(path);
          const count = existing.prepare('SELECT COUNT(*) AS count FROM evidence').get();
          existing.close();
          const existingMode = statSync(path).mode & 0o777;
          chmodSync(path, 0o444);
          const beforeReadonly = readFileSync(path);
          // WASM requests a read/write handle and can reject read-only files;
          // the permission policy must neither chmod nor truncate them.
          let readonly;
          try { readonly = createShimmedDatabase(path); readonly.prepare('SELECT COUNT(*) AS count FROM evidence').get(); }
          catch { /* Retain each engine's existing read-only behavior. */ }
          finally { readonly?.close(); }
          const readonlyMode = statSync(path).mode & 0o777;
          const readonlyUnchanged = beforeReadonly.equals(readFileSync(path));
          const beforeSpecial = readdirSync(root).sort();
          for (const special of [':memory:', '']) {
            const memory = createShimmedDatabase(special);
            memory.exec('CREATE TABLE ephemeral(id INTEGER)');
            memory.close();
          }
          console.log(JSON.stringify({ modeAtOpen, existingMode, readonlyMode, readonlyUnchanged, count, beforeSpecial, afterSpecial: readdirSync(root).sort() }));
        `;
        const child = spawnSync(runtime === "node" ? process.execPath : "bun", ["--input-type=module", "--eval", script], { encoding: "utf8", cwd: root });
        expect(child.status, child.stderr).toBe(0);
        const result = JSON.parse(child.stdout);
        expect(result).toMatchObject({ modeAtOpen: 0o600, existingMode: 0o644, readonlyMode: 0o444, readonlyUnchanged: true, count: { count: 1 } });
        expect(result.afterSpecial).toEqual(result.beforeSpecial);
        expect(statSync(root).mode & 0o777).toBe(0o755);
        expect(readdirSync(root)).not.toContain(":memory:");
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});

/**
 * These tests exercise the WASM (node-sqlite3-wasm) branch of the shim — the
 * one that runs under plain Node. The Bun branch of `createShimmedDatabase`
 * is exercised end-to-end by the bun-compiled binary (see scripts/bun-compile.sh).
 *
 * The runtime-detection branch test verifies that `isBunRuntime()` returns
 * the expected boolean for the current process AND that toggling the global
 * `Bun` symbol flips the result — proving the gate that picks bun:sqlite vs
 * node-sqlite3-wasm actually keys off runtime state.
 */
describe("isBunRuntime()", () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).Bun;
  });

  it("returns false under plain Node (no Bun global, no process.versions.bun)", () => {
    // Sanity-check the test's own assumption: vitest under Node should
    // not have a `Bun` global. If a future migration runs vitest under
    // Bun, this assertion will alert us to flip the test polarity.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).Bun).toBeUndefined();
    expect(process.versions.bun).toBeUndefined();
    expect(isBunRuntime()).toBe(false);
  });

  it("returns true when a Bun global is present", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Bun = { version: "test-stub" };
    expect(isBunRuntime()).toBe(true);
  });
});

describe("ShimmedDatabase (WASM engine, in-memory)", () => {
  it("round-trips inserts, named bindings, and transaction rollback", () => {
    // ":memory:" keeps the test hermetic — no disk artifacts to clean up.
    const db = createShimmedDatabase(":memory:");
    try {
      db.exec(`
        CREATE TABLE kv (
          k TEXT PRIMARY KEY,
          v INTEGER NOT NULL
        )
      `);

      // Positional varargs: stmt.run(a, b)
      const insert = db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)");
      const r1 = insert.run("a", 1);
      expect(r1.changes).toBe(1);

      // Named binding via plain-key object — the shim auto-prefixes `@`.
      const insertNamed = db.prepare("INSERT INTO kv (k, v) VALUES (@k, @v)");
      insertNamed.run({ k: "b", v: 2 });

      // .all() returns row objects.
      const rows = db.prepare("SELECT k, v FROM kv ORDER BY k").all() as Array<{
        k: string;
        v: number;
      }>;
      expect(rows).toEqual([
        { k: "a", v: 1 },
        { k: "b", v: 2 },
      ]);

      // .raw().all() returns ordered value arrays — drizzle uses this.
      const rawRows = (db.prepare("SELECT k, v FROM kv ORDER BY k").raw() as
        ReturnType<typeof db.prepare>).all();
      expect(rawRows).toEqual([
        ["a", 1],
        ["b", 2],
      ]);

      // .get() with no match → undefined (not null).
      const missing = db.prepare("SELECT v FROM kv WHERE k = ?").get("zzz");
      expect(missing).toBeUndefined();

      // .transaction() commits on success.
      const tx = db.transaction((k: string, v: number) => {
        db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run(k, v);
      });
      tx("c", 3);
      const after = db.prepare("SELECT count(*) as n FROM kv").get() as {
        n: number;
      };
      expect(after.n).toBe(3);

      // .transaction() rolls back on throw.
      const failing = db.transaction(() => {
        db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("d", 4);
        throw new Error("boom");
      });
      expect(() => failing()).toThrow(/boom/);
      const afterRollback = db.prepare("SELECT count(*) as n FROM kv").get() as {
        n: number;
      };
      expect(afterRollback.n).toBe(3);
    } finally {
      db.close();
    }
  });

  it("pragma() swallows engine-specific errors silently", () => {
    const db = createShimmedDatabase(":memory:");
    try {
      // foreign_keys = ON is universally supported.
      expect(() => db.pragma("foreign_keys = ON")).not.toThrow();
      // A nonsense pragma should not propagate even if the engine errors.
      expect(() => db.pragma("definitely_not_a_real_pragma = 1")).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("Node WASM statement lifetime across file connections", () => {
  it("releases get cursors, preserves reusable statements and closes unused prepared statements", () => {
    const root = mkdtempSync(join(tmpdir(), "0-shim-cursors-"));
    const path = join(root, "shared.db");
    const first = createShimmedDatabase(path);
    let second: ReturnType<typeof createShimmedDatabase> | undefined;
    try {
      first.exec("CREATE TABLE kv (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO kv VALUES(1,'first')");
      const read = first.prepare("SELECT id,value FROM kv ORDER BY id");
      expect(read.get()).toEqual({ id: 1, value: "first" });
      expect(existsSync(`${path}.lock`)).toBe(false);
      second = createShimmedDatabase(path);
      second.prepare("INSERT INTO kv VALUES(?,?)").run(2, "second");
      expect(read.all()).toEqual([{ id: 1, value: "first" }, { id: 2, value: "second" }]);
      expect(read.raw().get()).toEqual([1, "first"]);
      expect(read.raw().all()).toEqual([[1, "first"], [2, "second"]]);
      expect(read.get()).toEqual({ id: 1, value: "first" });
      first.prepare("SELECT * FROM kv"); // Prepared but never executed: close must still finalize it.
      first.close();
      expect(existsSync(`${path}.lock`)).toBe(false);
      second.prepare("INSERT INTO kv VALUES(?,?)").run(3, "third");
      expect(() => read.get()).toThrow("closed");
    } finally { if (first.open) first.close(); second?.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("releases exceptional executions and RETURNING reads without weakening explicit transactions", () => {
    const root = mkdtempSync(join(tmpdir(), "0-shim-errors-"));
    const path = join(root, "shared.db");
    const first = createShimmedDatabase(path);
    const second = createShimmedDatabase(path);
    try {
      first.exec("CREATE TABLE kv (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO kv VALUES(1,'first')");
      const insert = first.prepare("INSERT INTO kv VALUES(?,?)");
      expect(() => insert.run(1, "duplicate")).toThrow();
      expect(existsSync(`${path}.lock`)).toBe(false);
      second.prepare("INSERT INTO kv VALUES(?,?)").run(2, "second");
      insert.run(3, "third");
      expect(first.prepare("INSERT INTO kv VALUES(4,'fourth'),(5,'fifth') RETURNING id").get()).toEqual({ id: 4 });
      expect(second.prepare("SELECT COUNT(*) AS count FROM kv").get()).toEqual({ count: 5 });
      first.transaction(() => {
        expect(first.prepare("SELECT COUNT(*) AS count FROM kv").get()).toEqual({ count: 5 });
        expect(() => second.prepare("INSERT INTO kv VALUES(6,'blocked')").run()).toThrow("locked");
      })();
      expect(existsSync(`${path}.lock`)).toBe(false);
      second.prepare("INSERT INTO kv VALUES(6,'unblocked')").run();
    } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
