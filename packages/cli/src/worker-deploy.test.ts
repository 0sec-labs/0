import { homeStateDir } from "@0/engine/shared";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { deployWorker, explainSshFailure, loadManagedWorker, repairWorker, resolveWorkerDemoRoot, resolveWorkerRepoRoot, stopWorker, validateWorkerOptions } from "./worker-deploy.js";

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

  it("accepts valid HTTPS repository URLs", () => {
    const valid = [
      "https://github.com/0sec-labs/0.git",
      "https://gitlab.com/group/repo.git",
      "https://example.com/repo",
      "https://example.com:8443/repo.git",
      "https://host.xz/path/to/repo.git",
    ];
    for (const targetGit of valid) {
      expect(() => validateWorkerOptions({ ssh: "worker", targetGit })).not.toThrow();
    }
  });

  it("rejects non-HTTPS protocols (http, file, git, ext, ssh)", () => {
    const rejected = [
      "http://github.com/0sec-labs/0.git",
      "file:///tmp/zero-repo",
      "git://github.com/0sec-labs/0.git",
      "ext::sh -c evil",
      "ext://evil",
      "ssh://git@github.com/0sec-labs/0.git",
      "ftp://example.com/repo.git",
    ];
    for (const targetGit of rejected) {
      expect(() => validateWorkerOptions({ ssh: "worker", targetGit })).toThrow(/--target-git/);
    }
  });

  it("rejects malformed URLs, URLs with whitespace, quotes, or missing host", () => {
    const malformed = [
      "not-a-url",
      "https://",
      "https:///",
      "https://?query-only",
      "https://#hash-only",
      "https://example.com/repo with spaces.git",
      "https://example.com/repo'quote.git",
      'https://example.com/repo"quote.git',
      "https://x.test/r.git'; rm -rf / #",
    ];
    for (const targetGit of malformed) {
      expect(() => validateWorkerOptions({ ssh: "worker", targetGit })).toThrow(/--target-git/);
    }
  });

  it("applies protocol, hook, and environment hardening in the clone command", async () => {
    const root = mkdtempSync(join(tmpdir(), "worker-harden-test-"));
    mkdirSync(join(root, "dist"), { recursive: true });
    mkdirSync(join(root, "vendor"), { recursive: true });
    mkdirSync(join(root, "dist/worker-assets/demo-target"), { recursive: true });
    writeFileSync(join(root, "dist/0.js"), "");
    writeFileSync(join(root, "vendor/tree-sitter-0.21.1-node24.tgz"), "");

    const shell = vi.fn((cmd: string) => {
      if (cmd.includes("uname")) return "Linux 6.1 x86_64";
      if (cmd.includes("node --version")) return "v24.14.0";
      if (cmd.includes("clang --version")) return "clang version 18.1.0";
      if (cmd.includes("clone")) {
        throw new Error(`INTERCEPTED_CLONE: ${cmd}`);
      }
      return "";
    });

    try {
      await expect(deployWorker({
        ssh: "test-host",
        targetGit: "https://example.com/org/repo.git",
        repoRoot: root,
        quiet: true,
      }, {
        label: "test-host",
        shell,
        copy: () => {},
        tunnel: () => 12345,
      })).rejects.toThrow(/INTERCEPTED_CLONE/);

      const cloneCall = shell.mock.calls.find(call => typeof call[0] === "string" && call[0].includes("clone"));
      expect(cloneCall).toBeDefined();
      const command = cloneCall![0] as string;

      // Git environment hardening
      expect(command).toContain("GIT_TERMINAL_PROMPT=0");
      expect(command).toContain("GIT_ASKPASS=/bin/false");
      expect(command).toContain("GIT_CONFIG_NOSYSTEM=1");
      expect(command).toContain("GIT_CONFIG_GLOBAL=/dev/null");

      // Protocol and hook isolation overrides
      expect(command).toContain("-c protocol.allow=never");
      expect(command).toContain("-c protocol.https.allow=always");
      expect(command).toContain("-c core.hooksPath=/dev/null");
      expect(command).toContain("-c init.templateDir=");

      // Argument separation and escaping
      expect(command).toMatch(/clone\s+--depth\s+1\s+--\s+'https:\/\/example\.com\/org\/repo\.git'\s+\/tmp\/zero-engine\/work\/target/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("assertSshClient", () => {
  it("explains how to get ssh when it is missing", async () => {
    const { assertSshClient } = await import("./worker-deploy.js");
    expect(() => assertSshClient(command => (command === "ssh" ? { error: Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }) } : {}))).toThrow(/OpenSSH client.*Docker image/s);
    expect(() => assertSshClient(() => ({}))).not.toThrow();
  });
});
