/**
 * Level-1 A/B for the skill-verify pilot: frozen candidates, verify stage only.
 *
 *   A = legacy `runNativeVerify` loop      (ZERO_FEATURE_SKILL_VERIFY off)
 *   B = playbook runner + skill prompt     (ZERO_FEATURE_SKILL_VERIFY on)
 *
 * Both arms run through the SAME public entry (`runNativeVerify`) on the SAME
 * frozen candidates with the same runtime/model and turn budgets; only the flag
 * differs. Final status is observed from the model's own `update_finding`
 * tool_use blocks (A) or the runner's recorded verdict event (B), so neither
 * arm is graded by itself. Pure, runtime-agnostic: tests inject a deterministic
 * fake runtime; `scripts/skill-verify-ab.ts` injects a real one.
 */
import type { Finding, ScanConfig } from "../shared/index.js";
import { estimateCost } from "../shared/index.js";
import type { NativeRuntime, NativeRuntimeResult, NativeMessage, NativeToolDef } from "../runtime/types.js";
import type { OracleResult } from "../triage/oracles.js";
import { runNativeVerify } from "../agentic/phase-runners.js";
import { withVariantFeatureFlags } from "./variant.js";
import { wilson95 } from "./scorecard.js";

export type CandidateLabel = "true" | "false";
export interface FrozenCandidate {
  id: string;
  label: CandidateLabel;
  origin: "recorded" | "synthetic";
  /** Id of the true candidate a synthetic false one was mutated from. */
  mutatedFrom?: string;
  finding: Finding;
}
export type ArmId = "A" | "B";
export type ObservedStatus = "confirmed" | "false-positive" | "inconclusive";
export interface CandidateResult {
  id: string; label: CandidateLabel; status: ObservedStatus;
  turns: number; costUsd: number; wallMs: number;
  /** Final status contradicts a verified oracle result (must be 0 for arm B). */
  oracleOverride: boolean;
}

/** Deterministic synthetic false candidate: wrong endpoint, wrong param, or stripped proof (cycled by index). */
export function mutateToFalse(src: FrozenCandidate, index: number): FrozenCandidate {
  const f: Finding = structuredClone(src.finding);
  f.id = `${src.finding.id}-neg`;
  f.layerVerdicts = (f.layerVerdicts ?? []).filter((l) => l.layer !== "oracle");
  switch (index % 3) {
    case 0: // wrong endpoint
      f.evidence.request = f.evidence.request.replace(/\/[^\s?/]+(?=[\s?]|$)/, "/__nonexistent__");
      f.evidence.response = "404 Not Found";
      break;
    case 1: // wrong parameter
      f.evidence.request = f.evidence.request.replace(/([?&])[a-zA-Z_]+=/, "$1__nope__=");
      f.evidence.response = "200 OK (parameter ignored)";
      break;
    default: // proof stripped
      f.evidence.response = "";
      f.evidence.analysis = "";
      break;
  }
  return { id: f.id, label: "false", origin: "synthetic", mutatedFrom: src.id, finding: f };
}

/** True candidates (recorded from a frozen discovery pass) plus one synthetic false each. Target: >=100 + >=100. */
export function buildDataset(recordedTrue: FrozenCandidate[], opts: { falsePerTrue?: number } = {}): FrozenCandidate[] {
  const trues = recordedTrue.map((c) => ({ ...c, label: "true" as const }));
  const falses: FrozenCandidate[] = [];
  const k = opts.falsePerTrue ?? 1;
  trues.forEach((t, i) => {
    for (let j = 0; j < k; j++) {
      const m = mutateToFalse(t, i + j);
      const id = `${m.id}${j}`;
      falses.push({ ...m, id, finding: { ...m.finding, id } });
    }
  });
  return [...trues, ...falses];
}

