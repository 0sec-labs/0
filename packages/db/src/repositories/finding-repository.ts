// FindingRepository: persistence for findings.
import { ImpactAssessmentSchema, type ImpactAssessment } from "@0/shared";
import { eq, desc, and, or } from "drizzle-orm";
import type { Finding, FindingTriageStatus } from "@0/shared";
import * as schema from "../schema.js";
import { findingStatuses, type FindingStatusDB } from "../schema.js";
import { iterateLatestFindingMetadata, getFindingFamilyMetadata, selectFindingFamiliesByBusinessPriority, selectFindingsByBusinessPriority, type BusinessPriorityFindingOptions } from "../finding-priority.js";
import { buildFindingFingerprint, type PersistedFindingReviewFields, serializeFindingSourceVerification, serializeFindingVerificationResult, serializeFindingReviewAnnotation, restoreFindingReviewFields, deriveEvidenceFromPocSteps, normalizeWorkflowStatus, type WorkflowStatus } from "../finding-helpers.js";
import { Repository } from "./base.js";

export class FindingRepository extends Repository {

  // ── Findings ──

  saveFinding(scanId: string, finding: Finding): void {
    const workflowFinding = finding as Finding & {
      workflowStatus?: string | null;
      workflowAssignee?: string | null;
    };
    const scan = this.owner.getScan(scanId);
    const fingerprint = finding.fingerprint ?? buildFindingFingerprint(scan?.target ?? scanId, finding);
    const inheritedTriage = this.owner.getLatestFindingByFingerprint(fingerprint);
    const inheritedWorkflowStatus = normalizeWorkflowStatus(
      workflowFinding.workflowStatus ?? inheritedTriage?.workflowStatus,
      {
        status: finding.status,
        triageStatus: finding.triageStatus ?? inheritedTriage?.triageStatus ?? "new",
      },
    );
    const inheritedWorkflowAssignee = workflowFinding.workflowAssignee ?? inheritedTriage?.workflowAssignee ?? null;
    const impactAssessmentJson = finding.impactAssessment
      ? JSON.stringify(finding.impactAssessment)
      : null;
    const layerVerdictsJson =
      finding.layerVerdicts && finding.layerVerdicts.length > 0
        ? JSON.stringify(finding.layerVerdicts)
        : null;
    // 0#170 — persist the optional PoC step graph. NULL when the agent
    // only produced prose evidence; JSON-stringified PocStep[] otherwise. The
    // field is additive: existing readers that ignore it keep working.
    const pocStepsJson =
      finding.pocSteps && finding.pocSteps.length > 0
        ? JSON.stringify(finding.pocSteps)
        : null;
    // 0#193 — persist the optional VerificationSpec. NULL when the
    // finding has no machine-executable re-check contract. Stored as
    // JSON text; cloud's canary watcher reads it back via
    // restorePersistedFinding to re-evaluate findings on each upstream
    // HEAD refresh. Without this column the spec was silently dropped on
    // any reload path.
    const verificationSpecJson = finding.verificationSpec
      ? JSON.stringify(finding.verificationSpec)
      : null;
    // Post-process fields are emitted after agentic verification, so they must
    // survive the final save/reload cycle rather than existing only in the
    // in-memory report.
    const semanticDedupeJson = finding.semanticDedupe
      ? JSON.stringify(finding.semanticDedupe)
      : null;
    // Deterministic-replay result + scoped source reference. Both gate the
    // source-fix action (`verification_result.status === "reproduced"` plus
    // a `reviewAnnotation.path` to scope the patch), so dropping them here
    // made every reloaded finding permanently ineligible. Serialized to
    // NULL — never `"{}"` — when absent or unusable, so a reload can never
    // manufacture a truthy-but-empty verification result.
    const verificationResultJson = serializeFindingVerificationResult(finding.verification_result);
    const reviewAnnotationJson = serializeFindingReviewAnnotation(finding.reviewAnnotation);
    // A source-only summary has independent conservative parsing and never
    // populates `verification_result` or the source-fix gate.
    const sourceVerificationJson = serializeFindingSourceVerification(finding.sourceVerification);
    const candidateFindingRank = finding.findingRank;
    const findingRank =
      typeof candidateFindingRank === "number" &&
      Number.isSafeInteger(candidateFindingRank) &&
      candidateFindingRank > 0
        ? candidateFindingRank
        : null;
    // Backfill prose evidence from pocSteps for findings that only carry the
    // structured form, so legacy advisory templates / dashboards still see
    // request/response/analysis text. The structured pocSteps remain canonical.
    const derivedEvidence = deriveEvidenceFromPocSteps(finding);
    const evidenceRequest = finding.evidence.request || derivedEvidence.request;
    const evidenceResponse = finding.evidence.response || derivedEvidence.response;
    const evidenceAnalysis = finding.evidence.analysis ?? derivedEvidence.analysis ?? null;
    this.db
      .insert(schema.findings)
      .values({
        id: finding.id,
        scanId,
        templateId: finding.templateId,
        title: finding.title,
        description: finding.description,
        severity: finding.severity,
        category: finding.category,
        status: finding.status,
        fingerprint,
        triageStatus: finding.triageStatus ?? inheritedTriage?.triageStatus ?? "new",
        triageNote: finding.triageNote ?? inheritedTriage?.triageNote ?? null,
        triagedAt: finding.triageStatus || inheritedTriage?.triageStatus ? new Date().toISOString() : null,
        workflowStatus: inheritedWorkflowStatus,
        workflowAssignee: inheritedWorkflowAssignee,
        workflowUpdatedAt: new Date().toISOString(),
        confidence: finding.confidence ?? null,
        cvssVector: finding.cvssVector ?? null,
        cvssScore: finding.cvssScore ?? null,
        evidenceRequest,
        evidenceResponse,
        evidenceAnalysis,
        layerVerdicts: layerVerdictsJson,
        impactAssessment: impactAssessmentJson,
        pocSteps: pocStepsJson,
        verificationSpec: verificationSpecJson,
        semanticDedupe: semanticDedupeJson,
        findingRank,
        verificationResult: verificationResultJson,
        reviewAnnotation: reviewAnnotationJson,
        sourceVerification: sourceVerificationJson,
        timestamp: finding.timestamp,
      })
      .onConflictDoUpdate({
        target: schema.findings.id,
        set: {
          templateId: finding.templateId,
          title: finding.title,
          description: finding.description,
          severity: finding.severity,
          category: finding.category,
          status: finding.status,
          fingerprint,
          triageStatus: finding.triageStatus ?? inheritedTriage?.triageStatus ?? "new",
          triageNote: finding.triageNote ?? inheritedTriage?.triageNote ?? null,
          triagedAt: finding.triageStatus || inheritedTriage?.triageStatus ? new Date().toISOString() : null,
          workflowStatus: inheritedWorkflowStatus,
          workflowAssignee: inheritedWorkflowAssignee,
          workflowUpdatedAt: new Date().toISOString(),
          confidence: finding.confidence ?? null,
          cvssVector: finding.cvssVector ?? null,
          cvssScore: finding.cvssScore ?? null,
          evidenceRequest,
          evidenceResponse,
          evidenceAnalysis,
          layerVerdicts: layerVerdictsJson,
          impactAssessment: impactAssessmentJson,
          pocSteps: pocStepsJson,
          verificationSpec: verificationSpecJson,
          semanticDedupe: semanticDedupeJson,
          findingRank,
          verificationResult: verificationResultJson,
          reviewAnnotation: reviewAnnotationJson,
          sourceVerification: sourceVerificationJson,
          timestamp: finding.timestamp,
        },
      })
      .run();
    this.repos.caseGraph.syncFindingGraph(scanId, fingerprint);
  }


