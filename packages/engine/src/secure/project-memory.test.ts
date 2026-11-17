import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Finding } from "../shared/index.js";
import { createFileNoteStore } from "../notes/index.js";
import { recallRepairLearnings, recordRepairLearning } from "./project-memory.js";

describe("secure repair notes", () => {
  let home: string;
  let root: string;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "repair-memory-")));
    root = join(home, "repo");
    mkdirSync(root);
    vi.stubEnv("HOME", home);
    vi.stubEnv("ZERO_DB_PATH", join(home, "none.sqlite"));
    vi.stubEnv("ZERO_DISABLE_MEMORY", "0");
    vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "0");
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
  const finding = { title: "Tenant access", category: "idor" } as Finding;
  const repair = (status: "verified" | "failed") => ({ findingId: "f", status, attempts: 2, artifactDir: root, changedFiles: ["app.ts"], reason: "tests failed" }) as never;

  it("records a verified repair as a fix-decision and a failed one as something to avoid, and recalls both for the folder", () => {
    recordRepairLearning(root, "r1", finding, repair("verified"));
    recordRepairLearning(root, "r2", finding, repair("failed"));
    const notes = createFileNoteStore({ home }).list({ folder: root });
    expect(notes.map(note => note.kind).sort()).toEqual(["avoid", "fix-decision"]);
    expect(notes.every(note => note.source === "model")).toBe(true);
    const recalled = recallRepairLearnings(root);
    expect(recalled).toHaveLength(2);
    expect(recalled[0]).toContain("[prior note, untrusted]");
  });

  it("does not recall another folder's notes", () => {
    recordRepairLearning(root, "r1", finding, repair("verified"));
    expect(recallRepairLearnings(join(home, "other"))).toEqual([]);
  });

  it.each(["1", "true", "TRUE"])("respects the %s opt-out for reading and writing", disabled => {
    vi.stubEnv("ZERO_DISABLE_MEMORY", disabled);
    recordRepairLearning(root, "r", finding, repair("verified"));
    expect(createFileNoteStore({ home }).list()).toEqual([]);
    vi.stubEnv("ZERO_DISABLE_MEMORY", "0");
    recordRepairLearning(root, "r", finding, repair("verified"));
    vi.stubEnv("ZERO_DISABLE_MEMORY", disabled);
    expect(recallRepairLearnings(root)).toEqual([]);
  });
});