/** Records the model's update_finding calls and token usage per fresh session; wraps any runtime. */
export function observeRuntime(inner: NativeRuntime, model?: string) {
  const status = new Map<string, ObservedStatus>();
  const cost = new Map<string, number>();
  const turns = new Map<string, number>();
  let current = "";
  const runtime: NativeRuntime = {
    ...inner,
    type: inner.type,
    isAvailable: () => inner.isAvailable(),
    async executeNative(system: string, messages: NativeMessage[], tools: NativeToolDef[], ...rest: any[]): Promise<NativeRuntimeResult> {
      if (messages.length === 1) current = /- id: (\S+)/.exec(system)?.[1] ?? current;
      const res = await (inner.executeNative as any)(system, messages, tools, ...rest) as NativeRuntimeResult;
      turns.set(current, (turns.get(current) ?? 0) + 1);
      if (res.usage) cost.set(current, (cost.get(current) ?? 0) + estimateCost({ ...res.usage }, model));
      for (const b of res.content) {
        if (b.type === "tool_use" && b.name === "update_finding") {
          const i = b.input as { finding_id?: string; status?: string };
          if (i.finding_id === current && (i.status === "confirmed" || i.status === "verified")) status.set(current, "confirmed");
          else if (i.finding_id === current && i.status === "false-positive") status.set(current, "false-positive");
        }
      }
      return res;
    },
  };
  return { runtime, status, cost, turns };
}

export interface RunArmOptions {
  arm: ArmId;
  candidates: FrozenCandidate[];
  runtime: NativeRuntime;
  config: ScanConfig;
  model?: string;
  /** Oracle results by candidate id, frozen at record time (B reads them via layerVerdicts, so they are written there). */
  oracleById?: Record<string, OracleResult>;
}

/** Run one arm over all candidates, one `runNativeVerify` call per candidate so wall/turns/cost are per-finding. */
export async function runArm(o: RunArmOptions): Promise<CandidateResult[]> {
  const out: CandidateResult[] = [];
  for (const c of o.candidates) {
    const finding: Finding = structuredClone(c.finding);
    const oracle = o.oracleById?.[c.id];
    if (oracle?.verified) finding.layerVerdicts = [...(finding.layerVerdicts ?? []), { layer: "oracle", verdict: "pass", confidence: oracle.confidence, reason: `verified: ${oracle.evidence}`, durationMs: 0, costUsd: 0 }];
    const obs = observeRuntime(o.runtime, o.model);
    let gateStatus: ObservedStatus | undefined;
    const db = { // no-op persistence; only logEvent is observed
      logEvent: (e: { eventType?: string; payload?: { findingId?: string; status?: ObservedStatus } }) => {
        if (e.eventType?.startsWith("skill_verify") && e.payload?.findingId === finding.id) gateStatus = e.payload.status;
      },
      updateFindingStatus: () => {},
      saveSession: () => {},
    };
    const t0 = Date.now();
    const turns = await withVariantFeatureFlags({ skill_verify: o.arm === "B" }, () =>
      runNativeVerify(obs.runtime, db, { ...o.config, plan: undefined } as ScanConfig, `ab-${o.arm}`, [finding], () => {}));
    const status: ObservedStatus = o.arm === "B" ? gateStatus ?? "inconclusive" : obs.status.get(finding.id) ?? "inconclusive";
    out.push({
      id: c.id, label: c.label, status, turns, costUsd: obs.cost.get(finding.id) ?? 0, wallMs: Date.now() - t0,
      oracleOverride: !!oracle?.verified && status === "false-positive",
    });
  }
  return out;
}

export interface ArmSummary {
  arm: ArmId; n: number;
  trueRecall: number; trueRecallCi: [number, number];
  fpRejection: number; fpRejectionCi: [number, number];
  precision: number;
  terminalRate: number; // share reaching confirmed|false-positive|inconclusive (always 1 by construction; reported as a tripwire)
  inconclusiveRate: number;
  costPerFinding: number; turnsPerFinding: number; wallMsPerFinding: number;
  oracleOverrides: number;
}

