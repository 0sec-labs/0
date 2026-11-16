/** Port the verifier runs steps through. Adapters: docker/podman, and a host adapter for explicit `--test-command` only. */

export type Probe = { ok: true; runtime: string } | { ok: false; reason: string };

export interface StepRequest {
  /** Digest-pinned image. Ignored by the host adapter. */
  image?: string;
  /** Directory holding the snapshot to verify. The adapter must not modify it. */
  dir: string;
  /** Runs first with network, then the network is cut before `command`. */
  setup?: string;
  command: string;
  network: "none" | "allowed";
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface StepOutcome {
  exitCode: number | null;
  /** Combined stdout and stderr, unredacted; the runner redacts and tails it. */
  output: string;
  timedOut: boolean;
  durationMs: number;
  /** Set when the adapter could not run the step at all (image pull, runtime failure). */
  infraError?: string;
}

export interface ContainerRunner {
  readonly isolation: "container" | "host";
  probe(): Promise<Probe>;
  run(request: StepRequest): Promise<StepOutcome>;
}
