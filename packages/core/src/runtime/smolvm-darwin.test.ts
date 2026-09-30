import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SMOLVM_DARWIN_SUPERVISOR_SOURCE } from "./smolvm-darwin-source.js";
import { runSmolvmWorkbench } from "./smolvm-workbench.js";
import type { SmolvmWorkbenchOptions } from "./smolvm-workbench.js";
import type * as SmolvmProvision from "./smolvm-provision.js";

const fixtureRuntime = vi.hoisted(() => ({ binary: "", supervisor: "", bundleRoot: "" }));
vi.mock("./smolvm-provision.js", async importOriginal => {
  const actual = await importOriginal<typeof SmolvmProvision>();
  return {
    ...actual,
    getSmolvmWorkbenchStatus: async () => ({ platformSupported: true, runtimeReady: true, imageApproved: true, retainedRuns: [] }),
    approvedSmolvmWorkbenchImage: async (image: string) => ({ path: image, digest: await actual.smolvmArchiveDigest(image) }),
    resolveSmolvmRuntime: async () => ({ version: "1.14.6", ...fixtureRuntime }),
  };
});
vi.mock("./smolvm-broker.js", () => ({
  startWorkbenchBroker: async ({ root }: { root: string }) => {
    const guestRoot = join(root, "requests");
    await mkdir(guestRoot, { recursive: true, mode: 0o700 });
    return { guestRoot, admission: {}, close: async () => {} };
  },
}));

interface NativeProof { schemaVersion: number; exitCode: number; cleanupFailed: boolean; cancelled: boolean; reason: string; }
interface NativeFixture {
  child: ChildProcess; control: Writable; ready: Promise<void>; proof: Promise<NativeProof>; closed: Promise<void>; output: Promise<void>;
}

