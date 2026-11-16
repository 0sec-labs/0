/**
 * `scan fix --test-command` as an inline verifier. The command runs through the
 * same runner as skill verifiers and returns a typed result. With a pinned
 * image it runs in a container with the network off; without one it keeps the
 * previous host behaviour and the result is stamped isolation "host", so it can
 * never be labelled Verified.
 */
import type { ContainerRunner } from "../verifier/port.js";
import { OciRunner } from "../verifier/docker-runner.js";
import { HostRunner } from "../verifier/host-runner.js";
import { runVerifier } from "../verifier/runner.js";
import { inlineVerifySpec } from "../verifier/spec.js";
import type { SourceFixTestResult } from "./source-fix.js";

export interface FixCheckOptions {
  /** Digest-pinned image; selects the container runner. */
  image?: string;
  /** Test seam; defaults to Docker/podman with an image, the host otherwise. */
  runner?: ContainerRunner;
}

export async function runFixCheck(command: string, cwd: string, timeoutMs: number, signal: AbortSignal | undefined, options: FixCheckOptions = {}): Promise<SourceFixTestResult> {
  const runner = options.runner ?? (options.image ? new OciRunner() : new HostRunner());
  const spec = inlineVerifySpec(command, Math.max(1, Math.ceil(timeoutMs / 1000)), options.image);
  const verification = await runVerifier({ spec, afterDir: cwd, runner, ...(signal ? { signal } : {}) });
  return {
    command,
    exitCode: verification.status === "pass" ? 0 : (verification.exitCode ?? null),
    stdout: verification.logTail,
    stderr: verification.status === "pass" ? "" : `${verification.reason}: ${verification.logTail}`,
    durationMs: verification.durationMs,
    timedOut: verification.reason === "timeout",
    verification,
  };
}
