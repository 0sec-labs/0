import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateError, UpdateManager, isSupervised, type UpdateManagerOptions } from "./update-manager.js";
import type { AutoUpdateResult, UpdatePolicy } from "../utils/update-check.js";

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "update-manager-"));
  previousHome = process.env["HOME"];
  process.env["HOME"] = home;
  mkdirSync(join(home, ".0"), { recursive: true });
});
afterEach(() => { process.env["HOME"] = previousHome; rmSync(home, { recursive: true, force: true }); vi.useRealTimers(); });

const managed = { kind: "binary" as const, managed: true, dir: "/opt/0/bin" };
const ok: AutoUpdateResult = { success: true, installed: true, installedVersion: "v0.6.0" };
function seedCache(latest: string, ageMs = 0) {
  writeFileSync(join(home, ".0", "last-update-check"), JSON.stringify({ lastCheckedAt: new Date(Date.now() - ageMs).toISOString(), latestVersion: latest }));
}
function make(overrides: Omit<Partial<UpdateManagerOptions>, "policy"> & { threads?: number; policy?: UpdatePolicy } = {}) {
  const calls = { install: [] as Array<{ version?: string; installDir?: string; quiet?: boolean } | undefined>, restart: [] as Array<{ version: string; supervised: boolean }> };
  const { threads, policy, ...rest } = overrides;
  const state = { threads: threads ?? 0, policy: policy ?? "automatic" };
  const manager = new UpdateManager({
    current: "0.5.0", serverMode: false, install: managed, supervised: false, env: {}, restartDelayMs: 0,
    threadCount: () => state.threads, policy: () => state.policy,
    restart: info => { calls.restart.push(info); },
    installer: async options => { calls.install.push(options); return ok; },
    fetchLatest: async () => "v0.6.0",
    ...rest,
  });
  return { manager, calls, state };
}

describe("apply", () => {
  it("installs into the folder of the running binary, then restarts once", async () => {
    seedCache("v0.6.0");
    const { manager, calls } = make();
    await expect(manager.apply()).resolves.toEqual({ restarting: true, version: "0.6.0", supervised: false });
    await vi.waitFor(() => expect(calls.restart).toEqual([{ version: "0.6.0", supervised: false }]));
    expect(calls.install).toEqual([{ version: "v0.6.0", installDir: "/opt/0/bin", quiet: true }]);
    expect(manager.status()).toMatchObject({ phase: "restarting" });
  });

  it("is single-flight: a second request while one is installing is refused and nothing installs twice", async () => {
    seedCache("v0.6.0");
    let release!: (result: AutoUpdateResult) => void;
    const gate = new Promise<AutoUpdateResult>(resolve => { release = resolve; });
    const { manager, calls } = make({ installer: async options => { calls.install.push(options); return gate; } });
    const first = manager.apply();
    await expect(manager.apply()).rejects.toMatchObject({ status: 409, code: "update_in_progress" });
    release(ok);
    await first;
    await expect(manager.apply()).rejects.toMatchObject({ code: "update_in_progress" });
    expect(calls.install).toHaveLength(1);
  });

  it("refuses while threads run unless confirmed, and says how many", async () => {
    seedCache("v0.6.0");
    const { manager, calls } = make({ threads: 2 });
    const refusal = await manager.apply().catch(error => error as UpdateError);
    expect(refusal).toMatchObject({ status: 409, code: "threads_running", extra: { threads: 2 } });
    expect((refusal as UpdateError).message).toBe("2 threads are running. Update after they finish, or update anyway.");
    expect(calls.install).toHaveLength(0);
    await expect(manager.apply({ confirm: true })).resolves.toMatchObject({ restarting: true });
  });

  it("never applies to installs that are not managed binaries", async () => {
    seedCache("v0.6.0");
    for (const install of [
      { kind: "docker" as const, managed: false, instruction: "docker pull ghcr.io/0sec-labs/0security:latest" },
      { kind: "source" as const, managed: false, instruction: "git pull" },
      { kind: "npm" as const, managed: false, instruction: "migrate" },
      { kind: "binary" as const, managed: false, instruction: "0 doctor upgrade" },
    ]) {
      const { manager, calls } = make({ install });
      await expect(manager.apply({ confirm: true })).rejects.toMatchObject({ status: 409, code: "not_managed" });
      expect(calls.install).toHaveLength(0);
    }
  });

  it("reports an install failure, keeps the old program running and allows a retry", async () => {
    seedCache("v0.6.0");
    let fail = true;
    const { manager, calls } = make({ installer: async () => fail ? { success: false, installed: false, error: "checksum mismatch" } : ok });
    await expect(manager.apply()).rejects.toMatchObject({ status: 502, code: "install_failed", message: "checksum mismatch" });
    expect(calls.restart).toHaveLength(0);
    expect(manager.status()).toMatchObject({ phase: "idle", error: "checksum mismatch" });
    fail = false;
    await expect(manager.apply()).resolves.toMatchObject({ restarting: true });
  });

  it("refuses when already current, and when updates are disabled by the environment", async () => {
    seedCache("v0.5.0");
    await expect(make().manager.apply()).rejects.toMatchObject({ code: "up_to_date" });
    seedCache("v0.6.0");
    await expect(make({ env: { ZERO_OFFLINE: "1" } }).manager.apply()).rejects.toMatchObject({ code: "updates_disabled" });
  });

  it("tells the host the process is supervised so it exits instead of starting itself again", async () => {
    seedCache("v0.6.0");
    const { manager } = make({ supervised: true });
    await expect(manager.apply()).resolves.toMatchObject({ supervised: true });
  });
});

