import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkbenchBroker, WORKBENCH_BROKER_WORKSPACE } from "./smolvm-broker.js";
import type { WorkbenchBrokerController } from "./smolvm-broker.js";
import { runSmolvmDarwinProgram } from "./smolvm-darwin.js";
import type { SmolvmExecutionResult } from "./smolvm.js";
import { smolvmArchiveDigest } from "./smolvm-provision.js";

vi.mock("./smolvm-darwin.js", () => ({ runSmolvmDarwinProgram: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); });

// Run the actual transport and requested Node program in disposable local
// directories. Only the native VM boundary is substituted; absolute guest
// filesystem paths are mapped before real filesystem/child-process operations.
function guestPrelude(paths: Record<string, string>): string {
  return `(function install(paths) {
    const Module = require('node:module'), fs = require('node:fs'), cp = require('node:child_process');
    const map = path => {
      if (typeof path !== 'string') return path;
      for (const [guest, host] of Object.entries(paths)) {
        if (path === guest || path.startsWith(guest + '/')) return host + path.slice(guest.length);
      }
      return path;
    };
    const mapped = { readFileSync: true, writeFileSync: true, mkdirSync: true, lstatSync: true, statSync: true, readdirSync: true, openSync: true, chmodSync: true, rmSync: true, copyFileSync: true, renameSync: true };
    const guestFs = new Proxy(fs, { get(target, key) {
      const value = target[key];
      if (!Object.hasOwn(mapped, key)) return value;
      return (...args) => {
        args[0] = map(args[0]);
        if (key === 'copyFileSync' || key === 'renameSync') args[1] = map(args[1]);
        return value(...args);
      };
    } });
    const guestCp = { ...cp, spawn(binary, args, options) {
      if (binary !== process.execPath || args[0] !== '--eval') throw Error('fixture permits only a local Node probe');
      const prelude = '(' + install.toString() + ')(' + JSON.stringify(paths) + ');';
      return cp.spawn(binary, ['--eval', prelude + args[1]], { ...options, cwd: map(options.cwd) });
    } };
    const load = Module._load;
    Module._load = function(id, ...args) {
      if (id === 'node:fs') return guestFs;
      if (id === 'node:child_process') return guestCp;
      return load.call(this, id, ...args);
    };
  })(${JSON.stringify(paths)});`;
}

async function transportBroker(prepare?: (workspace: string) => Promise<void>): Promise<{ root: string; broker: WorkbenchBrokerController }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "0-broker-transport-")));
  const archive = join(root, "approved.tar");
  const bytes = Buffer.from("local transport fixture approval");
  await writeFile(archive, bytes, { mode: 0o600 });
  vi.mocked(runSmolvmDarwinProgram).mockImplementation(async options => {
    const guest = await mkdtemp(join(root, "guest-"));
    const workspace = join(guest, "workspace");
    await prepare?.(workspace);
    const paths = Object.fromEntries((options.mounts ?? []).map(mount => [mount.target, mount.source]));
    paths[WORKBENCH_BROKER_WORKSPACE] = workspace;
    const start = performance.now();
    try {
      const completion = Promise.withResolvers<SmolvmExecutionResult>();
      const child = spawn(process.execPath, ["--eval", guestPrelude(paths) + options.command[2]], {
        cwd: guest, stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "", timedOut = false;
      // The broker's real filesystem polling and subprocess pipes require
      // platform time; this deadline bounds a stuck fixture, not a guessed wait.
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
      child.stdin.on("error", () => {});
      child.stdout.on("data", (data: Buffer) => options.channel?.onData(data.toString("utf8")));
      child.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
      child.on("spawn", () => options.channel?.onReady(data => { child.stdin.write(data); }));
      child.on("error", error => { clearTimeout(timer); completion.reject(error); });
      child.on("close", exitCode => {
        clearTimeout(timer);
        completion.resolve({ exitCode, stdout: "", stderr, timedOut, durationMs: performance.now() - start,
          ...(exitCode !== 0 ? { error: stderr || "local transport fixture failed" } : {}) });
      });
      return await completion.promise;
    } finally { await rm(guest, { recursive: true, force: true }); }
  });
  const broker = await startWorkbenchBroker({ root: join(root, "private"), imageArchive: archive,
    imageDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, runtimeId: randomBytes(32).toString("hex") });
  return { root, broker };
}

interface TransportRecord {
  type: string; file?: { path: string; data: string; digest: string }; execution?: SmolvmExecutionResult;
}
async function transportReceipt(broker: WorkbenchBrokerController, command: string[]): Promise<TransportRecord[]> {
  const id = randomBytes(24).toString("hex");
  const input = Buffer.from("transferred source");
  const request = { protocol: 1, runtimeId: broker.admission.runtimeId, id, profile: "offline", command, interactive: false,
    timeoutMs: 3000, memoryMb: 128, cpus: 1, maxOutputBytes: 1024,
    files: [{ path: "nested/input.txt", data: input.toString("base64"), digest: `sha256:${createHash("sha256").update(input).digest("hex")}`, mode: 0o600 }] };
  const temporary = join(broker.guestRoot, `${id}.request.tmp`);
  await writeFile(temporary, JSON.stringify(request), { flag: "wx", mode: 0o600 });
  await rename(temporary, join(broker.guestRoot, `${id}.request.json`));
  const records: TransportRecord[] = [];
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const record = JSON.parse(await readFile(join(broker.guestRoot, `${id}.output.${records.length}.json`), "utf8"));
      records.push(record);
      if (record.type === "complete") return records;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await delay(10); }
  }
  throw new Error("Bounded transport receipt did not arrive");
}

