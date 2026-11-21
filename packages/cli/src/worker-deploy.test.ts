import { homeStateDir } from "@0/engine/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRunner, explainSshFailure, loadManagedWorker, repairWorker, resolveWorkerDemoRoot, resolveWorkerRepoRoot, stopManagedTunnel, stopWorker, validateWorkerOptions } from "./worker-deploy.js";

describe("worker deployment assets", () => {
  it("resolves both source and split bundle modules to their package root", () => {
    const root = mkdtempSync(join(tmpdir(), "worker-assets-"));
    try {
      mkdirSync(join(root, "dist")); mkdirSync(join(root, "vendor"));
      writeFileSync(join(root, "dist/0.js"), "");
      writeFileSync(join(root, "vendor/tree-sitter-0.21.1-node24.tgz"), "");
      for (const path of ["packages/cli/src/worker-deploy.ts", "dist/chunks/worker-deploy.js"]) {
        expect(resolveWorkerRepoRoot(pathToFileURL(join(root, path)).href)).toBe(root);
      }
      rmSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "0.js"), "");
      expect(resolveWorkerRepoRoot(pathToFileURL(join(root, "chunks/worker-deploy.js")).href)).toBe(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("explains a missing bundle and finds assets from the environment or the executable", () => {
    const root = mkdtempSync(join(tmpdir(), "worker-assets-"));
    try {
      mkdirSync(join(root, "scripts")); writeFileSync(join(root, "scripts/bundle-cli.mjs"), "");
      const module = pathToFileURL(join(root, "packages/cli/src/worker-deploy.ts")).href;
      expect(() => resolveWorkerRepoRoot(module, {}, join(root, "nowhere/0"))).toThrow(/build:bundle/);
      expect(() => resolveWorkerRepoRoot("file:///$bunfs/root/0", {}, "/nonexistent/bin/0")).toThrow(/does not include the files/);
      const assets = join(root, "assets");
      mkdirSync(join(assets, "dist"), { recursive: true }); mkdirSync(join(assets, "vendor"));
      writeFileSync(join(assets, "dist/0.js"), ""); writeFileSync(join(assets, "vendor/tree-sitter-0.21.1-node24.tgz"), "");
      expect(resolveWorkerRepoRoot("file:///$bunfs/root/0", { ZERO_WORKER_ASSETS: assets }, "/nonexistent/bin/0")).toBe(assets);
      expect(resolveWorkerRepoRoot("file:///$bunfs/root/0", {}, join(assets, "bin/0"))).toBe(assets);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("turns ssh failures into actionable sentences", () => {
    expect(explainSshFailure("qa", "No ED25519 host key is known for x\nHost key verification failed.")).toContain("--trust-new-host");
    expect(explainSshFailure("qa", "tester@qa: Permission denied (publickey).")).toContain("refused the sign-in");
    expect(explainSshFailure("qa", "ssh: connect to host qa port 22: Connection refused")).toContain("not accepting connections");
    expect(explainSshFailure("qa", "ssh: Could not resolve hostname qa: nodename nor servname provided")).toContain("Could not reach qa");
  });
  it("archives the source worker fixture without a research checkout and prefers bundled assets", () => {
    const root = mkdtempSync(join(tmpdir(), "worker-demo-"));
    const sourceRoot = fileURLToPath(new URL("../../../assets/worker-demo", import.meta.url));
    try {
      expect(resolveWorkerDemoRoot(root, root)).toBe(join(root, "assets/worker-demo"));
      const archive = join(root, "demo-target.tar.gz");
      execFileSync("tar", ["-czf", archive, "-C", sourceRoot, "demo-target"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
      const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
      for (const asset of ["README.md", "include/decoder.h", "src/decoder.c", "patched-decoder.c", "witness-65537x1.bin"]) {
        expect(entries).toContain(`demo-target/${asset}`);
      }
      expect(entries).not.toMatch(/research|workflow-artifacts/);
      mkdirSync(join(root, "dist/worker-assets/demo-target"), { recursive: true });
      expect(resolveWorkerDemoRoot("/unavailable-source", root)).toBe(join(root, "dist/worker-assets"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("stops only a worker with trusted managed metadata and a matching remote process", async () => {
    const backendId = `stop-test-${Date.now()}`;
    const path = join(homeStateDir(), "workers", `${backendId}.json`);
    mkdirSync(join(homeStateDir(), "workers"), { recursive: true });
    const shell = vi.fn((_command: string, _timeout?: number) => "stopped");
    try {
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, backendId, ssh: "worker", port: 23456, remoteDir: "/tmp/zero-engine" }), { mode: 0o600 });
      const result = await stopWorker(backendId, { label: "worker", shell, copy: () => {}, tunnel: () => {} });
      expect(result).toEqual({ stopped: true, tunnelStopped: false, remoteFilesRemoved: false });
      expect(loadManagedWorker(backendId).autoReconnect).toBe(false);
      expect(shell.mock.calls[0]?.[0]).toContain("/proc/$pid/cwd");
      expect(shell.mock.calls[0]?.[0]).toContain("node dist/0.js web ");
      expect(shell.mock.calls[0]?.[0]).not.toContain("pkill");
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, backendId, ssh: "worker", port: 23456, remoteDir: "/home/user" }));
      expect(() => loadManagedWorker(backendId)).toThrow("Invalid managed");
      await expect(stopWorker(backendId)).rejects.toThrow("Invalid managed");
      expect(shell).toHaveBeenCalledTimes(1);
    } finally { rmSync(path, { force: true }); }
  });
  it("repairs a retained engine without reinstalling or replacing its files", async () => {
    const backendId = `repair-test-${Date.now()}`;
    const directory = join(homeStateDir(), "workers");
    const path = join(directory, `${backendId}.json`);
    const envPath = join(directory, `${backendId}.env`);
    mkdirSync(directory, { recursive: true });
    const shell = vi.fn((_command: string, _timeout?: number) => "ENGINE_STARTED\nENGINE_READY\n");
    const tunnel = vi.fn(() => 12345);
    const copy = vi.fn();
    const probe = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    try {
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, backendId, ssh: "worker", port: 23456, remoteDir: "/tmp/zero-engine", operatorNote: "keep" }), { mode: 0o600 });
      writeFileSync(envPath, `ZERO_WORKER_ABCD_TOKEN=${"a".repeat(64)}\n`, { mode: 0o600 });
      const result = await repairWorker(backendId, { label: "worker", shell, tunnel, copy }, probe);
      expect(result).toEqual({ backendId, reconnected: true, engineStarted: true });
      expect(tunnel).toHaveBeenCalledWith(23456);
      expect(loadManagedWorker(backendId).tunnelPid).toBe(12345);
      expect(loadManagedWorker(backendId).autoReconnect).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).operatorNote).toBe("keep");
      expect(copy).not.toHaveBeenCalled();
      const command = shell.mock.calls[0]?.[0];
      expect(command).toContain("/proc/$pid/cwd");
      expect(command).toContain("No process was replaced");
      expect(command).not.toMatch(/npm install|rm -rf|git clone|pkill/);
    } finally { delete process.env.ZERO_WORKER_ABCD_TOKEN; rmSync(path, { force: true }); rmSync(envPath, { force: true }); }
  });

  it("leaves the tunnel alone if the existing remote engine and tunnel are healthy", async () => {
    const backendId = `repair-healthy-${Date.now()}`;
    const directory = join(homeStateDir(), "workers");
    const path = join(directory, `${backendId}.json`), envPath = join(directory, `${backendId}.env`);
    const tunnel = vi.fn(() => 12345);
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, backendId, ssh: "worker", port: 23456, remoteDir: "/tmp/zero-engine" }));
      writeFileSync(envPath, `ZERO_WORKER_ABCD_TOKEN=${"a".repeat(64)}\n`);
      expect(await repairWorker(backendId, { label: "worker", shell: () => "ENGINE_READY", copy: () => {}, tunnel }, () => true)).toMatchObject({ engineStarted: false });
      expect(tunnel).not.toHaveBeenCalled();
    } finally { delete process.env.ZERO_WORKER_ABCD_TOKEN; rmSync(path, { force: true }); rmSync(envPath, { force: true }); }
  });

  it("rejects invalid ports before invoking the worker", () => {
    for (const enginePort of [0, 65536, 1.5]) expect(() => validateWorkerOptions({ ssh: "worker", enginePort })).toThrow("enginePort");
  });
});

