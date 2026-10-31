import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ beforeOpen: undefined as (() => void) | undefined }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: (...args: Parameters<typeof fs.open>) => {
    const replace = race.beforeOpen;
    race.beforeOpen = undefined;
    replace?.();
    return fs.open(...args);
  } };
});

import { searchConversations } from "./conversation-store.js";
import { saveSession, sessionsDir } from "./tui/session-store.js";

const homes: string[] = [];
afterEach(() => {
  race.beforeOpen = undefined;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("search during atomic saves", () => {
  it.each([false, true])("reads the opened transcript when the previous file was oversized: %s", oversized => {
    const home = mkdtempSync(join(tmpdir(), "0-conversation-race-")); homes.push(home);
    const dir = sessionsDir(home); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "active.json"), oversized ? " ".repeat(8 * 1024 * 1024 + 1) : "{}");
    race.beforeOpen = () => {
      expect(saveSession({ id: "active", cwd: "/project", savedAt: 2, preview: "", messageCount: 1,
        messages: [{ role: "assistant", content: "Latest saved conversation after atomic replacement" }] }, home)).toBe(true);
    };
    return expect(searchConversations({ homeDir: home, query: "latest" })).resolves.toMatchObject({
      conversations: [{ session: { id: "active", savedAt: 2 } }], truncated: false,
    });
  });
});
