import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SMOLVM_DARWIN_SUPERVISOR_SOURCE } from "./smolvm-darwin-source.js";

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

  function launch(environment: Record<string, string>, command: string[]): NativeFixture {
    const child = spawn(binary, [String(process.pid), join(root, `result-${sequence++}.json`), "--", ...command], {
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