describe("assertSshClient", () => {
  it("explains how to get ssh when it is missing", async () => {
    const { assertSshClient } = await import("./worker-deploy.js");
    expect(() => assertSshClient(command => (command === "ssh" ? { error: Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }) } : {}))).toThrow(/OpenSSH client.*Docker image/s);
    expect(() => assertSshClient(() => ({}))).not.toThrow();
  });
});

describe("Lima worker tunnel configuration and isolation", () => {
  class MockChildProcess extends EventEmitter {
    pid = 54321;
    unref = vi.fn();
  }

  const cleanupFiles: string[] = [];
  afterEach(() => {
    while (cleanupFiles.length) {
      const file = cleanupFiles.pop();
      if (file) rmSync(file, { force: true, recursive: true });
    }
    vi.restoreAllMocks();
  });

  it("creates a uniquely named configuration file inside homeStateDir with 0o600 permissions", () => {
    const vm = "test-lima-vm";
    const port = 21234;
    const sshConfigContent = "Host lima-test-lima-vm\n  HostName 127.0.0.1\n  Port 60022\n";
    let capturedArgs: string[] = [];
    let capturedOpts: unknown;
    let capturedCmd = "";
    const mockChild = new MockChildProcess();
    const mockSpawn = vi.fn((cmd: string, args: string[], opts: unknown) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedOpts = opts;
      return mockChild as unknown as ChildProcess;
    });
    const mockExecFile = vi.fn((_cmd: string, _args: string[]) => sshConfigContent);

    const runner = createRunner({ lima: vm }, { execFileSync: mockExecFile as any, spawn: mockSpawn as any });
    const pid = runner.tunnel(port);

    expect(pid).toBe(54321);
    expect(mockChild.unref).toHaveBeenCalled();

    expect(capturedCmd).toBe("ssh");
    expect(capturedOpts).toEqual({ stdio: "ignore", detached: true });

    const configPath = capturedArgs[1]!;
    cleanupFiles.push(configPath);

    expect(capturedArgs).toEqual(["-F", configPath, "-N", "-L", `${port}:127.0.0.1:${port}`, `lima-${vm}`]);
    expect(configPath.startsWith(join(homeStateDir(), "workers"))).toBe(true);
    expect(configPath).toMatch(new RegExp(`lima-${vm}-${port}-[0-9a-f]{12}\\.conf$`));
    expect(existsSync("/tmp/zero-worker-ssh.conf")).toBe(false);

    expect(readFileSync(configPath, "utf8")).toBe(sshConfigContent);
    const stats = statSync(configPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("supports multiple concurrent tunnels using the same VM without file collision", () => {
    const vm = "shared-vm";
    const mockExecFile = vi.fn(() => "Host lima-shared-vm\n");
    const spawnedPaths: string[] = [];
    const mockSpawn = vi.fn((_cmd: string, args: string[]) => {
      spawnedPaths.push(args[1]!);
      return new MockChildProcess() as unknown as ChildProcess;
    });

    const runner = createRunner({ lima: vm }, { execFileSync: mockExecFile as any, spawn: mockSpawn as any });
    runner.tunnel(21001);
    runner.tunnel(21002);

    const [path1, path2] = spawnedPaths;
    cleanupFiles.push(path1!, path2!);

    expect(path1).not.toBe(path2);
    expect(existsSync(path1!)).toBe(true);
    expect(existsSync(path2!)).toBe(true);
  });

  it("isolates tunnels across different VM instances", () => {
    const mockExecFile = vi.fn(() => "Host lima-vm\n");
    const spawnedPaths: string[] = [];
    const mockSpawn = vi.fn((_cmd: string, args: string[]) => {
      spawnedPaths.push(args[1]!);
      return new MockChildProcess() as unknown as ChildProcess;
    });

    const runnerAlpha = createRunner({ lima: "vm-alpha" }, { execFileSync: mockExecFile as any, spawn: mockSpawn as any });
    const runnerBeta = createRunner({ lima: "vm-beta" }, { execFileSync: mockExecFile as any, spawn: mockSpawn as any });

    runnerAlpha.tunnel(22001);
    runnerBeta.tunnel(22002);

    const [pathAlpha, pathBeta] = spawnedPaths;
    cleanupFiles.push(pathAlpha!, pathBeta!);

    expect(pathAlpha).toContain("lima-vm-alpha-22001-");
    expect(pathBeta).toContain("lima-vm-beta-22002-");
    expect(existsSync(pathAlpha!)).toBe(true);
    expect(existsSync(pathBeta!)).toBe(true);
  });

  it("cleans up the configuration file when the SSH process exits", () => {
    let configPath = "";
    const mockChild = new MockChildProcess();
    const mockSpawn = vi.fn((_cmd: string, args: string[]) => {
      configPath = args[1]!;
      return mockChild as unknown as ChildProcess;
    });
    const runner = createRunner({ lima: "exit-vm" }, { execFileSync: vi.fn(() => "config") as any, spawn: mockSpawn as any });

    runner.tunnel(23001);
    cleanupFiles.push(configPath);
    expect(existsSync(configPath)).toBe(true);

    mockChild.emit("exit", 0);
    expect(existsSync(configPath)).toBe(false);
  });

  it("cleans up the configuration file immediately if spawn throws synchronously", () => {
    const mockExecFile = vi.fn(() => "config");
    const mockSpawn = vi.fn(() => { throw new Error("spawn failed synchronously"); });
    const runner = createRunner({ lima: "throw-vm" }, { execFileSync: mockExecFile as any, spawn: mockSpawn as any });

    let thrownError: Error | undefined;
    try {
      runner.tunnel(24001);
    } catch (err) {
      thrownError = err as Error;
    }
    expect(thrownError?.message).toBe("spawn failed synchronously");

    const workersDir = join(homeStateDir(), "workers");
    const matches = existsSync(workersDir) ? readdirSync(workersDir).filter(name => name.startsWith("lima-throw-vm-24001-")) : [];
    expect(matches).toEqual([]);
  });

  it("cleans up configuration on asynchronous spawn error event", () => {
    let configPath = "";
    const mockChild = new MockChildProcess();
    const mockSpawn = vi.fn((_cmd: string, args: string[]) => {
      configPath = args[1]!;
      return mockChild as unknown as ChildProcess;
    });
    const runner = createRunner({ lima: "async-err-vm" }, { execFileSync: vi.fn(() => "config") as any, spawn: mockSpawn as any });

    runner.tunnel(25001);
    cleanupFiles.push(configPath);
    expect(existsSync(configPath)).toBe(true);

    mockChild.emit("error", new Error("spawn ENOENT"));
    expect(existsSync(configPath)).toBe(false);
  });

  it("stops managed tunnel and cleans up its configuration without affecting another active tunnel", () => {
    const stateDir = join(homeStateDir(), "workers");
    mkdirSync(stateDir, { recursive: true });

    const config1 = join(stateDir, "lima-shared-26001-111111111111.conf");
    const config2 = join(stateDir, "lima-shared-26002-222222222222.conf");
    writeFileSync(config1, "Host lima-shared\n", { mode: 0o600 });
    writeFileSync(config2, "Host lima-shared\n", { mode: 0o600 });
    cleanupFiles.push(config1, config2);

    const worker1 = { schemaVersion: 1 as const, backendId: "b1", lima: "shared", port: 26001, tunnelPid: 60001, remoteDir: "/tmp/zero-engine" };

    const mockKill = vi.fn();
    const mockInspect = vi.fn((_pid: number) => ({ stdout: `ssh -F ${config1} -N -L 26001:127.0.0.1:26001 lima-shared\n` }));

    const stopped = stopManagedTunnel(worker1, mockInspect, mockKill);
    expect(stopped).toBe(true);
    expect(mockKill).toHaveBeenCalledWith(60001, "SIGTERM");

    // Worker 1 configuration must be deleted
    expect(existsSync(config1)).toBe(false);
    // Worker 2 configuration must remain intact
    expect(existsSync(config2)).toBe(true);
  });

  it("fails exclusively without overwriting or following existing symbolic links or files", () => {
    const stateDir = join(homeStateDir(), "workers");
    mkdirSync(stateDir, { recursive: true });

    const canary = join(stateDir, "canary-protected.txt");
    writeFileSync(canary, "PROTECTED_CANARY_CONTENT", { mode: 0o600 });
    cleanupFiles.push(canary);

    const existingConf = join(stateDir, "lima-clash-27001-abcdef123456.conf");
    symlinkSync(canary, existingConf);
    cleanupFiles.push(existingConf);

    expect(() => {
      writeFileSync(existingConf, "OVERWRITE_ATTEMPT", { flag: "wx", mode: 0o600 });
    }).toThrow(/EEXIST/);

    expect(readFileSync(canary, "utf8")).toBe("PROTECTED_CANARY_CONTENT");
  });
});
