/**
 * Docker/podman adapter for the ContainerRunner port. The snapshot is copied
 * into the container (`cp`), never bind-mounted, so the host tree is not
 * writable from inside and it works with remote daemons such as colima.
 * Capabilities are dropped; the network is off for the whole run unless a
 * setup step is declared, in which case it is disconnected after setup.
 */
import { randomBytes } from "node:crypto";
import type { ContainerRunner, Probe, StepOutcome, StepRequest } from "./port.js";
import { exec } from "./process.js";

type Exec = typeof exec;

export interface OciRunnerOptions {
  /** Candidate binaries in order of preference. */
  binaries?: string[];
  exec?: Exec;
}

export class OciRunner implements ContainerRunner {
  readonly isolation = "container" as const;
  #bin: string | undefined;
  readonly #binaries: string[];
  readonly #exec: Exec;

  constructor(options: OciRunnerOptions = {}) {
    this.#binaries = options.binaries ?? ["docker", "podman"];
    this.#exec = options.exec ?? exec;
  }

  async probe(): Promise<Probe> {
    for (const bin of this.#binaries) {
      const r = await this.#exec(bin, ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10_000 });
      if (!r.spawnError && r.code === 0 && !r.timedOut) { this.#bin = bin; return { ok: true, runtime: bin }; }
    }
    return { ok: false, reason: `no container runtime responded (tried ${this.#binaries.join(", ")})` };
  }

  async run(request: StepRequest): Promise<StepOutcome> {
    const started = Date.now();
    const out = (partial: Partial<StepOutcome>): StepOutcome => ({ exitCode: null, output: "", timedOut: false, durationMs: Date.now() - started, ...partial });
    if (!request.image) return out({ infraError: "no image declared for this step" });
    if (!this.#bin) { const probe = await this.probe(); if (!probe.ok) return out({ infraError: probe.reason }); }
    const bin = this.#bin!;
    const name = `0-verify-${randomBytes(6).toString("hex")}`;
    const remaining = () => Math.max(1000, request.timeoutMs - (Date.now() - started));
    const run = (args: string[], timeoutMs = remaining()) => this.#exec(bin, args, { timeoutMs, ...(request.signal ? { signal: request.signal } : {}) });
    const withSetup = Boolean(request.setup) && request.network === "none";
    const createArgs = [
      "create", "--name", name, "--label", "0.verify=1", "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--security-opt", "no-new-privileges",
      "--pids-limit", "512", "--memory", "2g", "--workdir", "/work",
      ...(request.network === "none" && !withSetup ? ["--network", "none"] : []),
      "--entrypoint", "sh", request.image,
      "-c", withSetup || request.setup ? "sleep 86400" : request.command,
    ];
    try {
      const created = await run(createArgs, Math.max(remaining(), 300_000)); // first use may pull the image
      if (created.code !== 0) return out({ infraError: `could not create container: ${created.output.trim().split("\n").pop() ?? ""}` });
      const copied = await run(["cp", `${request.dir}/.`, `${name}:/work`]);
      if (copied.code !== 0) return out({ infraError: `could not copy the snapshot: ${copied.output.trim().split("\n").pop() ?? ""}` });

      if (!request.setup) {
        const r = await run(["start", "-a", name]);
        return out({ exitCode: r.code, output: r.output, timedOut: r.timedOut, ...(r.spawnError ? { infraError: r.spawnError } : {}) });
      }
      const started2 = await run(["start", name]);
      if (started2.code !== 0) return out({ infraError: "could not start container" });
      const setup = await run(["exec", "-w", "/work", name, "sh", "-c", request.setup]);
      if (setup.timedOut) return out({ timedOut: true, output: setup.output });
      if (setup.code !== 0) return out({ exitCode: setup.code, output: `setup failed\n${setup.output}` });
      if (request.network === "none") {
        const cut = await run(["network", "disconnect", "bridge", name]);
        if (cut.code !== 0) return out({ infraError: "could not cut the network after setup; refusing to run the check" });
      }
      const r = await run(["exec", "-w", "/work", name, "sh", "-c", request.command]);
      return out({ exitCode: r.code, output: r.output, timedOut: r.timedOut });
    } finally {
      await this.#exec(bin, ["rm", "-f", name], { timeoutMs: 20_000 });
    }
  }
}
