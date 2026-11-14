import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";
import type * as ChildProcess from "node:child_process";

const access = vi.hoisted(() => ({
  accountGroups: "1000", directAllowed: false, sgAvailable: true,
  endpoint: "unix:///var/run/docker.sock", groupActivations: 0,
}));
const imageId = `sha256:${"a".repeat(64)}`;

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FsPromises>();
  return { ...actual, stat: (path: string, ...args: unknown[]) => path === "/var/run/docker.sock"
    ? Promise.resolve({ uid: 0, gid: 44, mode: 0o140660, isSocket: () => true })
    : Reflect.apply(actual.stat, actual, [path, ...args]) };
});
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcess>();
  // The mock must retain execFile's native promisify contract (stdout + stderr).
  const { promisify } = await import("node:util");
  const { PassThrough } = await import("node:stream");
  const invoke = (binary: string, args: string[]): string => {
    if (binary === "id") return access.accountGroups;
    if (binary === "getent") return "docker:x:44:operator";
    if (binary === "which") {
      if (!access.sgAvailable) throw new Error("sg missing");
      return "/usr/bin/sg";
    }
    if (binary === "docker" && args[0] === "context") return access.endpoint;
    if (binary === "/usr/bin/sg") {
      access.groupActivations++;
      if (access.endpoint !== "unix:///var/run/docker.sock") throw new Error("unexpected group activation for remote endpoint");
      return `sha256:${"a".repeat(64)}`;
    }
    if (binary === "fixture-docker" || access.directAllowed) return `sha256:${"a".repeat(64)}`;
    throw new Error("permission denied opening Docker socket");
  };
  const execFile = (binary: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    queueMicrotask(() => {
      try { callback(null, invoke(binary, args), ""); }
      catch (error) { callback(error as Error, "", (error as Error).message); }
    });
    return new actual.ChildProcess();
  };
  Object.defineProperty(execFile, promisify.custom, { value: async (binary: string, args: string[]) => ({ stdout: invoke(binary, args), stderr: "" }) });
  const spawn = (binary: string, args: string[]) => {
    const child = new actual.ChildProcess();
    const stdout = child.stdout = new PassThrough();
    const stderr = child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      let code = 0;
      try { stdout.end(invoke(binary, args)); stderr.end(); }
      catch (error) { code = 1; stdout.end(); stderr.end((error as Error).message); }
      child.emit("exit", code, null);
      child.emit("close", code, null);
    });
    return child;
  };
  return { ...actual, execFile, spawn };
});

import { resolveEvolutionImage } from "./sandbox.js";

beforeEach(() => {
  Object.assign(access, { accountGroups: "1000", directAllowed: false, sgAvailable: true, endpoint: "unix:///var/run/docker.sock", groupActivations: 0 });
  vi.stubEnv("DOCKER_HOST", "");
  vi.stubEnv("DOCKER_CONTEXT", "");
  vi.spyOn(process, "getuid").mockReturnValue(1000);
  vi.spyOn(process, "getgid").mockReturnValue(1000);
  vi.spyOn(process, "getgroups").mockReturnValue([1000]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe.skipIf(process.platform !== "linux")("Docker access through the real sandbox image resolver", () => {
  it("recovers newly granted account access without restarting the process", async () => {
    await expect(resolveEvolutionImage("test:local")).rejects.toThrow();
    expect(access.groupActivations).toBe(0);
    access.accountGroups = "1000 44";
    await expect(resolveEvolutionImage("test:local")).resolves.toBe(imageId);
    expect(access.groupActivations).toBe(1);
  });

  it("does not require sg when this process already has socket access", async () => {
    vi.mocked(process.getgroups!).mockReturnValue([1000, 44]);
    access.directAllowed = true;
    access.sgAvailable = false;
    await expect(resolveEvolutionImage("test:local")).resolves.toBe(imageId);
  });

  it("honors a persisted remote Docker context instead of activating a local group", async () => {
    access.accountGroups = "1000 44";
    access.endpoint = "ssh://operator@builder";
    access.directAllowed = true;
    await expect(resolveEvolutionImage("test:local")).resolves.toBe(imageId);
    expect(access.groupActivations).toBe(0);
  });

  it("leaves explicitly selected rootless endpoints alone", async () => {
    vi.stubEnv("DOCKER_HOST", "unix:///run/user/1000/docker.sock");
    access.accountGroups = "1000 44";
    access.endpoint = "unix:///run/user/1000/docker.sock";
    access.directAllowed = true;
    await expect(resolveEvolutionImage("test:local")).resolves.toBe(imageId);
    expect(access.groupActivations).toBe(0);
  });

  it("does not replace the isolation backend when group activation is unavailable", async () => {
    access.accountGroups = "1000 44";
    access.sgAvailable = false;
    await expect(resolveEvolutionImage("test:local")).rejects.toThrow();
    expect(access.groupActivations).toBe(0);
  });

  it("does not run Docker identity recovery for an operator-selected binary", async () => {
    access.sgAvailable = false;
    await expect(resolveEvolutionImage("test:local", "fixture-docker")).resolves.toBe(imageId);
    expect(access.groupActivations).toBe(0);
  });
});