  getFinding(findingId: string) {
    return this.db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.id, findingId))
      .get();
  }


  /**
   * Read path for the persisted `verification_result`, `reviewAnnotation`,
   * and `sourceVerification` fields. The first two retain their existing
   * source-fix gate semantics; a source-only check is never replay evidence.
   * Each key is omitted when absent, including for pre-migration rows.
   */
  getFindingReviewFields(findingId: string): PersistedFindingReviewFields {
    return restoreFindingReviewFields(this.owner.getFinding(findingId));
  }


  getFindings(scanId: string) {
    return this.db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.scanId, scanId))
      .orderBy(schema.findings.severity, schema.findings.timestamp)
      .all();
  }


  getScanFindings(scanId: string) {
    return this.owner.getFindings(scanId);
  }


  getLatestFindingForScan(scanId: string) {
    return this.db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.scanId, scanId))
      .orderBy(desc(schema.findings.timestamp))
      .get();
  }


  /** Stable bounded keyset projection for read-only external findings APIs. */
  listFindingsApiPage(options: { limit: number; scanId?: string; severity?: string; status?: string; includeSuppressed?: boolean; before?: { timestamp: number; id: string } }) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 101) throw new Error("Finding API page limit must be between 1 and 101.");
    return this.sqlite.prepare(`SELECT id, scanId, timestamp FROM findings
      WHERE (@scanId IS NULL OR scanId = @scanId) AND (@severity IS NULL OR severity = @severity)
      AND (@status IS NULL OR status = @status) AND (@includeSuppressed = 1 OR COALESCE(triageStatus, 'new') != 'suppressed')
      AND (@beforeTimestamp IS NULL OR timestamp < @beforeTimestamp OR (timestamp = @beforeTimestamp AND id < @beforeId))
      ORDER BY timestamp DESC, id DESC LIMIT @limit`).all({ limit: options.limit, scanId: options.scanId ?? null,
      severity: options.severity ?? null, status: options.status ?? null, includeSuppressed: options.includeSuppressed ? 1 : 0,
      beforeTimestamp: options.before?.timestamp ?? null, beforeId: options.before?.id ?? null }) as Array<{ id: string; scanId: string; timestamp: number }>;
  }


  listFindings(opts?: {
    scanId?: string;
    severity?: string;
    category?: string;
    status?: string;
    triageStatus?: string;
    limit?: number;
  }) {
    const conditions = [];
    if (opts?.scanId) conditions.push(eq(schema.findings.scanId, opts.scanId));
    if (opts?.severity) conditions.push(eq(schema.findings.severity, opts.severity));
    if (opts?.category) conditions.push(eq(schema.findings.category, opts.category));
    if (opts?.status) conditions.push(eq(schema.findings.status, opts.status));
    if (opts?.triageStatus) conditions.push(eq(schema.findings.triageStatus, opts.triageStatus));

    const query = this.db
      .select()
      .from(schema.findings)
      .orderBy(desc(schema.findings.timestamp))
      .limit(opts?.limit ?? 100);

    if (conditions.length > 0) {
      return query.where(and(...conditions)).all();
    }
    return query.all();
  }


  /** Globally rank current family assessments before the body/row limit. Historical review counts remain intact. */
  listFindingFamiliesByBusinessPriority(opts?: BusinessPriorityFindingOptions) {
    return selectFindingFamiliesByBusinessPriority(this.sqlite, opts);
  }


  /** Bounded row-level native --all list; historical rows are independently ranked. */
  listFindingsByBusinessPriority(opts?: BusinessPriorityFindingOptions) {
    return selectFindingsByBusinessPriority(this.sqlite, opts);
  }


  /** Uncapped paged metadata for exact cross-database latest-family merging; no evidence bodies. */
  iterateLatestFindingMetadata(opts?: Omit<BusinessPriorityFindingOptions, "limit">) {
    return iterateLatestFindingMetadata(this.sqlite, opts);
  }


  getFindingFamilyMetadata(key: string, opts?: { scanId?: string }) {
    return getFindingFamilyMetadata(this.sqlite, key, opts);
  }


  /** Alias for listFindings — backward compat with core agent tools */
  queryFindings(opts?: {
    scanId?: string;
    severity?: string;
    category?: string;
    status?: string;
    triageStatus?: string;
    limit?: number;
  }) {
    return this.owner.listFindings(opts);
  }


  updateFindingStatus(findingId: string, status: string): void {
    const finding = this.owner.getFinding(findingId);
    this.db
      .update(schema.findings)
      .set({ status })
      .where(eq(schema.findings.id, findingId))
      .run();
    if (finding?.fingerprint) this.repos.caseGraph.syncFindingGraph(finding.scanId, finding.fingerprint);
  }


  /** Operator business context is metadata; never changes verification or execution authority. */
  updateFindingImpactAssessment(findingId: string, assessment: ImpactAssessment | null): boolean {
    const parsed = assessment === null ? null : ImpactAssessmentSchema.parse(assessment);
    const result = this.db.update(schema.findings)
      .set({ impactAssessment: parsed === null ? null : JSON.stringify(parsed) })
      .where(eq(schema.findings.id, findingId)).run();
    return result.changes > 0;
  }


  saveFindingPocExecution(findingId: string, execution: unknown): void {
    const serialized = JSON.stringify(execution);
    this.db
      .update(schema.findings)
      .set({ pocExecution: serialized })
      .where(eq(schema.findings.id, findingId))
      .run();
  }


  updateFindingTriageByFingerprint(
    fingerprint: string,
    triageStatus: FindingTriageStatus,
    triageNote?: string,
  ): void {
    const latestFinding = this.owner.getLatestFindingByFingerprint(fingerprint);
    const workflowStatus = triageStatus === "accepted"
      ? "done"
      : triageStatus === "suppressed"
        ? "cancelled"
        : null;
    this.db
      .update(schema.findings)
      .set({
        triageStatus,
        triageNote: triageNote ?? null,
        triagedAt: new Date().toISOString(),
        ...(workflowStatus
          ? {
              workflowStatus,
              workflowUpdatedAt: new Date().toISOString(),
            }
          : {}),
      })
      .where(eq(schema.findings.fingerprint, fingerprint))
      .run();
    const refreshedFinding = this.owner.getLatestFindingByFingerprint(fingerprint) ?? latestFinding;
    if (refreshedFinding) {
      this.owner.logEvent({
        scanId: refreshedFinding.scanId,
        stage: "triage",
        eventType: "triage_updated",
        findingId: refreshedFinding.id,
        payload: {
          fingerprint,
          triageStatus,
          workflowStatus: workflowStatus ?? "backlog",
          triageNote: triageNote ?? null,
        },
        timestamp: Date.now(),
      });
      this.repos.caseGraph.syncFindingGraph(refreshedFinding.scanId, fingerprint);
      return;
    }
    this.repos.caseGraph.syncFindingGraph("", fingerprint);
  }


  updateFindingWorkflowByFingerprint(
    fingerprint: string,
    workflowStatus: WorkflowStatus,
    workflowAssignee?: string | null,
  ): void {
    const latestFinding = this.owner.getLatestFindingByFingerprint(fingerprint);
    const normalizedWorkflowStatus = normalizeWorkflowStatus(workflowStatus);
    const triageStatus =
      normalizedWorkflowStatus === "done"
        ? "accepted"
        : normalizedWorkflowStatus === "cancelled"
          ? "suppressed"
          : "new";

    this.db
      .update(schema.findings)
      .set({
        workflowStatus: normalizedWorkflowStatus,
        workflowAssignee: workflowAssignee ?? null,
        workflowUpdatedAt: new Date().toISOString(),
        triageStatus,
        triagedAt: triageStatus === "new" ? null : new Date().toISOString(),
      })
      .where(eq(schema.findings.fingerprint, fingerprint))
      .run();
    const refreshedFinding = this.owner.getLatestFindingByFingerprint(fingerprint) ?? latestFinding;
    if (refreshedFinding) {
      this.owner.logEvent({
        scanId: refreshedFinding.scanId,
        stage: "workflow",
        eventType: "workflow_status_changed",
        findingId: refreshedFinding.id,
        payload: {
          fingerprint,
          workflowStatus: normalizedWorkflowStatus,
          workflowAssignee: workflowAssignee ?? null,
          triageStatus,
        },
        timestamp: Date.now(),
      });
      this.repos.caseGraph.syncFindingGraph(refreshedFinding.scanId, fingerprint);
      return;
    }
    this.repos.caseGraph.syncFindingGraph("", fingerprint);
  }


  updateFindingTriage(findingId: string, triageStatus: FindingTriageStatus, triageNote?: string): void {
    const finding = this.owner.getFinding(findingId);
    if (!finding) throw new Error(`Finding ${findingId} not found`);
    if (!finding.fingerprint) throw new Error(`Finding ${findingId} has no fingerprint`);
    this.owner.updateFindingTriageByFingerprint(finding.fingerprint, triageStatus, triageNote);
  }


  getLatestFindingByFingerprint(fingerprint: string) {
    return this.db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.fingerprint, fingerprint))
      .orderBy(desc(schema.findings.timestamp), desc(schema.findings.id))
      .get();
  }


  getRelatedFindings(fingerprint: string) {
    return this.db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.fingerprint, fingerprint))
      .orderBy(desc(schema.findings.timestamp), desc(schema.findings.id))
      .all();
  }


  // ── Status Pipeline: discovered → verified → confirmed → scored → reported → fixed ──

  transitionFindingStatus(findingId: string, newStatus: FindingStatusDB): void {
    const finding = this.owner.getFinding(findingId);
    if (!finding) throw new Error(`Finding ${findingId} not found`);

    const currentIdx = findingStatuses.indexOf(finding.status as FindingStatusDB);
    const newIdx = findingStatuses.indexOf(newStatus);

    // Allow "false-positive" from any state; otherwise enforce forward-only pipeline
    if (newStatus !== "false-positive" && newIdx <= currentIdx) {
      throw new Error(
        `Cannot transition from '${finding.status}' to '${newStatus}'. ` +
        `Pipeline: ${findingStatuses.join(" → ")}`
      );
    }

    this.db
      .update(schema.findings)
      .set({ status: newStatus })
      .where(eq(schema.findings.id, findingId))
      .run();
    if (finding.fingerprint) this.repos.caseGraph.syncFindingGraph(finding.scanId, finding.fingerprint);
  }


  scoreFinding(findingId: string, score: number): void {
    const finding = this.owner.getFinding(findingId);
    if (score < 0 || score > 100) throw new Error("Score must be 0-100");
    this.db
      .update(schema.findings)
      .set({ score, status: "scored" })
      .where(eq(schema.findings.id, findingId))
      .run();
    if (finding?.fingerprint) this.repos.caseGraph.syncFindingGraph(finding.scanId, finding.fingerprint);
  }


  /** Get summary stats across all findings */
  getStats() {
    const rows = this.sqlite
      .prepare(
        `SELECT severity, COUNT(*) as count FROM findings GROUP BY severity`
      )
      .all() as { severity: string; count: number }[];
    const stats: Record<string, number> = {};
    for (const row of rows) stats[row.severity] = row.count;
    return {
      total: rows.reduce((sum, r) => sum + r.count, 0),
      critical: stats["critical"] ?? 0,
      high: stats["high"] ?? 0,
      medium: stats["medium"] ?? 0,
      low: stats["low"] ?? 0,
      info: stats["info"] ?? 0,
    };
  }
}
