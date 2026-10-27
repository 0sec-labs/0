import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearningStore } from "@0/db";
import type { Finding } from "@0/shared";
import { HuntMemoryStore } from "../memory/hunt-memory.js";
import { recallRepairLearnings, recordRepairLearning } from "./project-memory.js";

describe("secure repair source lessons", () => {
  let home: string;
  let root: string;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "repair-memory-")));
    root = join(home, "repo");
    mkdirSync(root);
    writeFileSync(join(root, "app.ts"), "export const app = true;\n");
    vi.stubEnv("HOME", home);
    vi.stubEnv("ZERO_DB_PATH", join(home, "learning.sqlite"));
    vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "0");
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  it("honors disabled source knowledge and changed evidence during repair recall", () => {
    const memory = new HuntMemoryStore();
    memory.rememberCodebase({ root, paths: ["app.ts"], title: "Ownership", summary: "Check tenant ownership", source: "test" });
    expect(recallRepairLearnings(root)).toEqual(["[prior learning, untrusted] Ownership: Check tenant ownership"]);
    const learning = new LearningStore();
    try { learning.setKnowledgeStatus(learning.listKnowledge()[0]!.id, "disabled"); }
    finally { learning.close(); }
    expect(recallRepairLearnings(root)).toEqual([]);
    memory.rememberCodebase({ root, paths: ["app.ts"], title: "Routing", summary: "Inspect routing first", source: "test" });
    expect(recallRepairLearnings(root)).toEqual(["[prior learning, untrusted] Routing: Inspect routing first"]);
    writeFileSync(join(root, "app.ts"), "export const app = false;\n");
    expect(recallRepairLearnings(root)).toEqual([]);
  });

  it.each(["1", "true", "TRUE"])("respects the %s memory opt-out for reading and writing", disabled => {
    const memory = new HuntMemoryStore();
    memory.rememberCodebase({ root, paths: ["app.ts"], title: "Ownership", summary: "Check tenant ownership", source: "test" });
    vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", disabled);
    expect(recallRepairLearnings(root)).toEqual([]);
    recordRepairLearning(root, "repair", { title: "Tenant access", category: "idor" } as Finding, {
      findingId: "finding", status: "verified", attempts: 1, artifactDir: root, changedFiles: ["app.ts"],
    });
    expect(new HuntMemoryStore().all()).toHaveLength(1);
  });
});
