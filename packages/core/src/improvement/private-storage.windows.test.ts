import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./config.js", () => ({ canonicalEvolutionJson: (value: unknown) => JSON.stringify(value) }));
import { ensureEvolutionDirectory, publishEvolutionArtifact, readEvolutionArtifact } from "./artifacts.js";
import { assertPrivateStorage } from "./private-storage.js";
const nativeProbe = vi.hoisted(() => ({ delayedAttempts: 0, fixedDelays: [] as number[], calls: 0, timedOutPids: [] as number[] }));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn((...args: unknown[]) => {
    const commandArgs = args[1] as string[] | undefined;
    if (commandArgs?.includes("-EncodedCommand") && Buffer.from(commandArgs.at(-1)!, "base64").toString("utf16le").includes("ACL_STAGE:start")) {
      nativeProbe.calls++;
      const timeout = (args[2] as { timeout: number }).timeout;
      const delay = nativeProbe.fixedDelays.shift() ?? (nativeProbe.delayedAttempts > 0 ? timeout + 1000 : 0);
      if (delay > 0) {
        if (nativeProbe.delayedAttempts > 0) nativeProbe.delayedAttempts--;
        const delayed = [...commandArgs];
        delayed[delayed.length - 1] = Buffer.from(`[Threading.Thread]::Sleep(${delay});\n` + Buffer.from(delayed.at(-1)!, "base64").toString("utf16le"), "utf16le").toString("base64");
        args[1] = delayed;
      }
    }
    try { return Reflect.apply(original.execFileSync, original, args); }
    catch (error) {
      const native = error as { code?: string; pid?: number };
      if (native.code === "ETIMEDOUT" && typeof native.pid === "number") nativeProbe.timedOutPids.push(native.pid);
      throw error;
    }
  }) };
});
const roots: string[] = [];
afterEach(() => { nativeProbe.delayedAttempts = 0; nativeProbe.fixedDelays = []; nativeProbe.calls = 0; nativeProbe.timedOutPids = []; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string { const path = mkdtempSync(join(homedir(), "zero-private-storage-")); roots.push(path); return path; }
function grant(path: string, principal: string): void { execFileSync("icacls.exe", [path, "/grant", `*${principal}:(R)`], { stdio: "pipe", windowsHide: true }); }
describe.skipIf(process.platform !== "win32")("native Windows storage ACLs", () => {
  function entries(path: string) { return [{ path, stat: statSync(path) }]; }
  function expectTimedOutProbesExited(count: number): void {
    expect(nativeProbe.timedOutPids).toHaveLength(count);
    for (const pid of nativeProbe.timedOutPids) expect(() => process.kill(pid, 0)).toThrow();
  }
  function resetProbeObservation(): void {
    // Fixture construction can itself encounter a cold timeout; confirm that
    // owned process also exited before measuring the deliberately delayed probes.
    for (const pid of nativeProbe.timedOutPids) expect(() => process.kill(pid, 0)).toThrow();
    nativeProbe.calls = 0; nativeProbe.timedOutPids = [];
  }
  it("retries a real timed-out startup and accepts only the fresh private ACL", () => {
    const path = ensureEvolutionDirectory(join(root(), "retry-private"));
    resetProbeObservation(); nativeProbe.delayedAttempts = 1;
    expect(() => assertPrivateStorage(entries(path))).not.toThrow();
    expect(nativeProbe.calls).toBe(2); expectTimedOutProbesExited(1);
  }, 35000);
  it("lets a six-second cold retry complete within its separate ten-second deadline", () => {
    const path = ensureEvolutionDirectory(join(root(), "retry-longer-cold"));
    resetProbeObservation(); nativeProbe.fixedDelays = [6000, 6000];
    const start = Date.now();
    expect(() => assertPrivateStorage(entries(path))).not.toThrow();
    expect(nativeProbe.calls).toBe(2); expectTimedOutProbesExited(1);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10500);
    expect(nativeProbe.fixedDelays).toEqual([]);
  }, 35000);
  it("rejects a real unsafe ACL after the first native startup times out", () => {
    const path = ensureEvolutionDirectory(join(root(), "retry-unsafe"));
    grant(path, "S-1-1-0");
    resetProbeObservation(); nativeProbe.delayedAttempts = 1;
    expect(() => assertPrivateStorage(entries(path))).toThrow("private Windows ACL");
    expect(nativeProbe.calls).toBe(2); expectTimedOutProbesExited(1);
  }, 35000);
  it("fails closed after exactly two real native timeouts without leaving their processes alive", () => {
    const path = ensureEvolutionDirectory(join(root(), "retry-bounded"));
    resetProbeObservation(); nativeProbe.delayedAttempts = 2;
    const start = Date.now();
    expect(() => assertPrivateStorage(entries(path))).toThrow("launch: timeout");
    expect(nativeProbe.calls).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(14500);
    // Scheduling and process termination are observed, not assumed instantaneous.
    expect(Date.now() - start).toBeLessThan(25000);
    expectTimedOutProbesExited(2);
  }, 40000);
  it("creates executable-plugin storage under the normal user profile without POSIX mode assumptions", () => {
    const path = join(root(), ".0", "executable-plugins");
    expect(ensureEvolutionDirectory(path)).toBe(path);
  });
  it("treats spaces, quotes, brackets and dollar expressions as literal path data", () => {
    const directory = ensureEvolutionDirectory(join(root(), "literal space ' quote $(whoami) [x]"));
    const path = join(directory, "record ' $().json");
    publishEvolutionArtifact(path, { literal: true });
    expect(readEvolutionArtifact(path)).toEqual({ literal: true });
  });
  it("publishes and replays an artifact using real Windows ACLs", () => {
    const path = join(root(), "receipts", "record.json");
    publishEvolutionArtifact(path, { passed: true });
    expect(readEvolutionArtifact(path)).toEqual({ passed: true });
    publishEvolutionArtifact(path, { passed: true });
    expect(() => publishEvolutionArtifact(path, { passed: false })).toThrow("collision");
  });
  it("rejects a directory granting ordinary Users read access", () => {
    const path = ensureEvolutionDirectory(join(root(), "private"));
    grant(path, "S-1-5-32-545");
    expect(() => ensureEvolutionDirectory(path)).toThrow("private Windows ACL");
  });
  it("rejects broad inherit-only grants before publishing child payloads", () => {
    const directory = ensureEvolutionDirectory(join(root(), "private"));
    execFileSync("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(CI)(IO)(R)"], { stdio: "pipe", windowsHide: true });
    expect(() => publishEvolutionArtifact(join(directory, "never-written.json"), { secret: "fixture" })).toThrow("private Windows ACL");
  });
  it("rejects a broadly readable artifact inside a private directory", () => {
    const path = join(root(), "receipts", "record.json");
    publishEvolutionArtifact(path, { passed: true });
    grant(path, "S-1-1-0");
    expect(() => readEvolutionArtifact(path)).toThrow("private Windows ACL");
  });
  it("rejects junction ancestors even when their target is private", () => {
    const directory = root();
    const target = ensureEvolutionDirectory(join(directory, "target"));
    symlinkSync(target, join(directory, "junction"), "junction");
    expect(() => ensureEvolutionDirectory(join(directory, "junction", "nested"))).toThrow("unsafe evolution directory");
  });
});
