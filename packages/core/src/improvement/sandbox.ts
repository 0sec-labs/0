import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { canonicalEvolutionJson, parseEvolutionConfig } from "./config.js";
import { verifyEvolutionSnapshot } from "./registry.js";
import { allowlistedChildEnv } from "../agent/sanitized-env.js";
import { resolveSmolvmImage, runSmolvm } from "../runtime/smolvm.js";
import { withWorkerAdmission } from "../runtime/worker-admission.js";
import type { EvolutionConfig, EvolutionExecution, EvolutionSandbox } from "./types.js";

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTROL_TIMEOUT_MS = 5000;

const probeDockerAccess = promisify(execFile);

/** Refresh an already-granted Linux group only for the default local socket.
 * Never use a Docker failure as permission to execute generated code on host.
 * Recheck each invocation: account membership and Docker context can change
 * while the console remains open.
 */
async function withDockerRecovery(binary: string, args: string[], signal?: AbortSignal): Promise<{ binary: string; args: string[] }> {
  signal?.throwIfAborted();
  const direct = { binary, args };
  if (binary !== "docker" || process.platform !== "linux") return direct;
  const host = process.env.DOCKER_HOST;
  if (process.env.DOCKER_CONTEXT || (host && host !== "unix:///var/run/docker.sock" && host !== "unix:///run/docker.sock")) return direct;
  if (!process.getuid || !process.getgid || !process.getgroups || process.getuid() === 0) return direct;
  const socketPath = host?.slice(7) || "/var/run/docker.sock";
  const options = { env: dockerEnvironment(), timeout: CONTROL_TIMEOUT_MS, encoding: "utf8" as const, maxBuffer: 65536, signal };
  let group: string;
  try {
    const socket = await stat(socketPath);
    if (!socket.isSocket() || socket.uid === process.getuid() || !(socket.mode & 0o020) || (socket.mode & 0o002)) return direct;
    if (process.getgid() === socket.gid || process.getgroups().includes(socket.gid)) return direct;
    const membership = await probeDockerAccess("id", ["-G", "--", userInfo().username], options);
    if (!membership.stdout.trim().split(/\s+/).includes(String(socket.gid))) return direct;
    // A persisted currentContext can select a remote daemon even without an
    // environment override. Inspecting context metadata never opens the socket.
    const context = await probeDockerAccess("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], options);
    if (!["unix:///var/run/docker.sock", "unix:///run/docker.sock"].includes(context.stdout.trim())) return direct;
    const record = await probeDockerAccess("getent", ["group", String(socket.gid)], options);
    const [name, , gid] = record.stdout.trim().split(":");
    if (!name || gid !== String(socket.gid) || !/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(name)) return direct;
    group = name;
  } catch {
    signal?.throwIfAborted();
    // Inconclusive identity probes do not grant anything; let Docker report
    // its real connection failure through the ordinary control path.
    return direct;
  }
  let sg: string;
  try {
    sg = (await probeDockerAccess("which", ["sg"], options)).stdout.trim();
    if (!sg) throw new Error("sg unavailable");
  } catch {
    signal?.throwIfAborted();
    throw new Error(`Docker socket access is granted to your account but absent from this process. Install sg (shadow-utils), or launch 0dev from a shell with the ${group} group active. No host-execution fallback was used.`);
  }
  return { binary: sg, args: [group, "-c", `exec ${quoteCommand([binary, ...args])}`] };
}

// Node >=24 supplies this API; the repository's ES2022 lib omits its type.
const deferredPromise = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void };
};