describe("background", () => {
  it("installs in the background when idle under the automatic policy, then waits for a restart", async () => {
    seedCache("v0.5.0", 7 * 3600_000);
    const { manager, calls } = make({ serverMode: true });
    await manager.tick();
    expect(calls.install).toHaveLength(1);
    expect(manager.status()).toMatchObject({ phase: "staged", latest: "0.6.0", available: true });
    expect(calls.restart).toHaveLength(0);
    // Staged: the one-click restart does not download again.
    await manager.apply();
    expect(calls.install).toHaveLength(1);
  });

  it("only checks, never installs, under notify; and does nothing when off", async () => {
    seedCache("v0.5.0", 7 * 3600_000);
    const notify = make({ policy: "notify" });
    await notify.manager.tick();
    expect(notify.calls.install).toHaveLength(0);
    expect(notify.manager.status()).toMatchObject({ phase: "idle", available: true, latest: "0.6.0" });
    const off = make({ policy: "off", fetchLatest: async () => { throw new Error("must not fetch"); } });
    await off.manager.tick();
    expect(off.calls.install).toHaveLength(0);
  });

  it("does not install while a thread is running, and stays quiet when offline", async () => {
    seedCache("v0.6.0");
    const busy = make({ threads: 1 });
    await busy.manager.tick();
    expect(busy.calls.install).toHaveLength(0);
    seedCache("v0.5.0", 7 * 3600_000);
    const offline = make({ fetchLatest: async () => null });
    await expect(offline.manager.tick()).resolves.toBeUndefined();
    expect(offline.calls.install).toHaveLength(0);
  });

  it("reuses a recent check instead of asking the network again", async () => {
    seedCache("v0.5.0", 60_000);
    const fetchLatest = vi.fn(async () => "v0.6.0");
    await make({ fetchLatest }).manager.tick();
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it("does not retry the same failed release within the retry window", async () => {
    seedCache("v0.6.0");
    const installer = vi.fn(async () => ({ success: false, installed: false, error: "offline" }) as AutoUpdateResult);
    const { manager } = make({ installer });
    await manager.tick();
    await manager.tick();
    expect(installer).toHaveBeenCalledTimes(1);
  });

  it("restarts by itself after ten idle minutes (automatic, not server mode, not supervised)", async () => {
    seedCache("v0.6.0");
    let now = 1_000_000;
    const { manager, calls, state } = make({ now: () => now, watchIntervalMs: 5, idleRestartMs: 600_000 });
    manager.start();
    await manager.tick();
    expect(calls.restart).toHaveLength(0);
    state.threads = 1; now += 599_000;
    await new Promise(resolve => setTimeout(resolve, 30));
    state.threads = 0; now += 599_000;           // idle again, but only just
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls.restart).toHaveLength(0);
    now += 2_000;                                  // ten idle minutes
    await vi.waitFor(() => expect(calls.restart).toHaveLength(1));
    manager.stop();
  });

  it("never restarts by itself in server mode or under a supervisor", async () => {
    for (const extra of [{ serverMode: true }, { supervised: true }]) {
      seedCache("v0.6.0");
      let now = 1_000_000;
      const { manager, calls } = make({ now: () => now, watchIntervalMs: 5, idleRestartMs: 600_000, ...extra });
      manager.start();
      await manager.tick();
      now += 3_600_000;
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(calls.restart).toHaveLength(0);
      expect(manager.status()).toMatchObject({ phase: "staged" });
      manager.stop();
    }
  });
});

describe("supervisor detection", () => {
  it("recognises systemd, pm2 and launchd services, and ignores a terminal session", () => {
    expect(isSupervised({ INVOCATION_ID: "abc" })).toBe(true);
    expect(isSupervised({ pm_id: "0" })).toBe(true);
    expect(isSupervised({ XPC_SERVICE_NAME: "com.example.zero" })).toBe(true);
    expect(isSupervised({ XPC_SERVICE_NAME: "0" })).toBe(false);
    expect(isSupervised({ XPC_SERVICE_NAME: "application.com.apple.Terminal.1" })).toBe(false);
    expect(isSupervised({})).toBe(false);
  });
  it("lets ZERO_SUPERVISED decide either way", () => {
    expect(isSupervised({ ZERO_SUPERVISED: "1" })).toBe(true);
    expect(isSupervised({ ZERO_SUPERVISED: "0", INVOCATION_ID: "abc" })).toBe(false);
  });
});
