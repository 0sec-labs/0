/**
 * LLM-derived syzkaller choice weights for kernelCTF targets.
 *
 * Produces the `choice_weights.json` consumed by the llm-weighted syzkaller
 * fork (syzkaller-llm-weighted-*). The fleet-side watcher regenerates these
 * per target bump; this module is the generator of record, replacing the
 * 2026-08-12 mock-provenance placeholder.
 *
 * The weighting contract encodes the kernelCTF LTS target constraints, which
 * are load-bearing: unprivileged user namespaces are OFF (no userns-granted
 * CAP_NET_ADMIN, so netns/ns-dependent surfaces are dead), io_uring and
 * nftables are disabled, COS lakitu config, setuid sandbox. The only paid
 * outcome is an unprivileged memory-corruption LPE — DoS-only surfaces are
 * explicitly deprioritized.
 */
import { createHash } from "node:crypto";
import { LlmApiRuntime } from "../runtime/llm-api.js";
import type { KernelCommitPrepassResult } from "../research/kernel-jev-commit-prepass.js";
import type { KernelJevPrepassResult } from "../research/kernel-jev-prepass.js";

export interface SyzJevPrepassInput {
  commits?: KernelCommitPrepassResult;
  hypotheses?: KernelJevPrepassResult;
  /** Maximum candidates of each kind included in the bounded planning context. */
  limitPerKind?: number;
}

export interface SyzChoiceWeightsOptions {
  /** Target kernel version, e.g. "6.12.101". */
  target: string;
  /** Recent crash descriptions from the fleet, to inform weighting. */
  crashSummary?: string;
  /** Ranked Jev output to translate into syzkaller syscall-family priorities. */
  jevPrepass?: SyzJevPrepassInput;
  /**
   * Syscall names the manager config enables. When set, the prompt restricts
   * the plan to this universe (the fork rejects weights for anything else).
   */
  enabledSyscalls?: string[];
  /** Model override; default is env/auto-detected. */
  model?: string;
  /** Maximum weighted syscalls in the output. */
  maxEntries?: number;
  log?: (message: string) => void;
}

export interface SyzChoiceWeightsFile {
  version: 1;
  target: { label: "linux/amd64" };
  created_at: string;
  provenance: {
    provider: string;
    plan_hash: string;
    source_hash: string;
    model?: string;
  };
  allowed_names: string[];
  weights: Record<string, number>;
}

export interface SyzChoiceWeightsResult {
  file: SyzChoiceWeightsFile;
  rationale: string;
}

const SYSCALL_NAME = /^[a-z][a-z0-9_]*(\$[a-zA-Z0-9_]+)?$/;
const MAX_WEIGHT = 100;
const MIN_WEIGHT = 0.1;

/**
 * Convert advisory Jev rankings into compact evidence for the syscall planner.
 * This bridge deliberately carries no syscall guesses: the weights planner has
 * the enabled-call universe and remains responsible for that mapping.
 */
export function syzWeightingContextFromJev(input: SyzJevPrepassInput): string {
  const limit = Math.max(1, Math.min(100, input.limitPerKind ?? 24));
  const lines: string[] = [];
  const commits = input.commits?.candidates
    .filter((candidate) => candidate.score >= 0)
    .slice(0, limit) ?? [];
  if (commits.length) {
    lines.push("Jev-ranked kernel commits (review priority, not vulnerability verdict):");
    for (const candidate of commits) {
      lines.push(JSON.stringify({
        rank: candidate.rank, score: candidate.score, action: candidate.nextAction,
        sha: candidate.sha, subject: candidate.subject.slice(0, 240), files: candidate.files.slice(0, 12),
        signals: candidate.signals && {
          attacker: candidate.signals.attackerInfluencedPath,
          invariant: candidate.signals.securityInvariantTouched,
          missingPair: candidate.signals.missingPairedSafetyChange,
          direction: candidate.signals.direction,
        },
      }));
    }
  }
  const hypotheses = input.hypotheses?.candidates
    .filter((candidate) => candidate.disposition === "ranked")
    .slice(0, limit) ?? [];
  if (hypotheses.length) {
    lines.push("Jev-ranked kernel findings (must still pass the kernel oracle):");
    for (const candidate of hypotheses) {
      lines.push(JSON.stringify({
        rank: candidate.rank, score: candidate.score, action: candidate.nextAction,
        title: candidate.finding.title.slice(0, 240), category: candidate.finding.category,
        location: candidate.finding.reviewAnnotation?.path ?? candidate.finding.evidence.request.slice(0, 300),
        signals: candidate.signals && {
          reachable: candidate.signals.userspaceReachable,
          invariant: candidate.signals.invariantViolation,
          evidence: candidate.signals.evidenceSufficient,
          oraclePriority: candidate.signals.oraclePriority,
        },
      }));
    }
  }
  return lines.join("\n").slice(0, 12_000);
}

