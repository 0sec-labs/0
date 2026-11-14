import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  verifyFormalArtifact,
  type FormalArtifactOptions,
  type FormalArtifactResult,
  type FormalChallenge,
} from "../verify/formal-artifact.js";

export interface FormalResearchTask {
  id: string;
  challenge: FormalChallenge;
}
export interface FormalGenerationContext {
  readonly challenge: FormalChallenge;
  readonly attempt: number;
  readonly previous: readonly FormalArtifactResult[];
  readonly signal: AbortSignal;
}
export interface FormalResearchAttempt {
  attempt: number;
  result: FormalArtifactResult;
}
export interface FormalResearchTaskResult {
  id: string;
  attempts: FormalResearchAttempt[];
  status: "checked" | "unresolved";
  reason: string;
}
export interface FormalResearchCampaignOptions {
  tasks: readonly FormalResearchTask[];
  /** Trusted provider integration; must honor cancellation and its own cost ledger. */
  generate(context: FormalGenerationContext): Promise<unknown>;
  verification: Omit<FormalArtifactOptions, "signal">;
  maxConcurrency?: number;
  maxAttemptsPerTask?: number;
  maxTotalAttempts?: number;
  timeCapMs?: number;
  signal?: AbortSignal;
  /** Trusted engine-selected artifact root. Each run creates a fresh child directory. */
  artifactRoot?: string;
}
export interface FormalResearchCampaignResult {
  scope: "formal-model";
  tasks: FormalResearchTaskResult[];
  totalAttempts: number;
  stopReason: string;
  artifactDir?: string;
}

function limit(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

/**
 * Zero owns bounded parallel proof attempts. This API does not execute Lean,
 * contact model providers, advertise a workflow capability, or emit findings.
 * A qualified isolated checker and a cost-aware generator are host injections.
 */
export async function runFormalResearchCampaign(
  options: FormalResearchCampaignOptions,
): Promise<FormalResearchCampaignResult> {
  const concurrency = limit(options.maxConcurrency ?? 2, "maxConcurrency", 8);
  const perTask = limit(options.maxAttemptsPerTask ?? 3, "maxAttemptsPerTask", 16);
  const totalLimit = limit(options.maxTotalAttempts ?? 12, "maxTotalAttempts", 128);
  const timeCapMs = limit(options.timeCapMs ?? 60_000, "timeCapMs", 600_000);
  if (!Array.isArray(options.tasks) || options.tasks.length > 64 ||
      options.tasks.some(task => typeof task.id !== "string" || !task.id.trim() || task.id.length > 160) ||
      new Set(options.tasks.map(task => task.id)).size !== options.tasks.length) {
    throw new Error("Campaign requires at most 64 tasks with unique nonempty IDs");
  }
  // Freeze snapshots before any generator sees a task; never share caller-owned objects.
  const tasks = options.tasks.map(task => ({ id: task.id, challenge: Object.freeze(structuredClone(task.challenge)) }));
  const verification = Object.freeze({ ...options.verification });
  const generate = options.generate;
  const results: FormalResearchTaskResult[] = tasks.map(task => ({ id: task.id, attempts: [], status: "unresolved", reason: "Not attempted" }));
  const controller = new AbortController();
  let stopped = "Completed bounded attempts";
  const stop = (reason: string) => { if (!controller.signal.aborted) { stopped = reason; controller.abort(); } };
  const forwardAbort = () => stop("Cancelled");
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) forwardAbort();
  const deadline = Date.now() + timeCapMs;
  const timer = setTimeout(() => stop("Campaign deadline exceeded"), timeCapMs);
  let artifactDir: string | undefined;
  let totalAttempts = 0;
  let nextTask = 0;

  const persist = (name: string, value: unknown) => {
    if (artifactDir) writeFileSync(join(artifactDir, name), JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  };
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (controller.signal.aborted) throw new Error(stopped);
    let listener: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      listener = () => reject(new Error(stopped));
      controller.signal.addEventListener("abort", listener, { once: true });
    });
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error(stopped);
        return operation();
      }), cancelled]);
    } finally {
      if (listener) controller.signal.removeEventListener("abort", listener);
    }
  };

  try {
    if (options.artifactRoot && !controller.signal.aborted) {
      mkdirSync(options.artifactRoot, { recursive: true });
      artifactDir = mkdtempSync(join(options.artifactRoot, "formal-"));
      persist("challenges.json", tasks);
    }
    const worker = async () => {
      while (!controller.signal.aborted && nextTask < tasks.length) {
        const index = nextTask++;
        const task = tasks[index];
        const result = results[index];
        const preflight = await verifyFormalArtifact(task.challenge, { proof: "preflight" }, { ...verification, checker: undefined, signal: controller.signal });
        if (preflight.status === "artifact-rejected" || !verification.checker) {
          result.reason = preflight.reason;
          continue;
        }
        for (let attempt = 1; attempt <= perTask && !controller.signal.aborted; attempt++) {
          if (totalAttempts >= totalLimit) { result.reason = "Total attempt budget exhausted"; break; }
          totalAttempts++;
          let candidate: unknown;
          let outcome: FormalArtifactResult;
          try {
            candidate = await bounded(() => generate(Object.freeze({
              challenge: task.challenge, attempt,
              previous: Object.freeze(result.attempts.map(item => item.result)), signal: controller.signal,
            })));
            if (controller.signal.aborted) throw new Error(stopped);
            outcome = await verifyFormalArtifact(task.challenge, candidate, {
              ...verification, signal: controller.signal,
              timeoutMs: Math.max(1, Math.min(verification.timeoutMs ?? 30_000, deadline - Date.now())),
            });
          } catch {
            outcome = { status: "inconclusive", scope: "formal-model", reason: controller.signal.aborted ? stopped : "Proof generator failed" };
          }
          Object.freeze(outcome);
          result.attempts.push({ attempt, result: outcome });
          result.reason = outcome.reason;
          // Only validated candidate bytes are retained, never arbitrary provider objects.
          const proof = candidate && typeof candidate === "object" && "proof" in candidate && typeof candidate.proof === "string"
            && Buffer.byteLength(candidate.proof, "utf8") <= (verification.maxProofBytes ?? 1_000_000) ? candidate.proof : undefined;
          persist(`task-${index}-attempt-${attempt}.json`, { taskId: task.id, attempt, ...(proof === undefined ? {} : { proof }), result: outcome });
          if (outcome.status === "checked") { result.status = "checked"; break; }
        }
        if (controller.signal.aborted) result.reason = stopped;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    if (!controller.signal.aborted && totalAttempts >= totalLimit && results.some(result => result.status !== "checked")) stopped = "Total attempt budget exhausted";
    for (const result of results) if (result.reason === "Not attempted") result.reason = controller.signal.aborted ? stopped : "Total attempt budget exhausted";
    const outcome: FormalResearchCampaignResult = { scope: "formal-model", tasks: results, totalAttempts, stopReason: stopped, ...(artifactDir ? { artifactDir } : {}) };
    persist("results.json", outcome);
    return outcome;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
    controller.abort();
  }
}
