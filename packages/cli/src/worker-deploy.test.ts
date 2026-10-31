import { homeStateDir } from "@0/shared";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { loadManagedWorker, repairWorker, resolveWorkerDemoRoot, resolveWorkerRepoRoot, stopWorker, validateWorkerOptions } from "./worker-deploy.js";

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
  it("archives the source worker fixture without research and prefers bundled assets", () => {
    const root = mkdtempSync(join(tmpdir(), "worker-demo-"));
    const sourceRoot = fileURLToPath(new URL("../../../assets/worker-demo", import.meta.url));
    try {
      expect(resolveWorkerDemoRoot(root, root)).toBe(join(root, "assets/worker-demo"));
      const archive = join(root, "demo-target.tar.gz");
      execFileSync("tar", ["-czf", archive, "-C", sourceRoot, "demo-target"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
      const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
      for (const asset of ["README.md", "include/decoder.h", "src/decoder.c", "patched-decoder.c", "witness-65537x1.bin"]) expect(entries).toContain(`demo-target/${asset}`);
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
      expect(shell.mock.calls[0]?.[0]).toContain("node dist/0.js dashboard");
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
