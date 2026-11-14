/**
 * Verify stage as a code-run playbook runner (pilot; ZERO_FEATURE_SKILL_VERIFY,
 * default OFF — `runNativeVerify` stays the shipped path).
 *
 * Division of labour: the model decides *inside* one finding's session (replay,
 * variations, `update_finding`); code decides *which* sessions run (one fresh
 * session per finding, always), and owns the terminal status via `gateVerdict`.
 *
 * Oracle shape (resolves the pipelines-to-skills open question): the scan
 * pipeline runs `verifyOracleByCategory` in the triage stage BEFORE the verify
 * agent, and records it as the `oracle` layer verdict. So the oracle is NOT a
 * model-callable tool here (re-running it would double-spend, and a
 * `verify_finding` tool already exists meaning PoC replay). Its structured
 * result is resolved by code, injected read-only into the prompt, and enforced
 * by the gate after the session. Scope, rate-limit, enforcement and cost
 * ceiling stay in the ToolExecutor/native-loop config, passed through verbatim.
 */
import type { Finding, ScanConfig } from "../shared/index.js";
import { resolveIdentities } from "../shared/index.js";
import { runNativeAgentLoop } from "../agent/native-loop.js";
import { getToolsForRole } from "../agent/tools.js";
import { buildAuthPromptBlock } from "../agent/prompts.js";
import { createScanMemoryStore } from "../triage/memories.js";
import type { OracleResult } from "../triage/oracles.js";
import type { NativeRuntime } from "../runtime/types.js";
import type { ScanListener } from "../scanner.js";
import type { ScanCostLedger } from "../agent/cost-ledger.js";
import {
  getOrCreateRateLimiter, resolveEngagementForConfig, resolveEnforcementForConfig,
  resolveScopeForConfig, buildAttributionForConfig,
} from "./scan-config.js";
import { VERIFY_WITH_ORACLE_SKILL } from "./verify-with-oracle.skill.js";

export type TerminalStatus = "confirmed" | "false-positive" | "inconclusive";
export type VerdictSource = "model" | "oracle-gate" | "coverage-gate";
export interface FindingVerdict {
  findingId: string;
  status: TerminalStatus;
  source: VerdictSource;
  oracle?: OracleResult;
  /** Set when the gate overrode the model's declared status. */
  modelStatus?: TerminalStatus;
  gateReason?: string;
}
export interface SessionOutcome {
  turns: number;
  /** Last successful `update_finding` status the model declared for this finding. */
  modelStatus?: TerminalStatus;
  costCeilingExceeded?: boolean;
}
export type VerifySession = (finding: Finding, systemPrompt: string) => Promise<SessionOutcome>;

const NO_ORACLE = /^no oracle for category|skipped by dynamic_router/;

/** Triage already recorded the oracle as a layer verdict; reconstruct without re-running it. */
export function recordedOracle(finding: Finding): OracleResult | undefined {
  const v = [...(finding.layerVerdicts ?? [])].reverse().find((l) => l.layer === "oracle");
  if (!v || v.verdict === "skip" || v.verdict === "error") return undefined;
  if (v.verdict === "pass") return { verified: true, confidence: v.confidence ?? 1, evidence: v.reason.replace(/^verified:\s*/, ""), reason: "" };
  return { verified: false, inconclusive: NO_ORACLE.test(v.reason) || undefined, confidence: v.confidence ?? 0, evidence: "", reason: v.reason };
}

export function normalizeStatus(s: unknown): TerminalStatus | undefined {
  return s === "confirmed" || s === "verified" ? "confirmed" : s === "false-positive" ? "false-positive" : undefined;
}

/** Coverage + oracle gate: the only place a terminal status is decided. Pure. */
export function gateVerdict(finding: Finding, modelStatus: TerminalStatus | undefined, oracle: OracleResult | undefined): FindingVerdict {
  const base = { findingId: finding.id, ...(oracle ? { oracle } : {}), ...(modelStatus ? { modelStatus } : {}) };
  const refuted = !!oracle && !oracle.verified && !oracle.inconclusive;
  if (oracle?.verified) {
    // Oracle proof is non-overridable: a model "false-positive" is reverted.
    return { ...base, status: "confirmed", source: modelStatus === "confirmed" ? "model" : "oracle-gate", ...(modelStatus === "false-positive" ? { gateReason: "oracle_override_blocked" } : {}) };
  }
  if (!modelStatus) return { ...base, status: "inconclusive", source: "coverage-gate", gateReason: "no_model_verdict" };
  if (modelStatus === "confirmed" && refuted) return { ...base, status: "inconclusive", source: "oracle-gate", gateReason: "confirmed_against_refuting_oracle" };
  return { ...base, status: modelStatus, source: "model" };
}

export function buildSkillVerifyPrompt(target: string, finding: Finding, oracle: OracleResult | undefined, config: Pick<ScanConfig, "auth">, memory = ""): string {
  const f = finding;
  return `${VERIFY_WITH_ORACLE_SKILL}
## Target
${target}

## Finding under verification
- id: ${f.id}
- title: ${f.title}
- category: ${f.category}
- severity: ${f.severity}

Original request:
${f.evidence.request.slice(0, 1000)}

Original response:
${f.evidence.response.slice(0, 1000)}

Original analysis:
${(f.evidence.analysis ?? "").slice(0, 600)}

## Oracle result (read-only, computed by code)
${oracle ? JSON.stringify({ verified: oracle.verified, inconclusive: oracle.inconclusive ?? false, confidence: oracle.confidence, evidence: oracle.evidence.slice(0, 400), reason: oracle.reason.slice(0, 300) }) : "none (no oracle ran for this finding)"}${buildAuthPromptBlock(config.auth)}${memory ? "\n\n" + memory : ""}`;
}

