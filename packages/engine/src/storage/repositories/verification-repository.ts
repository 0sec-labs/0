// VerificationRepository: persistence for verification.
import { eq, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AttackResult, AgentVerdict } from "../../shared/index.js";
import * as schema from "../schema.js";

import { Repository } from "./base.js";

export class VerificationRepository extends Repository {

  // ── Attack Results ──

  saveAttackResult(scanId: string, result: AttackResult): void {
    const id = randomUUID();
    this.db.insert(schema.attackResults).values({
      id,
      scanId,
      templateId: result.templateId,
      payloadId: result.payloadId,
      outcome: result.outcome,
      request: result.request,
      response: result.response,
      latencyMs: result.latencyMs,
      timestamp: result.timestamp,
      error: result.error ?? null,
    }).run();
  }


  getAttackResults(scanId: string) {
    return this.db
      .select()
      .from(schema.attackResults)
      .where(eq(schema.attackResults.scanId, scanId))
      .orderBy(schema.attackResults.timestamp)
      .all();
  }


  // ── Verdicts (multi-agent consensus) ──

  addVerdict(verdict: AgentVerdict): void {
    this.db.insert(schema.verdicts).values({
      id: verdict.id,
      findingId: verdict.findingId,
      agentRole: verdict.agentRole,
      model: verdict.model,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      reasoning: verdict.reasoning,
      timestamp: verdict.timestamp,
    }).run();
    const finding = this.owner.getFinding(verdict.findingId);
    if (finding?.fingerprint) this.repos.caseGraph.syncFindingGraph(finding.scanId, finding.fingerprint);
  }


  getVerdicts(findingId: string) {
    return this.db
      .select()
      .from(schema.verdicts)
      .where(eq(schema.verdicts.findingId, findingId))
      .orderBy(desc(schema.verdicts.timestamp))
      .all();
  }


  listVerdicts(findingIds?: string[]) {
    if (!findingIds || findingIds.length === 0) return [];
    const placeholders = findingIds.map(() => "?").join(",");
    return this.sqlite
      .prepare(
        `SELECT * FROM verdicts WHERE findingId IN (${placeholders}) ORDER BY timestamp DESC`
      )
      .all(...findingIds) as Array<{
        id: string;
        findingId: string;
        agentRole: string;
        model: string;
        verdict: string;
        confidence: number;
        reasoning: string;
        timestamp: number;
      }>;
  }


  /** Compute consensus: all agree TRUE_POSITIVE → verified, all FALSE_POSITIVE → false-positive */
  computeConsensus(findingId: string): "verified" | "false-positive" | "disputed" | "pending" {
    const vds = this.owner.getVerdicts(findingId);
    if (vds.length === 0) return "pending";
    const types = new Set(vds.map((v) => v.verdict));
    if (types.size === 1 && types.has("TRUE_POSITIVE")) return "verified";
    if (types.size === 1 && types.has("FALSE_POSITIVE")) return "false-positive";
    return "disputed";
  }
}
