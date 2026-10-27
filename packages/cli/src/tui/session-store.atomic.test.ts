import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const failure = vi.hoisted(() => ({ stage: "" as "" | "write" | "rename" }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (failure.stage === "write") {
        fs.writeFileSync(args[0], '{"messages":[', args[2]);
        throw new Error("Simulated disk full after partial write");
      }
      return fs.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (failure.stage === "rename") throw new Error("Simulated replacement failure");
      return fs.renameSync(...args);
    },
  };
});

import { listSessions, loadSession, saveSession, sessionsDir, type StoredSession } from "./session-store.js";

const homes: string[] = [];
afterEach(() => {
  failure.stage = "";
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("atomic conversation persistence", () => {
  it.each(["write", "rename"] as const)("preserves the last resumable transcript after a failed %s", stage => {
    const home = mkdtempSync(join(tmpdir(), "0-session-atomic-"));
    homes.push(home);
    const session: StoredSession = { id: "conversation", savedAt: 1, cwd: "/project", preview: "Original", messageCount: 1,
      messages: [{ role: "user", content: "Original engagement evidence" }] };
    expect(saveSession(session, home)).toBe(true);
    failure.stage = stage;
    expect(saveSession({ ...session, savedAt: 2, messages: [...session.messages, { role: "assistant", content: "New answer" }] }, home)).toBe(false);
    expect(loadSession(session.id, home)).toEqual(session);
    expect(listSessions(home)).toHaveLength(1);
    expect(readdirSync(sessionsDir(home))).toEqual(["conversation.json"]);
    failure.stage = "";
    expect(saveSession({ ...session, savedAt: 3 }, home)).toBe(true);
    expect(loadSession(session.id, home)?.savedAt).toBe(3);
  });
});
