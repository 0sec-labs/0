// ScanRepository: persistence for scans.
import { eq, desc, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Finding, ScanConfig, ScanReport } from "@0/shared";
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


  /** Persist an external report snapshot without granting its execution claims local authority. */
  importCiReport(input: {
    scanId: string;
    report: ScanReport;
    findings: Finding[];
    status: "completed" | "failed" | "cancelled";
    summary: Record<string, unknown>;
    provenance: { digest: string; importedAt: string } & Record<string, unknown>;
  }): { scanId: string; alreadyImported: boolean } {
    if (!/^ci-[a-f0-9]{64}$/.test(input.scanId) || input.scanId !== `ci-${input.provenance.digest}`) {
      throw new Error("Invalid imported report identity.");
    }
    return this.transaction(() => {
      const previous = this.owner.getScan(input.scanId);
      if (previous) {
        let summary: Record<string, unknown> = {};
        try { summary = JSON.parse(previous.summary ?? "{}"); } catch { /* A native collision is never overwritten. */ }
        const provenance = summary.ciImport as { digest?: unknown } | undefined;
        if (provenance?.digest !== input.provenance.digest) throw new Error("Imported scan identity collides with an existing record.");
        return { scanId: input.scanId, alreadyImported: true };
      }
      // The caller supplies namespaced finding identities. Refuse all collisions,
      // including another scan's imported findings, before the first mutation.
      const findingIds = new Set<string>();
      for (const finding of input.findings) {
        if (findingIds.has(finding.id) || !finding.id.startsWith(`${input.scanId}-`) || !finding.fingerprint?.startsWith(`${input.scanId}:`) || this.owner.getFinding(finding.id)) {
          throw new Error("Imported finding identity collides with an existing record.");
        }
        findingIds.add(finding.id);
      }
      this.db.insert(schema.scans).values({
        id: input.scanId as SQLiteScanId,
        target: input.report.target,
        depth: input.report.scanDepth,
        runtime: "external-ci",
        mode: "ci-import",
        status: input.status,
        startedAt: input.report.startedAt,
        completedAt: input.report.completedAt || null,
        durationMs: input.report.durationMs,
        summary: JSON.stringify({ ...input.summary, originalReport: input.report, ciImport: input.provenance }),
      }).run();
      for (const finding of input.findings) {
        // Deliberately project only passive descriptive evidence. Even callers
        // of this DB primitive cannot import replay/source-fix authority.
        this.db.insert(schema.findings).values({
          scanId: input.scanId, id: finding.id, fingerprint: finding.fingerprint, templateId: finding.templateId,
          title: finding.title, description: finding.description, severity: finding.severity,
          category: finding.category, timestamp: finding.timestamp,
          evidenceRequest: finding.evidence.request, evidenceResponse: finding.evidence.response, evidenceAnalysis: finding.evidence.analysis ?? null,
          status: "discovered", triageStatus: "new", workflowStatus: "backlog", workflowAssignee: null,
        }).run();
      }
      this.owner.logEvent({
        scanId: input.scanId, stage: "report", eventType: "ci_report_imported",
        timestamp: Date.parse(input.provenance.importedAt),
        payload: { summary: "Imported CI report; evidence and execution claims have not been independently verified by this engine.", ...input.provenance },
      }, { syncGraph: false });
      return { scanId: input.scanId, alreadyImported: false };
    });
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