const qualifiedHost = process.platform === "darwin" && process.arch === "arm64" && process.getuid?.() !== 0;

describe.skipIf(!qualifiedHost)("host sibling broker authority boundary", () => {
  it("refuses setup archives above the same eight-GiB ceiling as broker admission", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "0-broker-archive-")));
    const archive = join(root, "oversized.tar");
    const file = await open(archive, "wx", 0o600);
    try {
      try { await file.truncate(8 * 1024 ** 3 + 1); }
      finally { await file.close(); }
      await expect(smolvmArchiveDigest(archive)).rejects.toThrow(/8 GiB/);
      await expect(startWorkbenchBroker({ root: join(root, "private"), imageArchive: archive,
        imageDigest: `sha256:${"a".repeat(64)}`, runtimeId: randomBytes(32).toString("hex") })).rejects.toThrow(/archive file/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("returns artifacts written through the canonical absolute guest workspace", async () => {
    const { root, broker } = await transportBroker();
    try {
      const path = `${WORKBENCH_BROKER_WORKSPACE}/artifacts/result.txt`;
      const records = await transportReceipt(broker, [process.execPath, "--eval", `
        const fs = require('node:fs');
        const input = fs.readFileSync(${JSON.stringify(`${WORKBENCH_BROKER_WORKSPACE}/nested/input.txt`)}, 'utf8');
        fs.mkdirSync(${JSON.stringify(`${WORKBENCH_BROKER_WORKSPACE}/artifacts`)});
        fs.writeFileSync(${JSON.stringify(path)}, input + ':verified');
        process.stdout.write(input);
      `]);
      expect(records.at(-1)?.execution).toMatchObject({ exitCode: 0, stdout: "transferred source" });
      expect(records.at(-1)?.execution?.error).toBeUndefined();
      const artifact = records.find(record => record.file?.path === "artifacts/result.txt")?.file;
      expect(Buffer.from(artifact!.data, "base64").toString("utf8")).toBe("transferred source:verified");
      expect(artifact?.digest).toBe(`sha256:${createHash("sha256").update("transferred source:verified").digest("hex")}`);
    } finally { await broker.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("refuses artifacts after the command replaces its workspace directory", async () => {
    const { root, broker } = await transportBroker();
    try {
      const records = await transportReceipt(broker, [process.execPath, "--eval", `
        const fs = require('node:fs');
        fs.renameSync(${JSON.stringify(WORKBENCH_BROKER_WORKSPACE)}, ${JSON.stringify(`${WORKBENCH_BROKER_WORKSPACE}/../original`)});
        fs.mkdirSync(${JSON.stringify(WORKBENCH_BROKER_WORKSPACE)});
        fs.writeFileSync(${JSON.stringify(`${WORKBENCH_BROKER_WORKSPACE}/untrusted.txt`)}, 'replacement');
      `]);
      expect(records.at(-1)?.execution?.error).toMatch(/workspace was replaced/);
      expect(records.filter(record => record.type === "file")).toEqual([]);
    } finally { await broker.close(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(["directory", "symlink"] as const)("refuses pre-existing guest workspace %s without executing the command", async kind => {
    const { root, broker } = await transportBroker(async workspace => {
      if (kind === "directory") await mkdir(workspace, { mode: 0o700 });
      else await symlink("missing-target", workspace);
    });
    try {
      const records = await transportReceipt(broker, [process.execPath, "--eval", "process.stdout.write('UNSAFE_COMMAND_EXECUTED')"]);
      expect(records.at(-1)?.execution?.error).toMatch(/EEXIST/);
      expect(records.at(-1)?.execution?.stdout).toBe("");
      expect(records.filter(record => record.type === "file")).toEqual([]);
    } finally { await broker.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("refuses host-path/env requests, unapproved images and linked authority without executing a child", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "0-broker-boundary-")));
    const privateRoot = join(root, "private");
    await mkdir(privateRoot, { mode: 0o700 });
    // An explicit fake operator approval suffices for decoder refusals; no VM
    // should reach this archive, which intentionally is not a container image.
    const archive = join(root, "approved.tar");
    const bytes = Buffer.from("bounded fake authority approval");
    await writeFile(archive, bytes, { mode: 0o600 });
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const runtimeId = randomBytes(32).toString("hex");
    const secret = "FAKE_AUTHORITY_CANARY_MUST_NOT_LEAVE_PRIVATE_ROOT";
    const canary = join(root, "authority");
    await writeFile(canary, secret, { mode: 0o600 });
    const broker = await startWorkbenchBroker({ root: privateRoot, imageArchive: archive, imageDigest: digest, runtimeId });
    async function receipt(id: string): Promise<{ type: string; execution: { stdout: string; error: string } }> {
      for (let attempt = 0; attempt < 200; attempt++) {
        try { return JSON.parse(await readFile(join(broker.guestRoot, `${id}.output.0.json`), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await delay(10); }
      }
      throw new Error("Bounded broker refusal did not arrive");
    }
    async function publishRequest(id: string, value: unknown): Promise<void> {
      const temporary = join(broker.guestRoot, `${id}.request.tmp`);
      await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      await rename(temporary, join(broker.guestRoot, `${id}.request.json`));
    }
    const base = { protocol: 1, runtimeId, profile: "offline", command: ["/bin/sh", "-c", "exit 0"], interactive: false, files: [],
      timeoutMs: 1000, memoryMb: 128, cpus: 1, maxOutputBytes: 1024 };
    try {
      const hostPathId = randomBytes(24).toString("hex");
      await publishRequest(hostPathId, { ...base, id: hostPathId, workspaceRoot: root, environment: { SECRET: secret } });
      const hostPath = await receipt(hostPathId);
      expect(hostPath.execution.error).toMatch(/identity or fields/);
      expect(hostPath.execution.stdout).toBe("");

      const imageId = randomBytes(24).toString("hex");
      await publishRequest(imageId, { ...base, id: imageId, imageReference: `unapproved.invalid/tool@sha256:${"a".repeat(64)}` });
      expect((await receipt(imageId)).execution.error).toMatch(/not explicitly approved/);

      // V8's grouped/repeated base64 regex used to exhaust its stack at this
      // advertised boundary, even though the decoded bytes were valid.
      const maximumId = randomBytes(24).toString("hex");
      const maximum = Buffer.alloc(4 * 1024 * 1024);
      await publishRequest(maximumId, { ...base, id: maximumId,
        imageReference: `unapproved.invalid/tool@sha256:${"a".repeat(64)}`,
        files: [{ path: "maximum.bin", digest: `sha256:${createHash("sha256").update(maximum).digest("hex")}`, data: maximum.toString("base64"), mode: 0o600 }] });
      expect((await receipt(maximumId)).execution.error).toMatch(/not explicitly approved/);

      const traversalId = randomBytes(24).toString("hex");
      await publishRequest(traversalId, { ...base, id: traversalId,
        files: [{ path: "../authority", digest, data: bytes.toString("base64"), mode: 0o600 }] });
      expect((await receipt(traversalId)).execution.error).toMatch(/file path/);

      const linkedId = randomBytes(24).toString("hex");
      await symlink(canary, join(broker.guestRoot, `${linkedId}.request.json`));
      const linked = await receipt(linkedId);
      expect(linked.type).toBe("complete");
      expect(linked.execution.error).toMatch(/identity or fields/);
      expect(JSON.stringify(linked)).not.toContain(secret);

      const hardlinkedId = randomBytes(24).toString("hex");
      await link(canary, join(broker.guestRoot, `${hardlinkedId}.request.json`));
      const hardlinked = await receipt(hardlinkedId);
      expect(hardlinked.execution.error).toMatch(/identity or fields/);
      expect(JSON.stringify(hardlinked)).not.toContain(secret);

      const httpId = randomBytes(24).toString("hex");
      await publishRequest(httpId, { ...base, id: httpId, profile: "http", httpTarget: "http://127.0.0.1:9/" });
      expect((await receipt(httpId)).execution.error).toMatch(/did not grant HTTP/);

      const cancelledId = randomBytes(24).toString("hex");
      await writeFile(join(broker.guestRoot, `${cancelledId}.cancel.json`), JSON.stringify({ cancel: true }));
      await publishRequest(cancelledId, { ...base, id: cancelledId });
      expect((await receipt(cancelledId)).execution.error).toMatch(/cancelled before VM admission/);
      await broker.close();
      expect(await readdir(privateRoot)).toEqual([]);
    } finally { await broker.close(); await rm(root, { recursive: true, force: true }); }
  });
});
