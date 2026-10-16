import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureDatabaseDirectory } from "./db-directory.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, existsSync: vi.fn(fs.existsSync), mkdirSync: vi.fn(fs.mkdirSync) };
});
afterEach(() => vi.clearAllMocks());

it("opens relative database paths without trying to recreate the current directory", () => {
  ensureDatabaseDirectory("dashboard.db");
  expect(mkdirSync).not.toHaveBeenCalled();
});
it("does not touch the filesystem for an in-memory database", () => {
  ensureDatabaseDirectory(":memory:");
  expect(existsSync).not.toHaveBeenCalled();
  expect(mkdirSync).not.toHaveBeenCalled();
});
it("creates missing nested parents for new databases", () => {
  const root = mkdtempSync(join(tmpdir(), "0-db-directory-"));
  try {
    const parent = join(root, "nested", "state");
    ensureDatabaseDirectory(join(parent, "dashboard.db"));
    expect(existsSync(parent)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
