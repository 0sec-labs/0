import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderCheckRegistry, GIVE_UP_MS, WORKER_SCRIPT, blockedAtThreadStart, childProcessProbe, type ProbeResult, type ProbeWorker } from "./workspace-folder-check.js";
import { handleWorkspaceHostRequest } from "./workspace-host-routes.js";
import { classifyFolderError } from "./workspace-access.js";

const HOME = "/Users/ada";
const DOCS = `${HOME}/Documents/app`;
const subject = { name: "Terminal", kind: "app" as const };

function fakeWorker() {
  const probes: Array<{ directory: string; resolve: (result: ProbeResult) => void; killed: boolean }> = [];
  const worker: ProbeWorker = (directory) => {
    let resolve!: (result: ProbeResult) => void;
    const done = new Promise<ProbeResult>((r) => { resolve = r; });
    const probe = { directory, resolve, killed: false };
    probes.push(probe);
    return { done, kill: () => { probe.killed = true; } };
  };
  return { worker, probes };
}
const make = (worker: ProbeWorker, extra: { canPrompt?: boolean } = {}) =>
  new FolderCheckRegistry({ worker, platform: "darwin", home: HOME, canPrompt: () => extra.canPrompt ?? true, subject: () => subject });

describe("folder check state machine", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("pending -> waiting for macOS -> allowed", async () => {
    const { worker, probes } = fakeWorker();
    const registry = make(worker);
    expect(registry.check(DOCS).state).toBe("checking");
    vi.advanceTimersByTime(1_100);
    const waiting = registry.check(DOCS);
    expect(waiting).toMatchObject({ state: "waiting", folder: "Documents", canPrompt: true });
    expect(waiting.message).toBe("Waiting for macOS: click Allow in the dialog that appeared (Documents).");
    expect(probes).toHaveLength(1); // polling joins the running probe
    probes[0]!.resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.check(DOCS)).toMatchObject({ state: "allowed" });
  });

  it("pending -> denied names the responsible app and offers Settings", async () => {
    const { worker, probes } = fakeWorker();
    const registry = make(worker);
    registry.check(DOCS);
    vi.advanceTimersByTime(2_000);
    probes[0]!.resolve({ ok: false, code: "EPERM" });
    await vi.advanceTimersByTimeAsync(0);
    const result = registry.check(DOCS);
    expect(result).toMatchObject({ state: "blocked", privacy: true, app: "Terminal" });
    expect(result.message).toContain("macOS is blocking access to Documents");
    expect(result.message).toContain("Terminal");
    // A finished refusal is reported as is until the owner retries.
    expect(registry.check(DOCS).state).toBe("blocked");
    expect(probes).toHaveLength(1);
    registry.check(DOCS, { retry: true });
    expect(probes).toHaveLength(2);
  });

  it("pending for 60 s -> timeout, kills the probe, retry starts again", async () => {
    const { worker, probes } = fakeWorker();
    const registry = make(worker);
    registry.check(DOCS);
    vi.advanceTimersByTime(GIVE_UP_MS - 1);
    expect(registry.check(DOCS).state).toBe("waiting");
    vi.advanceTimersByTime(2);
    const result = registry.check(DOCS);
    expect(result.state).toBe("timeout");
    expect(result.message).toMatch(/still waiting for your answer/);
    expect(probes[0]!.killed).toBe(true);
    expect(registry.check(DOCS, { retry: true }).state).toBe("checking");
    expect(probes).toHaveLength(2);
  });

  it("accepts an ordinary slow folder after the short timeout, with no macOS wording", async () => {
    const { worker, probes } = fakeWorker();
    const registry = make(worker);
    const path = `${HOME}/code/app`;
    expect(registry.check(path).state).toBe("checking");
    vi.advanceTimersByTime(2_500);
    expect(registry.check(path)).toMatchObject({ state: "checking", message: "Checking the folder…" });
    vi.advanceTimersByTime(600);
    expect(registry.check(path).state).toBe("allowed");
    expect(probes[0]!.killed).toBe(true);
  });

  it("an ordinary folder that is missing or unreadable is an error, not a privacy block", async () => {
    const { worker, probes } = fakeWorker();
    const registry = make(worker);
    registry.check(`${HOME}/code/a`); registry.check(`${HOME}/code/b`);
    probes[0]!.resolve({ ok: false, code: "ENOENT" }); probes[1]!.resolve({ ok: false, code: "EIO" });
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.check(`${HOME}/code/a`)).toMatchObject({ state: "error", message: expect.stringMatching(/doesn't exist/) });
    expect(registry.check(`${HOME}/code/b`)).toMatchObject({ state: "error", message: expect.stringMatching(/couldn't read/) });
  });

  it("says the Mac's screen is needed when the server cannot show a prompt", async () => {
    const { worker, probes } = fakeWorker();
    const registry = make(worker, { canPrompt: false });
    registry.check(DOCS);
    vi.advanceTimersByTime(1_500);
    const waiting = registry.check(DOCS);
    expect(waiting.canPrompt).toBe(false);
    expect(waiting.message).toMatch(/macOS can only ask on the Mac's screen.*Full Disk Access to Terminal/);
    probes[0]!.resolve({ ok: false, code: "EPERM" });
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.check(DOCS)).toMatchObject({ state: "blocked", privacy: true });
    expect(registry.check(DOCS).message).toMatch(/Mac's screen/);
  });

  it("settled resolves on the answer, or with the in-progress state after maxMs", async () => {
    const { worker, probes } = fakeWorker();
    const registry = make(worker);
    const early = registry.settled(DOCS, { maxMs: 3_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await early).state).toBe("waiting");
    const answered = registry.settled(DOCS);
    probes[0]!.resolve({ ok: true });
    expect((await answered).state).toBe("allowed");
  });

  it("cancel kills the probe and forgets it", async () => {
    const { worker, probes } = fakeWorker();
    const registry = make(worker);
    registry.check(DOCS);
    registry.cancel(DOCS);
    expect(probes[0]!.killed).toBe(true);
    registry.check(DOCS);
    expect(probes).toHaveLength(2);
  });

  it("words the first-thread refusal as 'macOS blocked access to <folder>'", async () => {
    const { worker, probes } = fakeWorker();
    const registry = make(worker);
    registry.check(DOCS);
    probes[0]!.resolve({ ok: false, code: "EPERM" });
    await vi.advanceTimersByTimeAsync(0);
    const text = blockedAtThreadStart(registry.check(DOCS));
    expect(text).toMatch(/^macOS blocked access to app\. Allow Terminal under System Settings/);
  });
});

describe("check-directory route", () => {
  const req = { socket: { remoteAddress: "127.0.0.1" }, headers: {} } as never;
  const res = { once: () => undefined, writableEnded: false } as never;
  it("returns the status shape, passes retry/local, and cancels", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "zero-check-")));
    try {
      const calls: unknown[] = [];
      const checks = {
        check: (path: string, options?: unknown) => { calls.push(["check", path, options]); return { state: "waiting", path, folder: "Documents", canPrompt: true, elapsedMs: 1500, message: "Waiting for macOS" } as const; },
        cancel: (path: string) => { calls.push(["cancel", path]); },
      };
      const reply = await handleWorkspaceHostRequest("project/check-directory", "POST", { path: dir, retry: true }, req, res, { checks });
      expect(reply).toEqual({ status: 200, data: { state: "waiting", path: dir, folder: "Documents", canPrompt: true, elapsedMs: 1500, message: "Waiting for macOS" } });
      expect(calls[0]).toEqual(["check", dir, { local: true, retry: true }]);
      await handleWorkspaceHostRequest("project/check-directory", "POST", { path: dir, cancel: true }, req, res, { checks });
      expect(calls[1]).toEqual(["cancel", dir]);
      expect((await handleWorkspaceHostRequest("project/check-directory", "POST", {}, req, res, { checks }))?.status).toBe(400);
      expect((await handleWorkspaceHostRequest("project/check-directory", "GET", {}, req, res, { checks }))?.status).toBe(405);
      const missing = await handleWorkspaceHostRequest("project/check-directory", "POST", { path: join(dir, "nope") }, req, res, { checks });
      expect(missing).toMatchObject({ status: 200, data: { state: "error" } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("real probe", () => {
  it("allows a readable folder through a child process", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "zero-probe-")));
    try { expect(await childProcessProbe(dir).done).toEqual({ ok: true }); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports a missing folder as ENOENT", async () => {
    expect(await childProcessProbe(join(tmpdir(), "zero-probe-missing-xyz")).done).toEqual({ ok: false, code: "ENOENT" });
  });

  // sandbox-exec makes the kernel answer EPERM exactly like TCC does for a protected folder, without any dialog.
  it.skipIf(process.platform !== "darwin" || Boolean(process.env.CI))("classifies a sandbox-denied fake protected root as a permission refusal", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zero-sbx-")));
    const protectedDir = join(root, "Documents");
    mkdirSync(protectedDir);
    try {
      const profile = `(version 1)(allow default)(deny file-read-data (subpath "${protectedDir}"))`;
      const output = execFileSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", WORKER_SCRIPT, protectedDir], { encoding: "utf8" });
      expect(output).toMatch(/^err:(EPERM|EACCES)$/);
      expect(classifyFolderError({ code: output.slice(4) })).toBe("permission");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
