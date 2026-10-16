import { homeStateDir } from "@0/shared";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { loadManagedWorker, resolveWorkerRepoRoot, stopWorker, validateWorkerOptions } from "./worker-deploy.js";

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
  it("stops only a worker with trusted managed metadata and a matching remote process", async () => {
    const backendId = `stop-test-${Date.now()}`;
    const path = join(homeStateDir(), "workers", `${backendId}.json`);
    mkdirSync(join(homeStateDir(), "workers"), { recursive: true });
    const shell = vi.fn((_command: string, _timeout?: number) => "stopped");
    try {
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, backendId, ssh: "worker", port: 23456, remoteDir: "/tmp/zero-engine" }), { mode: 0o600 });
      const result = await stopWorker(backendId, { label: "worker", shell, copy: () => {}, tunnel: () => {} });
      expect(result).toEqual({ stopped: true, tunnelStopped: false, remoteFilesRemoved: false });
      expect(shell.mock.calls[0]?.[0]).toContain("/proc/$pid/cwd");
      expect(shell.mock.calls[0]?.[0]).toContain("node dist/0.js dashboard");
      expect(shell.mock.calls[0]?.[0]).not.toContain("pkill");
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, backendId, ssh: "worker", port: 23456, remoteDir: "/home/user" }));
      expect(() => loadManagedWorker(backendId)).toThrow("Invalid managed");
      await expect(stopWorker(backendId)).rejects.toThrow("Invalid managed");
      expect(shell).toHaveBeenCalledTimes(1);
    } finally { rmSync(path, { force: true }); }
  });
  it("rejects invalid ports before invoking the worker", () => {
    for (const enginePort of [0, 65536, 1.5]) expect(() => validateWorkerOptions({ ssh: "worker", enginePort })).toThrow("enginePort");
  });
});
