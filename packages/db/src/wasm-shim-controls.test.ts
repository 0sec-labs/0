import { describe, expect, it, vi } from "vitest";
import { createShimmedDatabase, ShimmedDatabase } from "./wasm-shim.js";

function recordingEngine(exec = vi.fn<(sql: string) => void>()) {
  return {
    exec,
    prepare: () => { throw new Error("Unexpected prepare"); },
    close: () => {},
    inTransaction: false,
    isOpen: true,
  };
}

describe("SQLite shim transaction controls", () => {
  it.each([
    ["default", "BEGIN"],
    ["deferred", "BEGIN DEFERRED"],
    ["immediate", "BEGIN IMMEDIATE"],
    ["exclusive", "BEGIN EXCLUSIVE"],
  ] as const)("uses the requested %s mode and passes arguments/results", (mode, begin) => {
    const engine = recordingEngine();
    const db = new ShimmedDatabase(engine);
    const tx = db.transaction((value: number) => { engine.exec("WRITE"); return value * 2; });
    expect(tx[mode](3)).toBe(6);
    expect(engine.exec.mock.calls.map(([sql]) => sql)).toEqual([begin, "WRITE", "COMMIT"]);
  });

  it("rolls back callback failure and retains the original error if rollback also fails", () => {
    const failure = new Error("callback failed");
    const engine = recordingEngine(vi.fn(sql => { if (sql === "ROLLBACK") throw new Error("rollback failed"); }));
    const tx = new ShimmedDatabase(engine).transaction(() => { throw failure; });
    expect(() => tx.immediate()).toThrow(failure);
    expect(engine.exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("rolls back a failed commit but never rolls back after a failed BEGIN", () => {
    const failure = new Error("commit failed");
    const engine = recordingEngine(vi.fn(sql => { if (sql === "COMMIT") throw failure; }));
    const callback = vi.fn();
    const tx = new ShimmedDatabase(engine).transaction(callback);
    expect(() => tx.exclusive()).toThrow(failure);
    expect(engine.exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN EXCLUSIVE", "COMMIT", "ROLLBACK"]);
    engine.exec.mockClear();
    engine.exec.mockImplementation(() => { throw new Error("database locked"); });
    callback.mockClear();
    expect(() => tx.immediate()).toThrow("database locked");
    expect(engine.exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN IMMEDIATE"]);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("SQLite shim PRAGMA controls", () => {
  it("returns rows and simple scalar settings from the actual engine", () => {
    const db = createShimmedDatabase(":memory:");
    try {
      expect(db.pragma("foreign_keys = OFF")).toEqual([]);
      expect(db.pragma("foreign_keys")).toEqual([{ foreign_keys: 0 }]);
      db.pragma("foreign_keys = ON");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      db.pragma("busy_timeout = 123");
      expect(db.pragma("busy_timeout", { simple: true })).toBe(123);
      expect(() => db.pragma("foreign_keys = (")).toThrow();
      // Unknown pragma names are ignored by SQLite itself, not by the shim.
      expect(db.pragma("unknown_setting")).toEqual([]);
      expect(db.pragma("unknown_setting", { simple: true })).toBeUndefined();
    } finally { db.close(); }
  });
});