// These exercise real Darwin ownership/admission syscalls with bounded trusted
// host fixtures, not simulated VMs. Separate qualification boots actual guests.
describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("native SmolVM lifecycle", () => {
  let root: string;
  let binary: string;
  let sequence = 0;
  beforeAll(async () => {
    root = await mkdtemp("/tmp/0-native-regression-");
    binary = join(root, "supervisor-test");
    const source = join(root, "supervisor.c");
    await writeFile(source, SMOLVM_DARWIN_SUPERVISOR_SOURCE, { mode: 0o600 });
    const compiled = Promise.withResolvers<void>();
    execFile("/usr/bin/xcrun", ["clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", binary], (error) => {
      if (error) compiled.reject(error); else compiled.resolve();
    });
    await compiled.promise;
    await chmod(binary, 0o700);
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  function launch(environment: Record<string, string>, command: string[], resultPath = join(root, `result-${sequence++}.json`)): NativeFixture {
    const child = spawn(binary, [String(process.pid), resultPath, "--", ...command], {
      cwd: root,
      env: { PATH: "/usr/bin:/bin", ZERO_SMOLVM_RUN_TOKEN: randomBytes(32).toString("hex"), ...environment },
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    });
    const ready = Promise.withResolvers<void>();
    const proof = Promise.withResolvers<NativeProof>();
    const closed = Promise.withResolvers<void>();
    const output = Promise.withResolvers<void>();
    const control = child.stdio[3] as Writable;
    let protocol = "";
    control.on("error", () => {});
    (child.stdio[4] as Readable).on("data", (chunk: Buffer) => {
      protocol += chunk.toString("utf8");
      if (protocol.startsWith("READY\n")) { protocol = protocol.slice(6); ready.resolve(); }
      if (protocol.endsWith("\n") && protocol.startsWith("{")) proof.resolve(JSON.parse(protocol) as NativeProof);
    });
    child.stdout!.on("data", () => output.resolve());
    child.on("error", (error) => { ready.reject(error); proof.reject(error); output.reject(error); });
    child.on("close", () => closed.resolve());
    return { child, control, ready: ready.promise, proof: proof.promise, closed: closed.promise, output: output.promise };
  }

  // Provisioning/VM import are replaced with trusted local fixture bytes, but
  // admission, controller recovery and completion proof use the real supervisor.
  async function workbenchFixture(): Promise<{ options: SmolvmWorkbenchOptions; effect: string }> {
    const directory = await mkdtemp(join(root, "workbench-"));
    const stateRoot = join(directory, "state"), workspaceRoot = join(directory, "workspace");
    await mkdir(stateRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    const image = join(directory, "image.tar"), effect = join(directory, "launched");
    await writeFile(image, "trusted local launcher fixture", { mode: 0o600 });
    const launcher = join(directory, "launcher");
    await writeFile(launcher, `#!/bin/sh\n/usr/bin/touch "${effect}"\n`, { mode: 0o700 });
    fixtureRuntime.binary = launcher;
    fixtureRuntime.supervisor = binary;
    fixtureRuntime.bundleRoot = directory;
    return { effect, options: { image, stateRoot: await realpath(stateRoot), workspaceRoot,
      command: ["/bin/true"], environment: {}, network: false, tty: false, cpus: 1, memoryMb: 256, storageGb: 20 } };
  }

  it.skipIf(process.getuid?.() === 0)("recovers a natively completed lease only after the native admission lock is released", async () => {
    const { options, effect } = await workbenchFixture();
    const retained = await mkdtemp("/tmp/0w-"), token = randomBytes(32).toString("hex");
    const leasePath = join(options.stateRoot, "active-run.json");
    const lease = JSON.stringify({ schemaVersion: 1, root: retained, token });
    await writeFile(leasePath, lease, { mode: 0o600 });
    const previous = launch({ ZERO_SMOLVM_ADMISSION_LOCK: join(options.stateRoot, "native-admission.lock") },
      ["/usr/bin/true"], join(retained, "complete.json"));
    try {
      await previous.ready;
      previous.control.write("launch\n");
      expect(await previous.proof).toMatchObject({ exitCode: 0, cleanupFailed: false });
      const blocked = await runSmolvmWorkbench(options);
      expect(blocked.error).toMatch(/holds the resource reservation/);
      expect(await readFile(leasePath, "utf8")).toBe(lease);
      await expect(stat(effect)).rejects.toMatchObject({ code: "ENOENT" });
      previous.control.end("release\n");
      await previous.closed;
      const relaunched = await runSmolvmWorkbench(options);
      expect(relaunched).toMatchObject({ exitCode: 0, cleanupFailed: false });
      expect(relaunched.error).toBeUndefined();
      expect((await stat(effect)).isFile()).toBe(true);
      await expect(stat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(retained)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (!previous.control.destroyed) previous.control.end("release\n");
      await previous.closed;
      await rm(retained, { recursive: true, force: true });
    }
  }, 10000);

  it.skipIf(process.getuid?.() === 0).each(["missing", "failed"] as const)("preserves %s native cleanup proof and refuses another guest", async kind => {
    const { options, effect } = await workbenchFixture();
    const retained = await mkdtemp("/tmp/0w-"), token = randomBytes(32).toString("hex");
    const leasePath = join(options.stateRoot, "active-run.json");
    const lease = JSON.stringify({ schemaVersion: 1, root: retained, token });
    await writeFile(leasePath, lease, { mode: 0o600 });
    const canary = join(retained, "private-state");
    await writeFile(canary, "must survive uncertain cleanup", { mode: 0o600 });
    if (kind === "failed") await writeFile(join(retained, "complete.json"),
      JSON.stringify({ schemaVersion: 1, exitCode: -1, cleanupFailed: true, cancelled: true, reason: "unconfirmed" }), { mode: 0o600 });
    try {
      const refused = await runSmolvmWorkbench(options);
      expect(refused.error).toMatch(/admission remains reserved/);
      expect(await readFile(leasePath, "utf8")).toBe(lease);
      expect(await readFile(canary, "utf8")).toBe("must survive uncertain cleanup");
      await expect(stat(effect)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(retained, { recursive: true, force: true }); }
  }, 10000);

  it("keeps admission through completion until the controller releases its lease", async () => {
    const lock = join(root, "admission.lock");
    const effect = join(root, "must-not-run");
    const first = launch({ ZERO_SMOLVM_ADMISSION_LOCK: lock }, ["/usr/bin/true"]);
    try {
      await first.ready;
      const blockedBeforeLaunch = launch({ ZERO_SMOLVM_ADMISSION_LOCK: lock }, ["/usr/bin/touch", effect]);
      expect((await blockedBeforeLaunch.proof).reason).toBe("admission-busy");
      await blockedBeforeLaunch.closed;
      await expect(stat(effect)).rejects.toMatchObject({ code: "ENOENT" });
      first.control.write("launch\n");
      expect(await first.proof).toMatchObject({ exitCode: 0, cleanupFailed: false });
      const blockedAfterCompletion = launch({ ZERO_SMOLVM_ADMISSION_LOCK: lock }, ["/usr/bin/touch", effect]);
      expect((await blockedAfterCompletion.proof).reason).toBe("admission-busy");
      await blockedAfterCompletion.closed;
      await expect(stat(effect)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { first.control.end("release\n"); await first.closed; }
    const next = launch({ ZERO_SMOLVM_ADMISSION_LOCK: lock }, ["/usr/bin/touch", effect]);
    try {
      await next.ready; next.control.write("launch\n");
      expect(await next.proof).toMatchObject({ exitCode: 0, cleanupFailed: false });
      expect((await stat(effect)).isFile()).toBe(true);
    } finally { next.control.end("release\n"); await next.closed; }
  }, 10000);

  it("proves every owned family member dead after controller loss without killing a neighbor", async () => {
    const token = randomBytes(32).toString("hex");
    const result = join(root, "parent-result.json");
    const script = join(root, "controller.mjs");
    await writeFile(script, `import {spawn} from 'node:child_process';
const child=spawn(process.argv[2],[String(process.pid),process.argv[3],'--','/bin/sh','-c','echo main-ready; sleep 2'],{cwd:process.argv[5],env:{PATH:'/usr/bin:/bin',ZERO_SMOLVM_RUN_TOKEN:process.argv[4],ZERO_SMOLVM_WORKBENCH_RUN:process.argv[4],ZERO_SMOLVM_SUPERVISE_FAMILY:'1'},stdio:['ignore','pipe','ignore','pipe','pipe']});
child.stdout.pipe(process.stdout);
`);
    const controller = spawn(process.execPath, [script, binary, result, token, root], { stdio: ["ignore", "pipe", "pipe"] });
    const controllerReady = Promise.withResolvers<void>();
    controller.stdout!.once("data", () => controllerReady.resolve());
    const sibling = launch({ ZERO_SMOLVM_WORKBENCH_RUN: token }, ["/bin/sh", "-c", "echo sibling-ready; sleep 2"]);
    const neighbor = spawn("/bin/sleep", ["10"], { stdio: "ignore" });
    try {
      await Promise.all([controllerReady.promise, sibling.output]);
      controller.kill("SIGKILL");
      let mainProof: NativeProof | undefined;
      for (let attempt = 0; attempt < 40; attempt++) {
        try { mainProof = JSON.parse(await readFile(result, "utf8")) as NativeProof; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await delay(25);
      }
      expect(mainProof).toMatchObject({ cleanupFailed: false, reason: "parent-exited" });
      // The sibling's controller is still alive: its own parent-death watchdog
      // cannot explain this teardown. Only the primary's family census can.
      await sibling.closed;
      expect(sibling.child.exitCode).toBe(0);
      expect(await sibling.proof).toMatchObject({ cleanupFailed: false, cancelled: true });
      expect(neighbor.exitCode).toBeNull();
      expect(neighbor.signalCode).toBeNull();
      process.kill(neighbor.pid!, 0);
    } finally {
      controller.kill("SIGKILL"); sibling.control.end("cancel\n"); neighbor.kill("SIGTERM");
      await sibling.closed;
    }
  }, 10000);
});
