/** Offline, development-only ablation for #121; no production loop imports. */
import { createHash } from "node:crypto";
import type { EvolutionAttempt } from "./types.js";

export type DevelopmentOutcome = "preserve-success" | "incomplete-coverage" | "tool-setup-failure" | "repeated-unproductive-actions" | "invalid-missing-evidence" | "confirmed-detection-miss" | "unknown";
export interface DevelopmentObservation {
  attempt: EvolutionAttempt;
  /** Controller-owned adjudication, never parsed from model stdout/stderr. */
  adjudication?: {
    category: "repeated-unproductive-actions" | "invalid-missing-evidence" | "confirmed-detection-miss";
    verifierReceiptDigest: string;
  };
}
export interface DevelopmentSummaryLimits {
  maxCases: number;
  maxObservations: number;
  maxExamplesPerGroup: number;
  maxBytes: number;
  maxTokens: number;
  maxCachedReceipts: number;
}
export interface DevelopmentSummary {
  schemaVersion: 1;
  developmentDigest: string;
  processedObservations: number;
  truncated: boolean;
  groups: Array<{ outcome: DevelopmentOutcome; count: number; traceRefs: string[] }>;
  /** Only this projection may enter proposer context. No raw traces or case names. */
  prompt: string;
}
const digest = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const validDigest = (s: unknown): s is string => typeof s === "string" && /^sha256:[a-f0-9]{64}$/.test(s);
const ORDER: DevelopmentOutcome[] = ["preserve-success", "incomplete-coverage", "tool-setup-failure", "repeated-unproductive-actions", "invalid-missing-evidence", "confirmed-detection-miss", "unknown"];
function classify(o: DevelopmentObservation): DevelopmentOutcome {
  const a = o.attempt;
  if (a.execution.timedOut || a.execution.cleanupFailed) return "incomplete-coverage";
  if (a.execution.exitCode !== 0 || a.execution.error) return "tool-setup-failure";
  if (a.inconclusive) return "incomplete-coverage";
  if (a.matched) return "preserve-success";
  if (o.adjudication && validDigest(o.adjudication.verifierReceiptDigest) && ["repeated-unproductive-actions", "invalid-missing-evidence", "confirmed-detection-miss"].includes(o.adjudication.category)) return o.adjudication.category;
  return "unknown";
}

/** Caller keeps one bounded cache per explicit offline study. No disk polling. */
export class DevelopmentSummaryCache {
  private readonly cache = new Map<string, DevelopmentSummary>();
  constructor(private readonly limits: DevelopmentSummaryLimits) {
    for (const [k, v] of Object.entries(limits)) if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`invalid summary bound ${k}`);
    if (limits.maxObservations > 100_000 || limits.maxCases > 10_000 || limits.maxExamplesPerGroup > 100 || limits.maxBytes > 1_000_000 || limits.maxTokens > 250_000 || limits.maxCachedReceipts > 128) throw new Error("summary bounds exceed offline hard limits");
    if (Math.min(limits.maxBytes, limits.maxTokens) < 128) throw new Error("summary needs at least 128 bytes/tokens for its envelope");
  }
  summarize(observations: Iterable<DevelopmentObservation>): DevelopmentSummary {
    const groups = new Map<DevelopmentOutcome, { outcome: DevelopmentOutcome; count: number; traceRefs: string[] }>();
    const rows: Array<{ ref: string; category: DevelopmentOutcome; verifier: string | null }> = [];
    const cases = new Set<string>();
    let inspected = 0;
    let truncated = false;
    // Bound total iteration, including hidden/malformed entries. Raw stdout/stderr
    // is never scanned, hashed or copied; a gigabyte trace costs no extra work.
    for (const o of observations) {
      if (++inspected > this.limits.maxObservations) { truncated = true; break; }
      const a = o?.attempt;
      if (!a || a.lane !== "development") continue;
      if (typeof a.caseId !== "string" || a.caseId.length > 1024 || !Number.isSafeInteger(a.repeat) || a.repeat < 0 || typeof a.matched !== "boolean" || typeof a.inconclusive !== "boolean" || !a.execution) { truncated = true; continue; }
      if (!cases.has(a.caseId) && cases.size >= this.limits.maxCases) { truncated = true; continue; }
      cases.add(a.caseId);
      const category = classify(o);
      const verifier = validDigest(o.adjudication?.verifierReceiptDigest) ? o.adjudication!.verifierReceiptDigest : null;
      const ref = digest(JSON.stringify([a.caseId, a.repeat, category, verifier]));
      // Reference resolves via the original controller receipt + case/repeat,
      // while case identities and all private-lane material stay out of prompts.
      rows.push({ ref, category, verifier });
    }
    const developmentDigest = digest(JSON.stringify({ rows, truncated, limits: this.limits }));
    const cached = this.cache.get(developmentDigest);
    if (cached) return structuredClone(cached);
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.ref)) continue;
      seen.add(row.ref);
      const group = groups.get(row.category) ?? { outcome: row.category, count: 0, traceRefs: [] };
      group.count++;
      if (group.traceRefs.length < this.limits.maxExamplesPerGroup) group.traceRefs.push(row.ref);
      groups.set(row.category, group);
    }
    const ordered = ORDER.flatMap(k => groups.has(k) ? [groups.get(k)!] : []);
    // ASCII JSON makes byte length an intentionally conservative token bound:
    // no tokenizer dependency and no unsupported chars with multi-byte tokens.
    const cap = Math.min(this.limits.maxBytes, this.limits.maxTokens);
    let prompt = JSON.stringify({ schemaVersion: 1, truncated, groups: ordered });
    while (Buffer.byteLength(prompt) > cap) {
      truncated = true;
      const withExamples = [...ordered].reverse().find(g => g.traceRefs.length);
      if (withExamples) withExamples.traceRefs.pop();
      else if (ordered.length) ordered.pop();
      else throw new Error("summary envelope exceeds bounds");
      prompt = JSON.stringify({ schemaVersion: 1, truncated, groups: ordered });
    }
    const result: DevelopmentSummary = { schemaVersion: 1, developmentDigest, processedObservations: rows.length, truncated, groups: ordered, prompt };
    if (this.cache.size >= this.limits.maxCachedReceipts) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(developmentDigest, structuredClone(result));
    return result;
  }
}
