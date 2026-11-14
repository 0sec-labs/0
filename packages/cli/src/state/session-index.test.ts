import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteSession,
  listSessions,
  listSessionsAsync,
  resetSessionIndex,
  saveSession,
  sessionIndexStats,
  sessionsDir,
  type StoredSession,
} from "./session-store.js";

const homes: string[] = [];
const home = () => { const dir = mkdtempSync(join(tmpdir(), "0-session-index-")); homes.push(dir); return dir; };

function session(id: string, savedAt: number, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id, savedAt, cwd: "/work/a", messageCount: 1, preview: `preview ${id}`,
    messages: [{ role: "user", content: [{ type: "text", text: `hello ${id}` }] }],
    ...overrides,
  };
}

/** Raw fixture write so the fixture itself never touches the cache epoch. */
function writeRaw(dir: string, s: StoredSession) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${s.id}.json`), JSON.stringify(s));
}

beforeEach(() => { resetSessionIndex(); sessionIndexStats.parsed = 0; sessionIndexStats.scans = 0; vi.useRealTimers(); });
afterEach(() => {
  vi.restoreAllMocks();
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("listSessionsAsync", () => {
  it("returns exactly what listSessions returns (shape, order, cwd, limit)", async () => {
    const h = home(); const dir = sessionsDir(h);
    for (let i = 0; i < 40; i += 1) writeRaw(dir, session(`console-${i}`, 1_000 + (i % 7), { cwd: i % 3 ? "/work/a" : "/work/b", archived: i % 5 === 0 }));
    writeFileSync(join(dir, "corrupt.json"), "{not json");
    writeFileSync(join(dir, "nomessages.json"), JSON.stringify({ savedAt: 1 }));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    expect(await listSessionsAsync(h)).toEqual(listSessions(h));
    resetSessionIndex();
    expect(await listSessionsAsync(h, { cwd: "/work/b" })).toEqual(listSessions(h, { cwd: "/work/b" }));
    resetSessionIndex();
    expect(await listSessionsAsync(h, { limit: 5 })).toEqual(listSessions(h, { limit: 5 }));
  });

  it("returns an empty list for a missing directory", async () => {
    expect(await listSessionsAsync(home())).toEqual([]);
  });

  it("does not re-read unchanged files on later calls", async () => {
    const h = home(); const dir = sessionsDir(h);
    for (let i = 0; i < 50; i += 1) writeRaw(dir, session(`console-${i}`, 1_000 + i));
    const readFile = vi.spyOn(fsp, "readFile");
    const first = await listSessionsAsync(h);
    expect(first).toHaveLength(50);
    expect(readFile).toHaveBeenCalledTimes(50);
    readFile.mockClear();
    // Different query key and past the TTL cache: forces a real directory rescan.
    const second = await listSessionsAsync(h, { limit: 10 });
    expect(second).toEqual(first.slice(0, 10));
    expect(readFile).not.toHaveBeenCalled();
    expect(sessionIndexStats.parsed).toBe(50);
    expect(sessionIndexStats.scans).toBe(2);
  });

  it("picks up edits, new files and deletions", async () => {
    const h = home(); const dir = sessionsDir(h);
    writeRaw(dir, session("console-a", 10)); writeRaw(dir, session("console-b", 20));
    expect((await listSessionsAsync(h)).map(r => r.id)).toEqual(["console-b", "console-a"]);

    // External edit: new content, new size. mtime nudged forward to be unambiguous.
    writeRaw(dir, session("console-a", 30, { preview: "edited preview text" }));
    utimesSync(join(dir, "console-a.json"), new Date(), new Date(Date.now() + 5_000));
    writeRaw(dir, session("console-c", 5));
    rmSync(join(dir, "console-b.json"));
    const readFile = vi.spyOn(fsp, "readFile");
    resetSessionIndexResultsOnly();
    const rows = await listSessionsAsync(h, { limit: 100 });
    expect(rows.map(r => [r.id, r.savedAt, r.preview])).toEqual([["console-a", 30, "edited preview text"], ["console-c", 5, "preview console-c"]]);
    expect(readFile).toHaveBeenCalledTimes(2); // only the edited and the new file
  });

  it("is invalidated immediately by in-process saves and deletes despite the TTL", async () => {
    const h = home();
    expect(saveSession(session("console-a", 10), h)).toBe(true);
    expect((await listSessionsAsync(h)).map(r => r.id)).toEqual(["console-a"]);
    expect(saveSession(session("console-b", 20), h)).toBe(true);
    expect((await listSessionsAsync(h)).map(r => r.id)).toEqual(["console-b", "console-a"]);
    expect(deleteSession("console-b", h)).toBe(true);
    expect((await listSessionsAsync(h)).map(r => r.id)).toEqual(["console-a"]);
  });

  it("coalesces concurrent identical calls into one scan", async () => {
    const h = home(); const dir = sessionsDir(h);
    for (let i = 0; i < 20; i += 1) writeRaw(dir, session(`console-${i}`, i));
    const results = await Promise.all([listSessionsAsync(h), listSessionsAsync(h), listSessionsAsync(h), listSessionsAsync(h)]);
    expect(sessionIndexStats.scans).toBe(1);
    expect(sessionIndexStats.parsed).toBe(20);
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it("does not let callers poison the cache by mutating results", async () => {
    const h = home(); writeRaw(sessionsDir(h), session("console-a", 10));
    const first = await listSessionsAsync(h);
    first[0]!.preview = "mutated";
    expect((await listSessionsAsync(h))[0]!.preview).toBe("preview console-a");
  });
});

/** Force the next call to rescan the directory while keeping the per-file index. */
function resetSessionIndexResultsOnly() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 5_000);
}