function dockerEnvironment(): NodeJS.ProcessEnv {
  const env = allowlistedChildEnv();
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "XDG_RUNTIME_DIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function killDockerProcessTree(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function control(binary: string, args: string[], timeout: number, signal?: AbortSignal): Promise<string> {
  const deadline = AbortSignal.timeout(timeout);
  const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const { binary: actualBinary, args: actualArgs } = await withDockerRecovery(binary, args, operationSignal);
  operationSignal.throwIfAborted();
  const { promise, resolve, reject } = deferredPromise.withResolvers<string>();
  // execFile does not forward detached to spawn. Use a real process-group
  // leader so a supervising sg process cannot leave descendants holding pipes.
  const child = spawn(actualBinary, actualArgs, {
    env: dockerEnvironment(), detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let failure: Error | undefined;
  const stop = () => {
    try { killDockerProcessTree(child); }
    catch (error) { reject(error); }
  };
  const collect = (chunk: string, errorStream: boolean) => {
    if (failure) return;
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > 65536) {
      failure = new Error(`Docker ${args[0]} exceeded the control output limit`);
      stop();
      return;
    }
    if (errorStream) stderr += chunk;
    else stdout += chunk;
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => collect(chunk, false));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => collect(chunk, true));
  child.once("error", reject);
  child.once("exit", stop);
  child.once("close", (code, exitSignal) => {
    if (failure) reject(failure);
    else if (code !== 0) reject(new Error(`Docker ${args[0]} failed: ${stderr.trim() || exitSignal || `exit ${code}`}`));
    else resolve(stdout.trim());
  });
  const abort = () => {
    failure ??= new Error(`Docker ${args[0]} cancelled: ${String(operationSignal.reason)}`);
    stop();
  };
  operationSignal.addEventListener("abort", abort, { once: true });
  if (operationSignal.aborted) abort();
  try {
    return await promise;
  } finally {
    operationSignal.removeEventListener("abort", abort);
    child.removeListener("exit", stop);
  }
}

/** Resolve a locally installed image; never pull or substitute a mutable image. */
export async function resolveEvolutionImage(image: string, dockerBinary = "docker"): Promise<string> {
  if (typeof image !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(image)) {
    throw new Error("invalid evolution image reference");
  }
  const id = await control(dockerBinary, ["image", "inspect", "--format", "{{.Id}}", image], CONTROL_TIMEOUT_MS);
  if (!IMAGE_ID.test(id)) throw new Error("Docker did not return an immutable image identity");
  return id;
}

