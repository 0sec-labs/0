import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { assertSmolvmWorkbenchPlatform, privateSmolvmDirectory, resolveSmolvmRuntime, smolvmArchiveDigest } from "./smolvm-provision.js";
import type { SmolvmExecutionOptions, SmolvmExecutionResult } from "./smolvm.js";

export interface SmolvmDarwinOwnership { root: string; token: string; stateRoot?: string; }
/** Host-only sibling executor. The ordinary runSmolvm entry always passes false;
 * only the workbench broker's independently validated HTTP profile passes true.
 * Neither profile receives the workbench HOME, credentials or writable state. */
export async function runSmolvmDarwinProgram(options: SmolvmExecutionOptions, network: boolean, ownership?: SmolvmDarwinOwnership): Promise<SmolvmExecutionResult> {
  const started = performance.now();
  const result: SmolvmExecutionResult = { exitCode: null, stdout: "", stderr: "", durationMs: 0, timedOut: false };
  const lifetime = new AbortController();
  const forwardAbort = () => lifetime.abort(options.signal?.reason);
  let root: string | undefined;
  let launched = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    assertSmolvmWorkbenchPlatform();
    for (const [name, value, minimum, maximum] of [
      ["cpus", options.cpus, 1, 16], ["memoryMb", options.memoryMb, 32, 16384],
      ["storageGb", options.storageGb ?? 4, 1, 64], ["timeoutMs", options.timeoutMs, 100, 600000],
      ["maxOutputBytes", options.maxOutputBytes, 256, 16 * 1024 * 1024],
    ] as const) if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid SmolVM ${name}`);
    if (!options.command.length || !options.command[0] || options.command.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("SmolVM command requires a nonempty argv without NUL bytes");
    if (options.imageDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(options.imageDigest)) throw new Error("Invalid SmolVM archive digest");
    if (options.stdin !== undefined && (typeof options.stdin !== "string" || Buffer.byteLength(options.stdin) > 16 * 1024 * 1024)) throw new Error("SmolVM input exceeds 16 MiB or is not a string");
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (options.signal?.aborted) forwardAbort();
    lifetime.signal.throwIfAborted();
    timer = setTimeout(() => { result.timedOut = true; lifetime.abort(); }, options.timeoutMs);
    const runtime = await resolveSmolvmRuntime({ stateRoot: ownership?.stateRoot, signal: lifetime.signal });
    if (options.binary !== undefined && options.binary !== runtime.binary) throw new Error("Darwin execution requires the provisioned full signed SmolVM bundle");
    if (ownership) {
      if (!/^\/tmp\/0w-[A-Za-z0-9]+$/.test(ownership.root) || !/^[a-f0-9]{64}$/.test(ownership.token)) throw new Error("Invalid trusted workbench lifecycle ownership");
      await privateSmolvmDirectory(ownership.root);
    }
    root = await mkdtemp(ownership ? join(ownership.root, "s-") : "/tmp/0s-");
    await Promise.all(["h", "c", "d", "f", "r", "t"].map((directory) => mkdir(join(root!, directory), { mode: 0o700 })));
    const sourceInfo = await lstat(options.imageArchive);
    if (!sourceInfo.isFile() || sourceInfo.size <= 0 || sourceInfo.size > 8 * 1024 ** 3) throw new Error("SmolVM image requires a nonempty regular archive no larger than 8 GiB");
    const archive = join(root, "image.tar");
    await copyFile(options.imageArchive, archive, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    const digest = await smolvmArchiveDigest(archive, lifetime.signal);
    if (options.imageDigest && digest !== options.imageDigest) throw new Error("SmolVM archive identity mismatch");
    const args = ["machine", "run", "--image", archive, "--max-image-size", "8GiB", "--unprivileged", "--user", `${process.getuid!()}:${process.getgid!()}`,
      "--cpus", String(options.cpus), "--mem", String(options.memoryMb), "--storage", String(options.storageGb ?? 4), "--overlay", "1", "--interactive"];
    if (network) args.push("--net");
    const targets = new Set<string>();
    for (const mount of options.mounts ?? []) {
      const source = await realpath(mount.source);
      if (source.includes(":") || source.includes("\0") || !isAbsolute(mount.target) || posix.normalize(mount.target) !== mount.target
        || mount.target === "/" || /[:\0]/.test(mount.target) || targets.has(mount.target)) throw new Error("Invalid or duplicate SmolVM read-only mount");
      targets.add(mount.target); args.push("--volume", `${source}:${mount.target}:ro`);
    }
    args.push("--", ...options.command);
    lifetime.signal.throwIfAborted();
    const token = randomBytes(32).toString("hex");
    const child = spawn(runtime.supervisor, [String(process.pid), join(root, "complete.json"), "--", runtime.binary, ...args], {
      cwd: root, env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(root, "h"), XDG_CACHE_HOME: join(root, "c"),
        XDG_DATA_HOME: join(root, "d"), XDG_CONFIG_HOME: join(root, "f"), XDG_RUNTIME_DIR: join(root, "r"), TMPDIR: join(root, "t"),
        SMOLVM_LIB_DIR: join(runtime.bundleRoot, "lib"), DYLD_LIBRARY_PATH: join(runtime.bundleRoot, "lib"),
        SMOLVM_AGENT_ROOTFS: join(runtime.bundleRoot, "agent-rootfs"), ZERO_SMOLVM_RUN_TOKEN: token,
        ...(ownership ? { ZERO_SMOLVM_WORKBENCH_RUN: ownership.token } : {}),
      }, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    const control = child.stdio[3] as Writable;
    const proofStream = child.stdio[4] as Readable;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, prefix = Buffer.alloc(0);
    let banner = false, settled = false, protocol = "", protocolError = false;
    const decoder = options.channel ? new StringDecoder("utf8") : undefined;
    const stop = (reason: string) => { result.error ??= reason; if (!control.destroyed) control.end("cancel\n"); };
    const abort = () => stop(result.timedOut ? "SmolVM execution timed out" : "SmolVM execution cancelled by operator");
    const collect = (chunk: Buffer, destination: Buffer[], count: number): number => {
      const keep = chunk.subarray(0, Math.max(0, options.maxOutputBytes - count));
      if (keep.length) destination.push(keep);
      if (count + chunk.length > options.maxOutputBytes) stop("SmolVM output exceeded its byte limit");
      return count + keep.length;
    };
    control.on("error", () => { /* Native completion proof decides teardown. */ });
    proofStream.on("data", (chunk: Buffer) => { if (protocol.length + chunk.length > 4096) protocolError = true; else protocol += chunk.toString("utf8"); });
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes = collect(chunk, stdout, stdoutBytes);
      if (options.channel && !result.error) {
        try { options.channel.onData(decoder!.write(chunk)); }
        catch (error) { stop(`Channel callback failed: ${String(error)}`); }
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (!banner) {
        prefix = Buffer.concat([prefix, chunk]);
        const newline = prefix.indexOf(10);
        if (newline < 0 && prefix.length <= 4096) return;
        if (newline < 0 || !/^Starting ephemeral machine \(vm-[a-f0-9]+\)\.\.\.\r?\n$/.test(prefix.subarray(0, newline + 1).toString("utf8"))) {
          stderrBytes = collect(prefix, stderr, stderrBytes); prefix = Buffer.alloc(0);
          stop("SmolVM did not establish the qualified ephemeral protocol"); return;
        }
        banner = true; chunk = prefix.subarray(newline + 1); prefix = Buffer.alloc(0);
      }
      stderrBytes = collect(chunk, stderr, stderrBytes);
    });
    child.stdin!.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") stop(`SmolVM input delivery failed: ${error.message}`); });
    const closure = Promise.withResolvers<void>();
    child.on("spawn", () => { launched = true; });
    child.on("error", (error) => { result.error ??= `Native SmolVM launch failed: ${error.message}`; });
    child.on("close", () => { settled = true; closure.resolve(); });
    lifetime.signal.addEventListener("abort", abort, { once: true });
    if (lifetime.signal.aborted) abort();
    else if (options.channel) {
      const writer = (data: string) => { if (!settled && !result.error && child.stdin!.writable && !child.stdin!.destroyed) child.stdin!.write(data); };
      try { if (options.channel.initialInput) writer(options.channel.initialInput); options.channel.onReady(writer); }
      catch (error) { stop(`Channel callback failed: ${String(error)}`); }
    } else child.stdin!.end(options.stdin ?? "");
    await closure.promise;
    lifetime.signal.removeEventListener("abort", abort);
    if (prefix.length) stderrBytes = collect(prefix, stderr, stderrBytes);
    result.stdout = Buffer.concat(stdout, stdoutBytes).toString("utf8");
    result.stderr = Buffer.concat(stderr, stderrBytes).toString("utf8");
    if (launched) {
      const proof = protocolError ? undefined : JSON.parse(protocol) as { schemaVersion?: number; exitCode?: number; cleanupFailed?: boolean };
      if (proof?.schemaVersion !== 1 || !Number.isInteger(proof.exitCode) || typeof proof.cleanupFailed !== "boolean") throw new Error("Missing or invalid native teardown proof");
      result.exitCode = proof.exitCode! < 0 ? null : proof.exitCode!;
      result.cleanupFailed = proof.cleanupFailed;
      if (proof.cleanupFailed) result.error = `Native SmolVM teardown unconfirmed; state retained at ${root}`;
      if (!banner) result.error ??= "SmolVM launcher failed before guest execution";
    }
  } catch (error) {
    result.error = lifetime.signal.aborted ? result.timedOut ? "SmolVM execution timed out" : "SmolVM execution cancelled by operator" : error instanceof Error ? error.message : String(error);
    if (launched) result.cleanupFailed = true;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
    if (root && !result.cleanupFailed) await rm(root, { recursive: true, force: true }).catch((error: unknown) => { result.cleanupFailed = true; result.error = `SmolVM state cleanup failed: ${String(error)}`; });
    result.durationMs = performance.now() - started;
  }
  return result;
}
