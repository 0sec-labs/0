import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { osecDB, resolveOsecDbPath } from "./database.js";
import { createShimmedDatabase } from "./wasm-shim.js";

const child = resolve(import.meta.dirname, "__fixtures__/writer-child.ts");
const pkgDir = resolve(import.meta.dirname, "../..");
const tsx = resolve(pkgDir, "node_modules/.bin/tsx");
const cleanEnv = (home: string) => ({ PATH: process.env["PATH"] ?? "", HOME: home });
const tmp = (name: string) => mkdtempSync(join(tmpdir(), name));

function run(args: string[], home: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise(done => {
    const p = spawn(tsx, [child, ...args], { env: cleanEnv(home), cwd: pkgDir });
    let out = "", err = "";
    p.stdout.on("data", d => { out += d; }); p.stderr.on("data", d => { err += d; });
    p.on("close", code => done({ code, out, err }));
  });
}

describe("storage robustness", () => {
  it("keeps every row when 4 processes write concurrently", async () => {
    const dir = tmp("0-conc-"); const path = join(dir, "c.db");
    try {
      new osecDB(path).close();
      const results = await Promise.all(["a", "b", "c", "d"].map(tag => run([path, tag, "3"], dir)));
      for (const r of results) expect(r, r.err).toMatchObject({ code: 0 });
      const db = new osecDB(path, { readOnly: true });
      expect(db.listScans(1000)).toHaveLength(12);
      expect(["a", "b", "c", "d"].flatMap(t => Array.from({ length: 3 }, (_, i) => db.getFinding(`${t}-f-${i}`)).filter(Boolean))).toHaveLength(12);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);

  it("waits for another process's short write lock instead of failing immediately", async () => {
    const dir = tmp("0-busy-"); const path = join(dir, "b.db");
    try {
      new osecDB(path).close();
      const holder = spawn(tsx, [resolve(import.meta.dirname, "__fixtures__/lock-holder-child.ts"), path, "700"], { env: cleanEnv(dir), cwd: pkgDir });
      await new Promise<void>((ok, bad) => { holder.stdout.on("data", d => String(d).includes("READY") && ok()); holder.on("close", () => bad(new Error("holder exited"))); });
      const db = new osecDB(path);
      try {
        expect(() => db.createScan({ target: "https://busy.example", depth: "default", format: "json" } as never, "busy")).not.toThrow();
      } finally { db.close(); }
      await new Promise(r => holder.on("close", r));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("reopens after SIGKILL of a writer and keeps committed rows", async () => {
    const dir = tmp("0-kill-"); const path = join(dir, "k.db");
    try {
      const p = spawn(tsx, [child, path, "k", "1000", "5"], { env: cleanEnv(dir), cwd: pkgDir, detached: true });
      await new Promise<void>((ok, bad) => { p.stdout.on("data", d => String(d).includes("READY") && ok()); p.on("close", () => bad(new Error("exited"))); });
      process.kill(-p.pid!, "SIGKILL");
      await new Promise(r => p.on("close", r));
      let db: osecDB | undefined;
      for (let i = 0; i < 50 && !db; i++) { try { db = new osecDB(path); } catch (e) { if (i === 49) throw e; await new Promise(r => setTimeout(r, 200)); } }
      expect(db!.listScans(100).length).toBeGreaterThanOrEqual(5);
      db!.createScan({ target: "https://after.example", depth: "default", format: "json" } as never);
      db!.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it("migrates a v0.28.5 and a legacy-shaped database cleanly and idempotently", () => {
    const sql = readFileSync(resolve(import.meta.dirname, "__fixtures__/schema-v0.28.5.sql"), "utf8");
    for (const legacy of [false, true]) {
      const dir = tmp("0-mig-"); const path = join(dir, "m.db");
      try {
        const raw = createShimmedDatabase(path);
        raw.exec(sql);
        raw.exec("INSERT INTO scans (id,target,depth,startedAt) VALUES ('s1','https://x.example','default','2024-01-01T00:00:00Z')");
        if (legacy) {
          raw.exec("DROP TABLE findings; CREATE TABLE findings (id TEXT PRIMARY KEY, scanId TEXT NOT NULL, templateId TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, severity TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'discovered', evidenceRequest TEXT NOT NULL, evidenceResponse TEXT NOT NULL, evidenceAnalysis TEXT, timestamp INTEGER NOT NULL DEFAULT 0)");
          raw.exec("INSERT INTO findings (id,scanId,templateId,title,description,severity,category,status,evidenceRequest,evidenceResponse,timestamp) VALUES ('f1','s1','t','Old','d','high','xss','verified','r','p',1)");
        }
        raw.close();
        for (let i = 0; i < 3; i++) {
          const db = new osecDB(path);
          if (legacy) expect(db.getFinding("f1")).toMatchObject({ title: "Old", fingerprint: "f1", triageStatus: "new", workflowStatus: "human_review" });
          expect(db.getScan("s1")).toBeTruthy();
          db.close();
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")("fails with a clear error and leaves a read-only database untouched", () => {
    const dir = tmp("0-ro-"); const path = join(dir, "r.db");
    try {
      new osecDB(path).close();
      const before = readFileSync(path);
      chmodSync(path, 0o444);
      let opened: osecDB | undefined;
      try { opened = new osecDB(path); opened.listScans(1); } catch (error) { expect(String(error)).toMatch(/\S/); }
      opened?.close();
      expect(readFileSync(path)).toEqual(before);
      expect(new osecDB(path, { readOnly: true }).listScans(1)).toEqual([]);
    } finally { chmodSync(path, 0o644); rmSync(dir, { recursive: true, force: true }); }
  });

  it("handles unicode and space-containing paths, and keeps Windows-style paths verbatim", () => {
    const dir = tmp("0-uni-"); const path = join(dir, "データ ベース 🦊", "é.db");
    try {
      const db = new osecDB(path); db.createScan({ target: "https://x.example", depth: "default", format: "json" } as never, "u"); db.close();
      expect(new osecDB(path, { readOnly: true }).getScan("u")).toBeTruthy();
      const prior = process.env["ZERO_DB_PATH"];
      try {
        process.env["ZERO_DB_PATH"] = "  C:\\Users\\me\\0.db  ";
        expect(resolveOsecDbPath()).toBe("C:\\Users\\me\\0.db");
        process.env["ZERO_DB_PATH"] = "   ";
        expect(resolveOsecDbPath()).not.toBe("   ");
      } finally { if (prior === undefined) delete process.env["ZERO_DB_PATH"]; else process.env["ZERO_DB_PATH"] = prior; }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