function quoteCommand(argv: string[]): string {
  return argv.map((argument) => `'${argument.replace(/'/g, `'\\''`)}'`).join(" ");
}

function workerScript(config: Pick<EvolutionConfig, "command" | "buildCommand">, workspace = "/workspace"): string {
  return [
    "set -eu",
    `mkdir -p ${quoteCommand([workspace])}`,
    `cd ${quoteCommand([workspace])}`,
    `cp -R /snapshot/. ${quoteCommand([workspace])}/`,
    `chmod -R u+rwX ${quoteCommand([workspace])}`,
    ...(config.buildCommand ? [`${quoteCommand(config.buildCommand)} >&2`] : []),
    `exec ${quoteCommand(config.command)}`,
  ].join("\n");
}

/** Source executes only inside a fresh non-root, networkless container. */
export type SandboxProgramConfig = Pick<EvolutionConfig,
  "backend" | "image" | "imageArchive" | "command" | "buildCommand" |
  "timeoutMs" | "memoryMb" | "cpus" | "maxOutputBytes">;

type ProgramRequest = Omit<Parameters<EvolutionSandbox>[0], "config"> & { config: SandboxProgramConfig };

export function createDockerEvolutionSandbox(dockerBinary = "docker"): EvolutionSandbox {
  return (request) => withWorkerAdmission(
    { memoryMb: request.config.memoryMb, cpus: request.config.cpus, timeoutMs: request.config.timeoutMs },
    request.signal,
    async (admissionSignal: AbortSignal) =>
      runDockerSnapshot({ ...request, config: parseEvolutionConfig(request.config), signal: admissionSignal }, dockerBinary),
  );
}

async function runDockerSnapshot(
  { snapshot, config, input, signal, channel }: ProgramRequest,
  dockerBinary = "docker",
): Promise<EvolutionExecution> {
    signal?.throwIfAborted();
    if (typeof process.getuid !== "function" || typeof process.getgid !== "function" || process.getuid() === 0) {
      throw new Error("evolution workers require a non-root POSIX host user");
    }
    verifyEvolutionSnapshot(snapshot);
    if (snapshot.root.includes(",")) throw new Error("snapshot path cannot contain a Docker mount separator");
    const stdin = canonicalEvolutionJson(input);
    const image = IMAGE_ID.test(config.image) ? config.image : await resolveEvolutionImage(config.image, dockerBinary);
    const name = `0-evolution-${randomUUID()}`;
    const uid = process.getuid();
    const gid = process.getgid();
    const start = performance.now();
    let attemptedCreate = false;
    let execution: EvolutionExecution = { exitCode: null, stdout: "", stderr: "", durationMs: 0, timedOut: false };
    try {
      // Creation completes before start: cancellation can remove a known named
      // container instead of racing an in-flight `docker run` creation request.
      attemptedCreate = true;
      await control(dockerBinary, [
        "create", "--name", name, "--pull", "never", "--interactive", "--init",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--pids-limit", "64", "--memory", `${config.memoryMb}m`, "--memory-swap", `${config.memoryMb}m`,
        "--cpus", String(config.cpus), "--network", "none", "--user", `${uid}:${gid}`,
        "--workdir", "/workspace", "--mount", `type=bind,src=${snapshot.root},dst=/snapshot,ro`,
        "--tmpfs", `/workspace:rw,nosuid,nodev,mode=0700,uid=${uid},gid=${gid},size=${config.memoryMb}m`,
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
        image, "/bin/sh", "-c", workerScript(config),
      ], Math.min(config.timeoutMs, 30000), signal);
      signal?.throwIfAborted();
      const recoveryBudget = config.timeoutMs - (performance.now() - start);
      if (recoveryBudget <= 0) throw new Error("sandbox timeout during container creation");
      const recoveryDeadline = AbortSignal.timeout(Math.ceil(recoveryBudget));
      const recoverySignal = signal ? AbortSignal.any([signal, recoveryDeadline]) : recoveryDeadline;
      const startInv = await withDockerRecovery(dockerBinary, ["start", "--attach", "--interactive", name], recoverySignal);
      const remainingMs = config.timeoutMs - (performance.now() - start);
      if (remainingMs <= 0) throw new Error("sandbox timeout during container creation");
      const pending = deferredPromise.withResolvers<EvolutionExecution>();
      const child = spawn(startInv.binary, startInv.args, {
        env: dockerEnvironment(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
      });
      child.once("exit", () => killDockerProcessTree(child));
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      const channelDecoder = channel ? new StringDecoder("utf8") : undefined;
      let stderrBytes = 0;
      let failure: string | undefined;
      let timedOut = false;
      let settled = false;
      const stop = (reason: string) => {
        failure ??= reason;
        killDockerProcessTree(child);
      };
      const onAbort = () => stop("sandbox cancelled by operator");
      const timer = setTimeout(() => { timedOut = true; stop("sandbox execution timed out"); }, remainingMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      const collect = (chunk: Buffer, destination: Buffer[], bytes: number): number => {
        const kept = chunk.subarray(0, Math.max(0, config.maxOutputBytes - bytes));
        if (kept.length) destination.push(kept);
        if (bytes + chunk.length > config.maxOutputBytes) stop("sandbox output exceeded its byte limit");
        return bytes + kept.length;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes = collect(chunk, stdout, stdoutBytes);
        if (channel && !failure) {
          try { channel.onData(channelDecoder!.write(chunk)); }
          catch (error) { stop(`channel callback failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => { stderrBytes = collect(chunk, stderr, stderrBytes); });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (!channel || error.code !== "EPIPE") stop(`sandbox input delivery failed: ${error.message}`);
      });
      const finish = (code: number | null, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pending.resolve({
          exitCode: code, stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
          stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"), durationMs: performance.now() - start, timedOut,
          ...((failure || error) ? { error: failure ?? error!.message } : {}),
        });
      };
      child.on("error", (error) => finish(null, error));
      child.on("close", (code) => finish(code));
      if (signal?.aborted) onAbort();
      else if (channel) {
        const writer = (data: string) => {
          if (!settled && !failure && child.stdin.writable && !child.stdin.destroyed) child.stdin.write(data);
        };
        try {
          if (channel.initialInput) writer(channel.initialInput);
          channel.onReady(writer);
        } catch (error) {
          stop(`channel callback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else child.stdin.end(stdin);
      execution = await pending.promise;
    } catch (error) {
      execution.error = error instanceof Error ? error.message : String(error);
      execution.timedOut = !signal?.aborted && performance.now() - start >= config.timeoutMs;
    } finally {
      try { await control(dockerBinary, ["rm", "--force", name], CONTROL_TIMEOUT_MS); }
      catch (error) {
        if (attemptedCreate) {
          execution.cleanupFailed = true;
          execution.error = `${execution.error ?? "worker cleanup failed"}; ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      execution.durationMs = performance.now() - start;
    }
    const hadCleanupFailure = execution.cleanupFailed;
    try {
      verifyEvolutionSnapshot(snapshot);
    } catch (error) {
      if (hadCleanupFailure) {
        execution.error = `${execution.error ?? ""}${execution.error ? "; " : ""}snapshot verification failed: ${error instanceof Error ? error.message : String(error)}`;
        return execution;
      }
      throw error;
    }
    return execution;
}

/** Resolve the operator-selected backend without substituting an execution engine. */
export async function resolveEvolutionConfigImage(config: EvolutionConfig): Promise<string> {
  if (config.backend !== "smolvm") return resolveEvolutionImage(config.image);
  if (!config.imageArchive) throw new Error("smolvm requires a local imageArchive");
  const digest = await resolveSmolvmImage(config.imageArchive);
  if (IMAGE_ID.test(config.image) && config.image !== digest) throw new Error("smolvm archive identity mismatch");
  return digest;
}

export function createSmolvmEvolutionSandbox(binary?: string): EvolutionSandbox {
  return (request) => withWorkerAdmission(
    { memoryMb: request.config.memoryMb, cpus: request.config.cpus, timeoutMs: request.config.timeoutMs },
    request.signal,
    async (admissionSignal: AbortSignal) =>
      runSmolvmSnapshot({ ...request, config: parseEvolutionConfig(request.config), signal: admissionSignal }, binary),
  );
}

async function runSmolvmSnapshot(
  { snapshot, config, input, signal, channel }: ProgramRequest,
  binary?: string,
): Promise<EvolutionExecution> {
    if (config.backend !== "smolvm" || !config.imageArchive || !IMAGE_ID.test(config.image)) {
      throw new Error("smolvm execution requires a resolved archive identity and backend smolvm");
    }
    verifyEvolutionSnapshot(snapshot);
    const execution = await runSmolvm({
      imageArchive: config.imageArchive, imageDigest: config.image, binary,
      command: ["/bin/sh", "-c", workerScript(config, "/tmp/0-workspace")],
      stdin: canonicalEvolutionJson(input),
      channel,
      mounts: [{ source: snapshot.root, target: "/snapshot" }],
      timeoutMs: config.timeoutMs, memoryMb: config.memoryMb, cpus: config.cpus,
      maxOutputBytes: config.maxOutputBytes, signal,
    });
    const hadCleanupFailure = execution.cleanupFailed;
    try {
      verifyEvolutionSnapshot(snapshot);
    } catch (error) {
      if (hadCleanupFailure) {
        execution.error = `${execution.error ?? ""}${execution.error ? "; " : ""}snapshot verification failed: ${error instanceof Error ? error.message : String(error)}`;
        return execution;
      }
      throw error;
    }
    return execution;
}

/** Execute a controller-configured program without manufacturing evaluation cases. */
export function executeSandboxSnapshot(request: ProgramRequest): Promise<EvolutionExecution> {
  return withWorkerAdmission(
    { memoryMb: request.config.memoryMb, cpus: request.config.cpus, timeoutMs: request.config.timeoutMs },
    request.signal,
    async (admissionSignal: AbortSignal) =>
      request.config.backend === "smolvm"
        ? runSmolvmSnapshot({ ...request, signal: admissionSignal })
        : runDockerSnapshot({ ...request, signal: admissionSignal }),
  );
}

export function createEvolutionSandbox(config: EvolutionConfig): EvolutionSandbox {
  return config.backend === "smolvm" ? createSmolvmEvolutionSandbox() : createDockerEvolutionSandbox();
}