export interface SkillVerifyDeps {
  session: VerifySession;
  findings: Finding[];
  target: string;
  config: Pick<ScanConfig, "auth" | "signal">;
  /** Defaults to the oracle verdict triage recorded on the finding. */
  oracle?: (finding: Finding) => OracleResult | undefined | Promise<OracleResult | undefined>;
  memory?: (finding: Finding) => Promise<string>;
  persist?: (verdict: FindingVerdict, finding: Finding) => void;
  onVerdict?: (verdict: FindingVerdict) => void;
}

/** The playbook runner: forEach finding -> one fresh session -> code gate. Every finding gets exactly one verdict. */
export async function runVerifyPlaybook(d: SkillVerifyDeps): Promise<{ turns: number; verdicts: FindingVerdict[] }> {
  const verdicts: FindingVerdict[] = [];
  let turns = 0;
  let stopped = false; // cost ceiling hit: remaining findings are closed by the coverage gate, no session
  for (const finding of d.findings) {
    d.config.signal?.throwIfAborted();
    const oracle = await (d.oracle ?? recordedOracle)(finding);
    let outcome: SessionOutcome = { turns: 0 };
    if (!stopped) {
      const memory = d.memory ? await d.memory(finding).catch(() => "") : "";
      outcome = await d.session(finding, buildSkillVerifyPrompt(d.target, finding, oracle, d.config, memory));
      turns += outcome.turns;
      stopped = !!outcome.costCeilingExceeded;
    }
    const verdict = gateVerdict(finding, outcome.modelStatus, oracle);
    verdicts.push(verdict);
    d.persist?.(verdict, finding);
    d.onVerdict?.(verdict);
  }
  return { turns, verdicts };
}

/** Production wiring: same loop config as `runNativeVerify`, so scope/rate/enforcement/cost hooks are identical. */
export async function runSkillVerify(
  runtime: NativeRuntime, db: any, config: ScanConfig, scanId: string, findings: Finding[], emit: ScanListener, costLedger?: ScanCostLedger,
): Promise<number> {
  const memoryStore = db ? createScanMemoryStore(db) : undefined;
  const session: VerifySession = async (finding, systemPrompt) => {
    let modelStatus: TerminalStatus | undefined;
    const state = await runNativeAgentLoop({
      config: {
        role: "verify", systemPrompt,
        tools: getToolsForRole("verify", { hasScope: !!config.repoPath, allowScanners: config.allowScanners }),
        maxTurns: config.depth === "quick" ? 3 : config.depth === "deep" ? 8 : 5,
        target: config.target, scanId, sessionId: db?.getSession?.(scanId, "verify")?.id,
        authConfig: config.auth, accessControlFixtures: config.accessControlFixtures, identities: resolveIdentities(config),
        scope: resolveScopeForConfig(config), rateLimiter: getOrCreateRateLimiter(config), enforcement: resolveEnforcementForConfig(config),
        allowScanners: config.allowScanners, attribution: buildAttributionForConfig(config), engagement: resolveEngagementForConfig(config),
        costCeilingUsd: config.costCeilingUsd, costModel: config.model, costLedger,
      },
      runtime, signal: config.signal, db,
      onTurn: (turn, calls, results) => {
        calls.forEach((c, i) => {
          if (c.name === "update_finding" && results?.[i]?.success && (c.arguments as any)?.finding_id === finding.id) {
            modelStatus = normalizeStatus((c.arguments as any)?.status) ?? modelStatus;
          }
        });
        emit({ type: "stage:start", stage: "verify", message: `[${finding.id}] turn ${turn}: playbook verify` });
      },
    });
    if (state.errorExit) throw new Error(state.errorExit.error);
    return { turns: state.turnCount, modelStatus, costCeilingExceeded: state.costCeilingExceeded };
  };
  const { turns } = await runVerifyPlaybook({
    session, findings, target: config.target, config,
    memory: memoryStore ? async (f) => memoryStore.formatForPrompt(await memoryStore.getRelevantMemories(f, config.target)) : undefined,
    persist: (v, f) => {
      // The tool already wrote the model's status; code rewrites it only when the gate disagreed.
      if (v.status !== "inconclusive" && v.modelStatus !== v.status) db?.updateFindingStatus?.(f.id, v.status);
      if (v.status === "inconclusive" && v.modelStatus) db?.updateFindingStatus?.(f.id, f.status);
      db?.logEvent?.({ scanId, stage: "verify", eventType: v.gateReason ? "skill_verify_gate" : "skill_verify_verdict", agentRole: "verify", payload: { findingId: f.id, status: v.status, source: v.source, gateReason: v.gateReason, oracleVerified: v.oracle?.verified }, timestamp: Date.now() });
    },
  });
  return turns;
}
