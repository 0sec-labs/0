/**
 * Host adapter: runs the command with /bin/sh -lc in the given directory.
 * Used only for an explicit operator `--test-command` with no image, and its
 * results are stamped isolation "host" so they can never read as Verified.
 */
import type { ContainerRunner, Probe, StepOutcome, StepRequest } from "./port.js";
import { exec } from "./process.js";

export class HostRunner implements ContainerRunner {
  readonly isolation = "host" as const;
  async probe(): Promise<Probe> { return { ok: true, runtime: "host" }; }
  async run(request: StepRequest): Promise<StepOutcome> {
    const started = Date.now();
    const r = await exec("/bin/sh", ["-lc", request.command], { cwd: request.dir, timeoutMs: request.timeoutMs, ...(request.signal ? { signal: request.signal } : {}) });
    return { exitCode: r.code, output: r.output, timedOut: r.timedOut, durationMs: Date.now() - started, ...(r.spawnError ? { infraError: r.spawnError } : {}) };
  }
}