export function summarize(arm: ArmId, rs: CandidateResult[]): ArmSummary {
  const T = rs.filter((r) => r.label === "true"), F = rs.filter((r) => r.label === "false");
  const tp = T.filter((r) => r.status === "confirmed").length;
  const fpRej = F.filter((r) => r.status === "false-positive").length;
  const fpKept = F.filter((r) => r.status === "confirmed").length;
  const avg = (f: (r: CandidateResult) => number) => (rs.length ? rs.reduce((s, r) => s + f(r), 0) / rs.length : 0);
  return {
    arm, n: rs.length,
    trueRecall: T.length ? tp / T.length : 0, trueRecallCi: wilson95(tp, T.length),
    fpRejection: F.length ? fpRej / F.length : 0, fpRejectionCi: wilson95(fpRej, F.length),
    precision: tp + fpKept ? tp / (tp + fpKept) : 0,
    terminalRate: rs.length ? rs.filter((r) => ["confirmed", "false-positive", "inconclusive"].includes(r.status)).length / rs.length : 1,
    inconclusiveRate: rs.length ? rs.filter((r) => r.status === "inconclusive").length / rs.length : 0,
    costPerFinding: avg((r) => r.costUsd), turnsPerFinding: avg((r) => r.turns), wallMsPerFinding: avg((r) => r.wallMs),
    oracleOverrides: rs.filter((r) => r.oracleOverride).length,
  };
}

export interface Verdict { pass: boolean; failures: string[]; stop: string[] }

/** Doc 5.3 non-inferiority criterion plus 5.4 stop conditions. Rates are fractions; "pp" tolerances are 0.02 / 0.03. */
export function compareArms(a: ArmSummary, b: ArmSummary): Verdict {
  const failures: string[] = [], stop: string[] = [];
  if (b.trueRecall < a.trueRecall - 0.02) failures.push(`true recall ${b.trueRecall.toFixed(3)} < A-2pp (${a.trueRecall.toFixed(3)})`);
  if (b.fpRejection < a.fpRejection - 0.03) failures.push(`FP rejection ${b.fpRejection.toFixed(3)} < A-3pp (${a.fpRejection.toFixed(3)})`);
  if (a.costPerFinding > 0 && b.costPerFinding > a.costPerFinding * 1.10) failures.push(`cost/finding ${b.costPerFinding.toFixed(4)} > A x1.10`);
  if (b.terminalRate < 1) failures.push("not every candidate reached a terminal status");
  if (b.oracleOverrides > 0) failures.push(`${b.oracleOverrides} oracle override(s)`);
  if (b.trueRecall < a.trueRecall - 0.05) stop.push("recall drop > 5pp");
  if (b.trueRecallCi[1] < a.trueRecallCi[0]) stop.push("recall Wilson CIs separated against B");
  if (a.costPerFinding > 0 && b.costPerFinding > a.costPerFinding * 1.25) stop.push("cost/finding > +25%");
  if (a.wallMsPerFinding > 0 && b.wallMsPerFinding > a.wallMsPerFinding * 1.5) stop.push("wall time > +50%");
  return { pass: failures.length === 0, failures, stop };
}

/** Pre-run cost estimate: findings x repeats x arms x (avg turns x tokens/turn) priced at `model`. No model calls. */
export function estimateAbCost(o: { trueN: number; falseN: number; repeats: number; model: string; turnsPerFinding?: number; inputTokensPerTurn?: number; outputTokensPerTurn?: number }) {
  const turns = o.turnsPerFinding ?? 4, inT = o.inputTokensPerTurn ?? 6_000, outT = o.outputTokensPerTurn ?? 600;
  const perFinding = estimateCost({ inputTokens: turns * inT, outputTokens: turns * outT }, o.model);
  const findingsPerArm = (o.trueN + o.falseN) * o.repeats;
  return { perFindingUsd: perFinding, perArmUsd: perFinding * findingsPerArm, totalUsd: perFinding * findingsPerArm * 2, findingsPerArm, assumptions: { turns, inT, outT } };
}
