import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SentinelStore } from "@0/engine/storage";
import { loadSession, saveSession, type StoredSession } from "../state/session-store.js";
import { archiveIdleExceptAgentThreads, createMission, sendToMission } from "./workspace-services.js";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "zero-workspace-services-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const session = (id: string): StoredSession => ({
  id, savedAt: 1_000, model: "m", mode: "guided", cwd: "/work", messageCount: 1, preview: "hello",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
});

describe("Sentinel runner send adapter", () => {
  it("passes the queue mode and the automated mark through to the gateway", async () => {
    const send = vi.fn(async () => ({}));
    await sendToMission({ send } as never, "thread-1", "check deps", undefined, "queue", true);
    expect(send).toHaveBeenCalledWith("thread-1", { text: "check deps", mode: "queue" }, undefined, { automated: true });
  });
  it("sends a plain message when no mode is given", async () => {
    const send = vi.fn(async () => ({}));
    await sendToMission({ send } as never, "thread-1", "hi", { userId: "u", displayName: "U" });
    expect(send).toHaveBeenCalledWith("thread-1", { text: "hi" }, { userId: "u", displayName: "U" }, undefined);
  });
});

describe("Sentinel thread creation", () => {
  it("applies the Sentinel's folder with configure, because create does not accept it", async () => {
    const create = vi.fn(() => ({ id: "thread-1" }));
    const configure = vi.fn(async () => ({}));
    expect(createMission({ create, configure } as never, { title: "Sentinel: Watcher", workspacePath: "/work/app", skillAllowList: [] })).toEqual({ id: "thread-1" });
    expect(create).toHaveBeenCalledWith({ title: "Sentinel: Watcher", skillAllowList: [] });
    expect(configure).toHaveBeenCalledWith("thread-1", { workspacePath: "/work/app" });
    create.mockClear(); configure.mockClear();
    createMission({ create, configure } as never, { title: "No folder" });
    expect(configure).not.toHaveBeenCalled();
  });
});

describe("idle archive at boot", () => {
  it("archives idle threads but not the standing thread of a Sentinel", () => {
    const home = temp();
    const dbPath = join(home, "control.db");
    const store = new SentinelStore(dbPath);
    const agent = store.create({ name: "Watcher" });
    store.setHomeMission(agent.id, "console-home");
    store.close();
    saveSession(session("console-home"), home);
    saveSession(session("console-plain"), home);
    expect(archiveIdleExceptAgentThreads(1, dbPath, home)).toBe(1);
    expect(loadSession("console-plain", home)?.archived).toBe(true);
    expect(loadSession("console-home", home)?.archived).toBeUndefined();
  });
});