const SYSTEM_PROMPT = `You are a Linux kernel fuzzing strategist configuring a syzkaller variant for the kernelCTF latest-LTS target.

Target environment constraints (all verified, all load-bearing):
- COS lakitu kernel config; unprivileged user namespaces are DISABLED, so no unprivileged CAP_NET_ADMIN/CAP_SYS_ADMIN via userns. Any surface requiring netns creation or admin caps is unreachable.
- io_uring and nftables are disabled in the kernel config. Never weight them.
- Fuzzer runs as an unprivileged user (setuid sandbox).
- The ONLY paid outcome is an unprivileged memory-corruption LPE: UAF write, slab OOB write, refcount-to-free, double-free. DoS-only bugs (null deref, lockups, leaks) pay nothing. Prefer families with a track record of write-grade bugs.
- syzkaller syscall naming: bare names (socket, sendmsg, setsockopt) or variant names with $ (sendmsg$nl_xfrm, socket$nl_route).

You output ONLY a JSON object — no markdown, no commentary:
{"weights": {"<syz$call>": <number>, ...}, "rationale": "<=400 chars"}
Weights are relative priorities in [1, 100]; higher = fuzz more. 12-48 entries. Include both the setup syscall and the corruption-triggering syscall for each surface you choose (e.g. socket$nl_xfrm AND sendmsg$nl_xfrm).`;

export async function generateSyzChoiceWeights(
  opts: SyzChoiceWeightsOptions,
): Promise<SyzChoiceWeightsResult> {
  const maxEntries = opts.maxEntries ?? 48;
  const jevContext = opts.jevPrepass ? syzWeightingContextFromJev(opts.jevPrepass) : "";
  const planningEvidence = [opts.crashSummary, jevContext].filter(Boolean).join("\n\n");
  const userPrompt = [
    `Target kernel: linux ${opts.target} (kernelCTF latest-LTS, x86_64).`,
    `Produce at most ${maxEntries} weighted syscalls for this target.`,
    opts.enabledSyscalls?.length
      ? `HARD CONSTRAINT: every weighted name MUST come from this enabled-syscall universe (the manager rejects any weight outside it). Runtime-support calls (nanosleep, getpid, wait4, exit...) get weight 1 or are omitted:\n${JSON.stringify(opts.enabledSyscalls)}`
      : "",
    planningEvidence
      ? `Ranked local evidence for this target (map evidenced reachable subsystems to enabled syzkaller calls; do not treat rankings as vulnerability verdicts):\n${planningEvidence.slice(0, 12_000)}`
      : "No fleet crash or Jev prepass evidence supplied; use generic kernelCTF LTS priors.",
  ].filter(Boolean).join("\n\n");

  const runtime = new LlmApiRuntime({ type: "api", timeout: 120_000, model: opts.model });
  opts.log?.(`weights: requesting ${opts.target} plan from runtime (model=${opts.model ?? "auto"})`);
  const res = await runtime.execute(userPrompt, { systemPrompt: SYSTEM_PROMPT });
  if (res.error) throw new Error(`LLM runtime error: ${res.error}`);
  if (!res.output.trim()) throw new Error("LLM returned empty output");

  const parsed = parseModelJson(res.output);
  const planHash = createHash("sha256").update(SYSTEM_PROMPT + "\n" + userPrompt).digest("hex");
  const sourceHash = createHash("sha256").update(planningEvidence || opts.target).digest("hex");
  return {
    file: buildWeightsFile(parsed, opts.target, planHash, sourceHash, opts.maxEntries ?? 48, "0/llm-api", opts.model),
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
  };
}

/**
 * Validate and normalize a raw model plan (JSON text) into a weights file
 * without an API call — for replaying plans generated by an external agent
 * session (e.g. when the fleet host has no direct provider credentials).
 */
export function syzChoiceWeightsFromPlan(
  rawPlan: string,
  opts: { target: string; crashSummary?: string; maxEntries?: number },
): SyzChoiceWeightsResult {
  const parsed = parseModelJson(rawPlan);
  const planHash = createHash("sha256").update(rawPlan).digest("hex");
  const sourceHash = createHash("sha256").update(opts.crashSummary ?? opts.target).digest("hex");
  return {
    file: buildWeightsFile(parsed, opts.target, planHash, sourceHash, opts.maxEntries ?? 48, "0/external-plan"),
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
  };
}

function buildWeightsFile(
  parsed: { weights?: unknown; rationale?: unknown },
  target: string,
  planHash: string,
  sourceHash: string,
  maxEntries: number,
  provider: string,
  model?: string,
): SyzChoiceWeightsFile {
  const weights = sanitizeWeights(parsed.weights, maxEntries);
  if (Object.keys(weights).length < 4) {
    throw new Error(`plan produced too few valid entries (${Object.keys(weights).length})`);
  }
  return {
    version: 1,
    target: { label: "linux/amd64" },
    created_at: new Date().toISOString(),
    provenance: { provider, plan_hash: planHash, source_hash: sourceHash, ...(model ? { model } : {}) },
    allowed_names: Object.keys(weights),
    weights,
  };
}

function parseModelJson(raw: string): { weights?: unknown; rationale?: unknown } {
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null) throw new Error("model output is not an object");
  return parsed as { weights?: unknown; rationale?: unknown };
}

function sanitizeWeights(input: unknown, maxEntries: number): Record<string, number> {
  if (typeof input !== "object" || input === null) throw new Error("weights field missing or not an object");
  const entries: Array<[string, number]> = [];
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (!SYSCALL_NAME.test(name)) continue;
    const weight = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    entries.push([name, Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, weight))]);
  }
  entries.sort((a, b) => b[1] - a[1]);
  const kept = entries.slice(0, maxEntries);
  return Object.fromEntries(kept);
}
