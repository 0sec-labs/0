import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, availableParallelism, totalmem } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { snapshotSmolvmWorkspace, exportSmolvmWorkbenchArtifacts, type SmolvmWorkspaceLimits, type SmolvmWorkspaceManifest } from "./smolvm-workspace.js";
import {
  approvedSmolvmWorkbenchImage, assertSmolvmWorkbenchPlatform, getSmolvmWorkbenchStatus,
  privateSmolvmDirectory, resolveSmolvmRuntime, smolvmArchiveDigest,
} from "./smolvm-provision.js";
import type { SmolvmRuntime } from "./smolvm-provision.js";
import { startWorkbenchBroker } from "./smolvm-broker.js";
import type { WorkbenchBrokerController } from "./smolvm-broker.js";

export interface SmolvmWorkbenchApprovedImage { reference: string; archive: string; digest: string; }
export interface SmolvmWorkbenchTransport {
  initialInput?: string;
  onReady?: (input: { write(data: string): void; end(): void }) => void;
  onStdout(data: string): void;
  onStderr?: (data: string) => void;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}
export interface SmolvmWorkbenchOptions {
  image: string;
  workspaceRoot: string;
  stateRoot: string;
  command: readonly string[];
  environment: Readonly<Record<string, string>>;
  network: boolean;
  tty: boolean;
  cpus: number;
  memoryMb: number;
  storageGb: number;
  approvedImages?: readonly SmolvmWorkbenchApprovedImage[];
  signal?: AbortSignal;
  /** Controller mode copies source and uses private per-run HOME/state. */
  workspaceMode?: "shared" | "snapshot";
  snapshotLimits?: Partial<SmolvmWorkspaceLimits>;
  /** Unmounted private host destination; source changes are never applied automatically. */
  artifactDirectory?: string;
  /** Host-selected code/assets only; guest/model cannot select host mount paths. */
  readOnlyMounts?: readonly { source: string; target: string }[];
  /** Omitted: existing terminal inheritance. Present: bounded controller pipes. */
  transport?: SmolvmWorkbenchTransport;
}
export interface SmolvmWorkbenchResult {
  exitCode: number | null;
  timedOut: boolean;
  cleanupFailed: boolean;
  error?: string;
  artifacts?: { directory: string; workspace: SmolvmWorkspaceManifest; state: SmolvmWorkspaceManifest };
}
interface SupervisorResult { schemaVersion: number; exitCode: number; cleanupFailed: boolean; cancelled: boolean; reason: string; }
function inside(path: string, parent: string): boolean {
  const suffix = relative(parent, path);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
}
async function workspaceGrant(path: string, stateRoot: string): Promise<string> {
  if (!isAbsolute(path) || /[:\0]/.test(path)) throw new Error("Workbench workspace must be an explicit absolute directory");
  const workspace = await realpath(path);
  if (!(await lstat(workspace)).isDirectory()) throw new Error("Workbench workspace must be a directory");
  const home = await realpath(homedir());
  if (inside(home, workspace) || workspace === "/" || inside(stateRoot, workspace)
    || [".ssh", ".0", ".codex", ".docker", ".config", "Library"].some((directory) => inside(workspace, join(home, directory)))) {
    throw new Error("Workbench workspace cannot grant universal HOME, private credentials, runtime state or system directories");
  }
  if (["/etc", "/private/etc", "/var", "/private/var", "/System", "/Library", "/usr", "/bin", "/sbin", "/dev"].some((directory) => inside(workspace, directory))) {
    throw new Error("Workbench workspace cannot grant protected host directories or sockets");
  }
  return workspace;
}
function validate(options: SmolvmWorkbenchOptions): void {
  assertSmolvmWorkbenchPlatform();
  for (const [name, value, min, max] of [
    ["cpus", options.cpus, 1, Math.min(16, availableParallelism())],
    ["memoryMb", options.memoryMb, 256, Math.min(16384, Math.floor(totalmem() / 1024 ** 2 / 2))],
    ["storageGb", options.storageGb, 1, 64],
  ] as const) if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid workbench ${name}: expected ${min}..${max}`);
  if (typeof options.network !== "boolean" || typeof options.tty !== "boolean") throw new Error("Workbench network and tty must be explicit booleans");
  if (!options.command.length || !options.command[0] || options.command.length > 512 || options.command.some((argument) => typeof argument !== "string" || argument.includes("\0"))) throw new Error("Workbench command requires a nonempty argv without NUL bytes");
  if (!isAbsolute(options.command[0]!)) throw new Error("Workbench command must select an absolute guest executable, not a host PATH lookup");
  for (const [key, value] of Object.entries(options.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 1024 * 1024) throw new Error("Invalid workbench environment grant");
    if (/^(?:SMOLVM_|ZERO_SMOLVM_|LD_|DYLD_)/.test(key) || ["HOME", "PATH", "ZERO_WORKBENCH_INNER", "ZERO_WORKBENCH_RUNTIME_ID"].includes(key)) throw new Error(`Workbench launcher/guest identity environment cannot be overridden: ${key}`);
  }
  if (options.workspaceMode !== undefined && !["shared", "snapshot"].includes(options.workspaceMode)) throw new Error("Invalid workbench workspace mode");
  if (options.workspaceMode === "snapshot" && !options.artifactDirectory) throw new Error("Snapshot workbench requires an explicit artifact directory");
  if (options.artifactDirectory && options.workspaceMode !== "snapshot") throw new Error("Artifact export requires snapshot workspace mode");
  if (options.transport) {
    if (options.tty) throw new Error("Controller pipe transport cannot use terminal mode");
    for (const [name, value, maximum] of [["maxInputBytes", options.transport.maxInputBytes ?? 32 * 1024 * 1024, 64 * 1024 * 1024], ["maxOutputBytes", options.transport.maxOutputBytes ?? 64 * 1024 * 1024, 64 * 1024 * 1024]] as const) {
      if (!Number.isSafeInteger(value) || value < 1024 || value > maximum) throw new Error(`Invalid workbench transport ${name}`);
    }
    if (typeof options.transport.onStdout !== "function") throw new Error("Workbench transport requires a stdout handler");
    if (options.transport.initialInput !== undefined && (typeof options.transport.initialInput !== "string" || Buffer.byteLength(options.transport.initialInput) > (options.transport.maxInputBytes ?? 32 * 1024 * 1024))) throw new Error("Workbench initial input exceeds its limit");
  }
  if ((options.readOnlyMounts?.length ?? 0) > 8) throw new Error("Workbench permits at most eight readonly asset mounts");
  const targets = new Set<string>();
  for (const mount of options.readOnlyMounts ?? []) {
    if (!isAbsolute(mount.source) || !isAbsolute(mount.target) || resolve(mount.target) !== mount.target || /[:\0]/.test(mount.target) || [...targets].some(target => inside(target, mount.target) || inside(mount.target, target))
      || mount.target === "/" || ["/workspace", "/home/zero", "/run/0-workbench"].some(path => inside(path, mount.target) || inside(mount.target, path))) throw new Error("Invalid or overlapping readonly workbench mount");
    targets.add(mount.target);
  }
  if ((options.approvedImages?.length ?? 0) > 32) throw new Error("Workbench permits at most 32 explicitly approved sandbox images");
  const references = new Set<string>();
  for (const image of options.approvedImages ?? []) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*@sha256:[a-f0-9]{64}$/.test(image.reference) || references.has(image.reference)
      || !/^sha256:[a-f0-9]{64}$/.test(image.digest)) throw new Error("Sandbox image catalog requires unique immutable OCI references and archive digests");
    references.add(image.reference);
  }
}
function launcherEnvironment(runtime: SmolvmRuntime, root: string, token: string): NodeJS.ProcessEnv {
  // Deliberately no operator HOME, ssh-agent, Docker socket, registry config,
  // shell startup hooks, proxy or guest-selected executable/library paths.
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(root, "h"),
    XDG_CACHE_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"),
    XDG_CONFIG_HOME: join(root, "f"), XDG_RUNTIME_DIR: join(root, "r"), TMPDIR: join(root, "t"),
    SMOLVM_LIB_DIR: join(runtime.bundleRoot, "lib"), DYLD_LIBRARY_PATH: join(runtime.bundleRoot, "lib"),
    SMOLVM_AGENT_ROOTFS: join(runtime.bundleRoot, "agent-rootfs"), ZERO_SMOLVM_RUN_TOKEN: token,
    ZERO_SMOLVM_WORKBENCH_RUN: token, ZERO_SMOLVM_SUPERVISE_FAMILY: "1",
    ...(process.env.TERM ? { TERM: process.env.TERM } : {}),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
  };
}
function supervisorResult(value: unknown): SupervisorResult {
  if (!value || typeof value !== "object") throw new Error("Missing native teardown proof");
  const result = value as SupervisorResult;
  if (result.schemaVersion !== 1 || !Number.isInteger(result.exitCode) || result.exitCode < -1 || result.exitCode > 255
    || typeof result.cleanupFailed !== "boolean" || typeof result.cancelled !== "boolean" || typeof result.reason !== "string") throw new Error("Invalid native teardown proof");
  return result;
}
async function recoverCompletedRun(stateRoot: string): Promise<void> {
  const leasePath = join(stateRoot, "active-run.json");
  let lease: { root?: string; token?: string };
  try { lease = JSON.parse(await readFile(leasePath, "utf8")) as typeof lease; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!lease.root || !/^\/tmp\/0w-[A-Za-z0-9]+$/.test(lease.root) || !lease.token || !/^[a-f0-9]{64}$/.test(lease.token)) throw new Error("Invalid retained workbench admission record; inspect it before admitting another guest");
  // Only the surviving native supervisor can write this unmounted private
  // completion proof after a controller death. Missing/failed proof is retained.
  try {
    const proof = supervisorResult(JSON.parse(await readFile(join(lease.root, "complete.json"), "utf8")));
    if (proof.cleanupFailed) throw new Error("Native teardown was not confirmed");
    await rm(lease.root, { recursive: true, force: true });
    await rm(leasePath);
  } catch (error) { throw new Error(`Workbench admission remains reserved; inspect ${lease.root}: ${String(error)}`); }
}
/** One full online workbench, not an offline evolution worker. Every command,
 * browser and child agent is inside the VM. No engine or host fallback exists. */
export async function runSmolvmWorkbench(options: SmolvmWorkbenchOptions): Promise<SmolvmWorkbenchResult> {
  const result: SmolvmWorkbenchResult = { exitCode: null, timedOut: false, cleanupFailed: false };
  let root: string | undefined;
  let launched = false;
  let admitted = false;
  let nativeCleanupConfirmed = false;
  let control: Writable | undefined;
  let closed: Promise<void> | undefined;
  let broker: WorkbenchBrokerController | undefined;
  let privateWorkspace: string | undefined;
  let privateState: string | undefined;
  const lifetime = new AbortController();
  const forwardAbort = () => lifetime.abort(options.signal?.reason);
  try {
    validate(options);
    // Keep one lifetime listener through archive streams and native launch.
    // Stream cleanup must not cancel an operator's AbortSignal.timeout timer.
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (options.signal?.aborted) forwardAbort();
    lifetime.signal.throwIfAborted();
    await privateSmolvmDirectory(options.stateRoot);
    if (resolve(options.stateRoot) !== await realpath(options.stateRoot)) throw new Error("Workbench state path must not traverse symlinks");
    const sourceWorkspace = await workspaceGrant(options.workspaceRoot, options.stateRoot);
    const assets = await Promise.all((options.readOnlyMounts ?? []).map(async mount => ({ source: await workspaceGrant(mount.source, options.stateRoot), target: mount.target })));
    const status = await getSmolvmWorkbenchStatus({ stateRoot: options.stateRoot, image: options.image });
    if (!status.runtimeReady || !status.imageApproved) throw new Error("Workbench runtime/image prerequisites are missing; run explicit workbench setup first");
    const image = await approvedSmolvmWorkbenchImage(options.image, options.stateRoot, lifetime.signal);
    for (const sandboxImage of options.approvedImages ?? []) {
      const approved = await approvedSmolvmWorkbenchImage(sandboxImage.archive, options.stateRoot, lifetime.signal);
      if (approved.digest !== sandboxImage.digest) throw new Error("Sandbox image catalog archive identity mismatch");
    }
    const runtime = await resolveSmolvmRuntime({ stateRoot: options.stateRoot, signal: lifetime.signal });

    // macOS sockaddr_un has a short path limit: persistent operator paths
    // cannot be the VM's HOME/cache/socket namespace.
    root = await mkdtemp("/tmp/0w-");
    await Promise.all(["h", "c", "d", "f", "r", "t", "admission"].map((entry) => mkdir(join(root!, entry), { mode: 0o700 })));
    await mkdir(join(root, "admission", "broker"), { mode: 0o700 });
    const runRoot = await realpath(root);
    const guestState = options.workspaceMode === "snapshot" ? join(runRoot, "guest-state") : join(options.stateRoot, "guest-state");
    const guestHome = options.workspaceMode === "snapshot" ? join(runRoot, "guest-home") : join(options.stateRoot, "guest-home");
    await privateSmolvmDirectory(guestState);
    await privateSmolvmDirectory(guestHome);
    let workspace = sourceWorkspace;
    if (options.workspaceMode === "snapshot") {
      privateWorkspace = join(runRoot, "workspace"); privateState = guestState;
      await snapshotSmolvmWorkspace(sourceWorkspace, privateWorkspace, options.snapshotLimits, lifetime.signal);
      workspace = privateWorkspace;
    }
    const archive = join(root, "image.tar");
    await copyFile(image.path, archive, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await chmod(archive, 0o400);
    if (await smolvmArchiveDigest(archive, lifetime.signal) !== image.digest) throw new Error("Approved workbench archive changed during private staging");
    const token = randomBytes(32).toString("hex");
    broker = await startWorkbenchBroker({
      root: join(await realpath(root), "broker-private"), imageArchive: image.path, imageDigest: image.digest,
      ownership: { root, token, stateRoot: options.stateRoot },
      runtimeId: token, approvedImages: options.approvedImages, allowHttp: options.network,
      storageGb: options.storageGb,
    });
    await writeFile(join(root, "admission", "admission.json"), JSON.stringify({
      schemaVersion: 1, profile: "smolvm-workbench", runtimeId: token, broker: broker.admission,
    }), { flag: "wx", mode: 0o444 });
    // Virtiofs preserves host ownership. Match the non-root operator's numeric
    // identity rather than chmod'ing their workspace for image UID 1000.
    const args = ["machine", "run", "--image", archive, "--max-image-size", "8GiB", "--unprivileged", "--user", `${process.getuid!()}:${process.getgid!()}`,
      "--cpus", String(options.cpus), "--mem", String(options.memoryMb), "--storage", String(options.storageGb), "--overlay", "1",
      "--workdir", "/workspace", "--interactive", "--volume", `${workspace}:/workspace:rw`,
      "--volume", `${guestHome}:/home/zero:rw`, "--volume", `${guestState}:/home/zero/.0:rw`,
      "--volume", `${join(root, "admission")}:/run/0-workbench:ro`,
      "--volume", `${broker.guestRoot}:/run/0-workbench/broker:rw`,
      "--env", "HOME=/home/zero", "--env", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"];
    for (const mount of assets) args.push("--volume", `${mount.source}:${mount.target}:ro`);
    if (options.network) args.push("--net");
    if (options.tty) args.push("--tty");
    args.push("--env", `ZERO_WORKBENCH_RUNTIME_ID=${token}`);
    for (const [key, value] of Object.entries(options.environment)) args.push("--env", `${key}=${value}`);
    args.push("--", ...options.command);
    lifetime.signal.throwIfAborted();
    const child = spawn(runtime.supervisor, [String(process.pid), join(root, "complete.json"), "--", runtime.binary, ...args], {
      cwd: root, env: { ...launcherEnvironment(runtime, root, token), ZERO_SMOLVM_ADMISSION_LOCK: join(options.stateRoot, "native-admission.lock") },
      stdio: options.transport ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit", "pipe", "pipe"],
    });
    control = child.stdio[3] as Writable;
    const proofStream = child.stdio[4] as Readable;
    const completion = Promise.withResolvers<void>();
    const readiness = Promise.withResolvers<boolean>();
    const closure = Promise.withResolvers<void>();
    closed = closure.promise;
    let protocol = "";
    let protocolError = false;
    let cancellationSent = false;
    const cancel = () => {
      result.timedOut = options.signal?.reason instanceof Error && options.signal.reason.name === "TimeoutError";
      if (!cancellationSent && control && !control.destroyed) { cancellationSent = true; control.write("cancel\n"); }
    };
    if (options.transport) {
      const transport = options.transport;
      let inputBytes = 0, outputBytes = 0;
      const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
      const fail = (message: string) => { result.error ??= message; cancel(); };
      const input = {
        write(data: string) {
          if (lifetime.signal.aborted || !child.stdin || child.stdin.destroyed) throw new Error("Workbench controller input is closed");
          if (typeof data !== "string") throw new Error("Workbench controller input must be a string");
          const bytes = Buffer.byteLength(data);
          if (inputBytes + bytes > (transport.maxInputBytes ?? 32 * 1024 * 1024) || child.stdin.writableLength + bytes > 8 * 1024 * 1024) { fail("Workbench controller input exceeds its byte limit"); throw new Error("Workbench controller input exceeds its byte limit"); }
          inputBytes += bytes; child.stdin.write(data);
        },
        end() { child.stdin?.end(); },
      };
      child.stdin!.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") fail(`Workbench stdin failed: ${String(error)}`); });
      for (const [stream, decoder, callback] of [[child.stdout!, stdoutDecoder, transport.onStdout], [child.stderr!, stderrDecoder, transport.onStderr]] as const) {
        stream.on("data", (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > (transport.maxOutputBytes ?? 64 * 1024 * 1024)) { fail("Workbench controller output exceeds its byte limit"); return; }
          const data = decoder.write(chunk);
          if (data && callback) try { callback(data); } catch (error) { fail(`Workbench controller callback failed: ${String(error)}`); }
        });
        stream.on("end", () => { const final = decoder.end(); if (final && callback) try { callback(final); } catch (error) { fail(`Workbench controller callback failed: ${String(error)}`); } });
      }
      try { if (transport.initialInput) input.write(transport.initialInput); transport.onReady?.(input); }
      catch (error) { fail(`Workbench controller initialization failed: ${String(error)}`); }
    }
    control.on("error", () => { /* Completion proof, not a broken pipe, decides cleanup. */ });
    proofStream.on("data", (chunk: Buffer) => {
      if (protocol.length + chunk.length > 4096) { protocolError = true; completion.resolve(); return; }
      protocol += chunk.toString("utf8");
      if (protocol.startsWith("READY\n")) { protocol = protocol.slice(6); readiness.resolve(true); }
      if (protocol.includes("\n")) { readiness.resolve(false); completion.resolve(); }
    });
    child.on("spawn", () => { launched = true; });
    child.on("error", (error) => { result.error = `Native workbench launch failed: ${error.message}`; });
    child.on("close", () => { readiness.resolve(false); completion.resolve(); closure.resolve(); });
    lifetime.signal.addEventListener("abort", cancel, { once: true });
    process.on("SIGTERM", cancel); process.on("SIGHUP", cancel); process.on("SIGINT", cancel);
    if (lifetime.signal.aborted) cancel();
    try {
      if (await readiness.promise) {
        try {
          lifetime.signal.throwIfAborted();
          // Kernel flock serializes recovery, reservation, VM lifetime and
          // lease removal, including competing controllers after a host death.
          await recoverCompletedRun(options.stateRoot);
          const lease = await open(join(options.stateRoot, "active-run.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          admitted = true;
          try { await lease.writeFile(JSON.stringify({ schemaVersion: 1, root, token, cpus: options.cpus, memoryMb: options.memoryMb, storageGb: options.storageGb })); await lease.sync(); }
          finally { await lease.close(); }
          lifetime.signal.throwIfAborted();
          control.write("launch\n");
        } catch (error) { result.error = error instanceof Error ? error.message : String(error); cancel(); }
      }
      await completion.promise;
    }
    finally {
      lifetime.signal.removeEventListener("abort", cancel);
      process.removeListener("SIGTERM", cancel); process.removeListener("SIGHUP", cancel); process.removeListener("SIGINT", cancel);
    }
    if (launched) {
      const proof = supervisorResult(protocolError ? null : JSON.parse(protocol));
      result.exitCode = proof.exitCode < 0 ? null : proof.exitCode;
      nativeCleanupConfirmed = !proof.cleanupFailed;
      result.cleanupFailed = proof.cleanupFailed;
      if (proof.cleanupFailed) result.error = `Native workbench teardown unconfirmed; admission/state retained at ${root}`;
      else if (proof.cancelled) result.error ??= result.timedOut ? "Workbench deadline expired" : "Workbench cancelled";
      else if (proof.reason === "admission-busy") result.error = "Another native workbench holds the resource reservation";
      else if (proof.exitCode < 0) result.error ??= "Workbench launcher terminated without a guest exit status";
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.timedOut ||= options.signal?.reason instanceof Error && options.signal.reason.name === "TimeoutError";
    if (launched && !nativeCleanupConfirmed) result.cleanupFailed = true;
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
    if (broker) {
      try { await broker.close(); }
      catch (error) { result.cleanupFailed = true; result.error = `Workbench sibling teardown unconfirmed; admission/state retained at ${root}: ${String(error)}`; }
    }
    if (!result.cleanupFailed && nativeCleanupConfirmed && privateWorkspace && privateState && options.artifactDirectory) {
      try {
        const artifacts = await exportSmolvmWorkbenchArtifacts(privateWorkspace, privateState, options.artifactDirectory, options.snapshotLimits);
        result.artifacts = { directory: join(options.artifactDirectory, "artifacts"), ...artifacts };
      } catch (error) { result.error = `Workbench artifact export failed: ${String(error)}`; }
    }
    // A missing protocol or uncertain process census never releases admission.
    if (!result.cleanupFailed) {
      if (root) await rm(root, { recursive: true, force: true }).catch((error: unknown) => { result.cleanupFailed = true; result.error = `Workbench state cleanup failed: ${String(error)}`; });
      if (admitted && !result.cleanupFailed) await rm(join(options.stateRoot, "active-run.json")).catch((error: unknown) => { result.cleanupFailed = true; result.error = `Workbench admission release failed: ${String(error)}`; });
    }
    if (control && !control.destroyed) control.end("release\n");
    await closed;
  }
  return result;
}
