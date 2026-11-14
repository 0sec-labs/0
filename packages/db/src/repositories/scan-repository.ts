// ScanRepository: persistence for scans.
import { eq, desc, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ScanConfig } from "@0/shared";
import * as schema from "../schema.js";
import { type SQLiteScanId } from "../types.js";
import { Repository } from "./base.js";

export class ScanRepository extends Repository {

  // ── Scans ──

  createScan(config: ScanConfig, id: string = randomUUID()): string {
    // The database column is SQLite TEXT; this satisfies Drizzle's narrower
    // compile-time inference without changing the persisted identifier.
    const sqliteId = id as SQLiteScanId;
    this.db.insert(schema.scans).values({
      id: sqliteId,
      target: config.target,
      depth: config.depth,
      runtime: config.runtime ?? "api",
      mode: config.mode ?? "probe",
      status: "running",
      startedAt: new Date().toISOString(),
    }).run();
    this.repos.caseGraph.syncCaseForScan(id);
    return id;
  }


  deleteScan(scanId: string): boolean {
    const scan = this.owner.getScan(scanId);
    if (!scan) return false;

    const findingIds = this.db
      .select({ id: schema.findings.id, fingerprint: schema.findings.fingerprint })
      .from(schema.findings)
      .where(eq(schema.findings.scanId, scanId))
      .all();

    this.transaction(() => {
      if (findingIds.length > 0) {
        const ids = findingIds.map((finding) => finding.id);
        this.db.delete(schema.verdicts).where(inArray(schema.verdicts.findingId, ids)).run();
      }

      this.db.delete(schema.agentSessions).where(eq(schema.agentSessions.scanId, scanId)).run();
      this.db.delete(schema.pipelineEvents).where(eq(schema.pipelineEvents.scanId, scanId)).run();
      this.db.delete(schema.attackResults).where(eq(schema.attackResults.scanId, scanId)).run();
      this.db.delete(schema.findings).where(eq(schema.findings.scanId, scanId)).run();
      this.db.delete(schema.scans).where(eq(schema.scans.id, scanId)).run();

      const remainingTargetScans = this.db
        .select({ id: schema.scans.id, startedAt: schema.scans.startedAt })
        .from(schema.scans)
        .where(eq(schema.scans.target, scan.target))
        .orderBy(desc(schema.scans.startedAt))
        .all();

      const caseId = this.repos.caseGraph.buildCaseId(scan.target);
      if (remainingTargetScans.length === 0) {
        this.db.delete(schema.cases).where(eq(schema.cases.id, caseId)).run();
      } else {
        this.db
          .update(schema.cases)
          .set({
            latestScanId: remainingTargetScans[0]!.id,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.cases.id, caseId))
          .run();
      }
    });

    return true;
  }


  completeScan(scanId: string, summary: Record<string, unknown>): void {
    const scan = this.db
      .select({ startedAt: schema.scans.startedAt })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId))
      .get();
    const durationMs = scan
      ? Date.now() - new Date(scan.startedAt).getTime()
      : 0;
    this.db
      .update(schema.scans)
      .set({
        status: "completed",
        completedAt: new Date().toISOString(),
        durationMs,
        summary: JSON.stringify(summary),
      })
      .where(eq(schema.scans.id, scanId))
      .run();
    this.repos.caseGraph.syncCaseForScan(scanId);
  }


  reopenScan(scanId: string): void {
    this.db
      .update(schema.scans)
      .set({
        status: "running",
        completedAt: null,
        durationMs: null,
      })
      .where(eq(schema.scans.id, scanId))
      .run();
    this.repos.caseGraph.syncCaseForScan(scanId);
  }


  failScan(scanId: string, error: string): void {
    this.db
      .update(schema.scans)
      .set({
        status: "failed",
        completedAt: new Date().toISOString(),
        summary: JSON.stringify({ error }),
      })
      .where(eq(schema.scans.id, scanId))
      .run();
    this.repos.caseGraph.syncCaseForScan(scanId);
  }


  getScan(scanId: string) {
    return this.db
      .select()
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId))
      .get();
  }


  listScans(limit = 20) {
    return this.db
      .select()
      .from(schema.scans)
      .orderBy(desc(schema.scans.startedAt))
      .limit(limit)
      .all();
  }


  listScansByTarget(target: string, opts?: { limit?: number }) {
    const query = this.db
      .select()
      .from(schema.scans)
      .where(eq(schema.scans.target, target))
      .orderBy(desc(schema.scans.startedAt));
    if (opts?.limit !== undefined) query.limit(opts.limit);
    return query.all();
  }
}
