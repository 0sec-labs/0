import {
  createShimmedDatabase,
  createDrizzleFromShim,
  type ShimmedDatabase,
} from "./wasm-shim.js";
import { ensureDatabaseDirectory } from "./db-directory.js";
import { existsSync } from "node:fs";
import * as schema from "./schema.js";
import type {
  ArtifactRecord,
  Finding,
  AttackResult,
  CaseRecord,
  TargetInfo,
  ScanConfig,
  AgentVerdict,
  PipelineEvent,
  FindingTriageStatus,
  WorkItemRecord,
  WorkerRecord,
  ImpactAssessment,
} from "@0/shared";
import { randomUUID } from "node:crypto";
import type { FindingStatusDB } from "./schema.js";
import type { BusinessPriorityFindingOptions } from "./finding-priority.js";
import {
  resolveOsecDbPath,
  resetOsecDatabase,
  backupCorruptDatabase,
  assertDatabaseEngineCompatibility,
  ensureDatabaseHealthy,
} from "./database-lifecycle.js";
import { SCHEMA_TABLES_SQL, SCHEMA_INDEXES_SQL, migrateLegacySchema } from "./schema-migrations.js";
import type {
  OsecDbOpenOptions,
  PersistentCredentialQuery,
  PersistentCredentialRow,
  PersistentCredentialUpsert,
  TrustGraphEdgeInput,
  TrustGraphEdgeRow,
} from "./types.js";
import type { PersistedFindingReviewFields, WorkflowStatus } from "./finding-helpers.js";
import { createRepositories, type Repositories } from "./repositories/index.js";
import type { ScanRepository } from "./repositories/scan-repository.js";

export { resolveOsecDbPath, resetOsecDatabase } from "./database-lifecycle.js";
export type {
  PersistentCredentialRow,
  PersistentCredentialUpsert,
  PersistentCredentialQuery,
  TrustGraphEdgeRow,
  TrustGraphEdgeInput,
  OsecDbOpenOptions,
} from "./types.js";
export {
  parseFindingVerificationResult,
  parseFindingReviewAnnotation,
  parseFindingSourceVerification,
  restoreFindingReviewFields,
  type FindingReviewAnnotation,
  type PersistedFindingReviewFields,
} from "./finding-helpers.js";

export function repairOsecDatabase(dbPath?: string): { path: string; backupPath?: string } {
  const path = resolveOsecDbPath(dbPath);

  ensureDatabaseDirectory(path);

  const backupPath = backupCorruptDatabase(path) ?? undefined;
  resetOsecDatabase(path);

  const db = new osecDB(path);
  db.close();

  return { path, backupPath };
}

export class osecDB {
  /** Resolved storage identity for scoped stores sharing this database. */
  readonly databasePath: string;
  private sqlite!: ShimmedDatabase;
  private db!: ReturnType<typeof createDrizzleFromShim<typeof schema>>;

  private repos!: Repositories;

  constructor(dbPath?: string, options: OsecDbOpenOptions = {}) {
    const path = resolveOsecDbPath(dbPath);
    this.databasePath = path;
    if (options.readOnly) {
      if (path !== ":memory:" && !existsSync(path)) {
        throw new Error(`Database does not exist: ${path}`);
      }
      this.initializeReadOnlyDatabase(path);
      return;
    }
    ensureDatabaseDirectory(path);
    this.openDatabase(path);
  }


  private openDatabase(path: string): void {
    assertDatabaseEngineCompatibility(path);
    try {
      this.initializeDatabase(path);
    } catch (error) {
      try { this.sqlite?.close(); } catch { /* Preserve the original error. */ }
      // Ordinary open must never remove locks, rewrite storage, or recreate a
      // corrupt database. Explicit operator repair/reset remain separate APIs.
      throw error;
    }
  }

  private initializeDatabase(path: string): void {
    this.sqlite = createShimmedDatabase(path);
    // WAL is intentionally omitted: node-sqlite3-wasm's VFS does not support
    // it, and 0's single-writer CLI workload does not benefit from it.
    this.sqlite.pragma("foreign_keys = ON");
    ensureDatabaseHealthy(this.sqlite);
    this.db = createDrizzleFromShim(this.sqlite, { schema });
    this.repos = createRepositories(this.sqlite, this.db, this);

    // Keep schema upgrades atomic and avoid a durable commit per table/index.
    this.sqlite.transaction(() => {
      this.sqlite.exec(SCHEMA_TABLES_SQL);
      migrateLegacySchema(this.sqlite);
      this.sqlite.exec(SCHEMA_INDEXES_SQL);
    })();
  }

  private initializeReadOnlyDatabase(path: string): void {
    assertDatabaseEngineCompatibility(path);
    this.sqlite = createShimmedDatabase(path);
    this.sqlite.pragma("foreign_keys = ON");
    this.db = createDrizzleFromShim(this.sqlite, { schema });
    this.repos = createRepositories(this.sqlite, this.db, this);
  }

  insertTriageMemory(row: {
    id: string;
    scope: "global" | "target" | "package";
    scopeValue?: string | null;
    category: string;
    pattern: string;
    reasoning: string;
    createdAt: number;
    appliedCount?: number;
  }): void {
    return this.repos.triageMemories.insertTriageMemory(row);
  }

  listTriageMemories(opts?: {
    scope?: "global" | "target" | "package";
    scopeValue?: string;
    category?: string;
    limit?: number;
  }): Array<{
    id: string;
    scope: "global" | "target" | "package";
    scopeValue: string | null;
    category: string;
    pattern: string;
    reasoning: string;
    createdAt: number;
    appliedCount: number;
  }> {
    return this.repos.triageMemories.listTriageMemories(opts);
  }

  deleteTriageMemory(id: string): boolean {
    return this.repos.triageMemories.deleteTriageMemory(id);
  }

  incrementMemoryAppliedCount(id: string): void {
    return this.repos.triageMemories.incrementMemoryAppliedCount(id);
  }

  ensureCaseWorkPlan(scanId: string): string | null {
    return this.repos.caseGraph.ensureCaseWorkPlan(scanId);
  }

  transitionCaseWorkItem(
    scanId: string,
    kind: WorkItemRecord["kind"],
    status: WorkItemRecord["status"],
    opts?: { summary?: string | null; owner?: string | null },
  ): void {
    return this.repos.caseGraph.transitionCaseWorkItem(scanId, kind, status, opts);
  }

  createScan(config: ScanConfig, id: string = randomUUID()): string {
    return this.repos.scans.createScan(config, id);
  }

  /** Persist an external report snapshot without granting its execution claims local authority. */
  importCiReport(input: Parameters<ScanRepository["importCiReport"]>[0]): { scanId: string; alreadyImported: boolean } {
    return this.repos.scans.importCiReport(input);
  }

  deleteScan(scanId: string): boolean {
    return this.repos.scans.deleteScan(scanId);
  }

  completeScan(scanId: string, summary: Record<string, unknown>): void {
    return this.repos.scans.completeScan(scanId, summary);
  }

  reopenScan(scanId: string): void {
    return this.repos.scans.reopenScan(scanId);
  }

  failScan(scanId: string, error: string): void {
    return this.repos.scans.failScan(scanId, error);
  }

  getScan(scanId: string) {
    return this.repos.scans.getScan(scanId);
  }

  listScans(limit = 20) {
    return this.repos.scans.listScans(limit);
  }

  listScansByTarget(target: string, opts?: { limit?: number }) {
    return this.repos.scans.listScansByTarget(target, opts);
  }

  upsertTarget(info: TargetInfo): string {
    return this.repos.targets.upsertTarget(info);
  }

  getTarget(url: string) {
    return this.repos.targets.getTarget(url);
  }

  saveFinding(scanId: string, finding: Finding): void {
    return this.repos.findings.saveFinding(scanId, finding);
  }

  getFinding(findingId: string) {
    return this.repos.findings.getFinding(findingId);
  }

  /**
   * Read path for the persisted `verification_result`, `reviewAnnotation`,
   * and `sourceVerification` fields. The first two retain their existing
   * source-fix gate semantics; a source-only check is never replay evidence.
   * Each key is omitted when absent, including for pre-migration rows.
   */
  getFindingReviewFields(findingId: string): PersistedFindingReviewFields {
    return this.repos.findings.getFindingReviewFields(findingId);
  }

  getFindings(scanId: string) {
    return this.repos.findings.getFindings(scanId);
  }

  getScanFindings(scanId: string) {
    return this.repos.findings.getScanFindings(scanId);
  }

  getLatestFindingForScan(scanId: string) {
    return this.repos.findings.getLatestFindingForScan(scanId);
  }

  /** Stable bounded keyset projection for read-only external findings APIs. */
  listFindingsApiPage(options: { limit: number; scanId?: string; severity?: string; status?: string; includeSuppressed?: boolean; before?: { timestamp: number; id: string } }) {
    return this.repos.findings.listFindingsApiPage(options);
  }

  listFindings(opts?: {
    scanId?: string;
    severity?: string;
    category?: string;
    status?: string;
    triageStatus?: string;
    limit?: number;
  }) {
    return this.repos.findings.listFindings(opts);
  }

  /** Globally rank current family assessments before the body/row limit. Historical review counts remain intact. */
  listFindingFamiliesByBusinessPriority(opts?: BusinessPriorityFindingOptions) {
    return this.repos.findings.listFindingFamiliesByBusinessPriority(opts);
  }

  /** Bounded row-level native --all list; historical rows are independently ranked. */
  listFindingsByBusinessPriority(opts?: BusinessPriorityFindingOptions) {
    return this.repos.findings.listFindingsByBusinessPriority(opts);
  }

  /** Uncapped paged metadata for exact cross-database latest-family merging; no evidence bodies. */
  iterateLatestFindingMetadata(opts?: Omit<BusinessPriorityFindingOptions, "limit">) {
    return this.repos.findings.iterateLatestFindingMetadata(opts);
  }

  getFindingFamilyMetadata(key: string, opts?: { scanId?: string }) {
    return this.repos.findings.getFindingFamilyMetadata(key, opts);
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
    return this.repos.findings.queryFindings(opts);
  }

  updateFindingStatus(findingId: string, status: string): void {
    return this.repos.findings.updateFindingStatus(findingId, status);
  }

  /** Operator business context is metadata; never changes verification or execution authority. */
  updateFindingImpactAssessment(findingId: string, assessment: ImpactAssessment | null): boolean {
    return this.repos.findings.updateFindingImpactAssessment(findingId, assessment);
  }

  saveFindingPocExecution(findingId: string, execution: unknown): void {
    return this.repos.findings.saveFindingPocExecution(findingId, execution);
  }

  updateFindingTriageByFingerprint(
    fingerprint: string,
    triageStatus: FindingTriageStatus,
    triageNote?: string,
  ): void {
    return this.repos.findings.updateFindingTriageByFingerprint(fingerprint, triageStatus, triageNote);
  }

  updateFindingWorkflowByFingerprint(
    fingerprint: string,
    workflowStatus: WorkflowStatus,
    workflowAssignee?: string | null,
  ): void {
    return this.repos.findings.updateFindingWorkflowByFingerprint(fingerprint, workflowStatus, workflowAssignee);
  }

  updateFindingTriage(findingId: string, triageStatus: FindingTriageStatus, triageNote?: string): void {
    return this.repos.findings.updateFindingTriage(findingId, triageStatus, triageNote);
  }

  getLatestFindingByFingerprint(fingerprint: string) {
    return this.repos.findings.getLatestFindingByFingerprint(fingerprint);
  }

  getRelatedFindings(fingerprint: string) {
    return this.repos.findings.getRelatedFindings(fingerprint);
  }

  transitionFindingStatus(findingId: string, newStatus: FindingStatusDB): void {
    return this.repos.findings.transitionFindingStatus(findingId, newStatus);
  }

  scoreFinding(findingId: string, score: number): void {
    return this.repos.findings.scoreFinding(findingId, score);
  }

  saveAttackResult(scanId: string, result: AttackResult): void {
    return this.repos.verification.saveAttackResult(scanId, result);
  }

  getAttackResults(scanId: string) {
    return this.repos.verification.getAttackResults(scanId);
  }

  addVerdict(verdict: AgentVerdict): void {
    return this.repos.verification.addVerdict(verdict);
  }

  getVerdicts(findingId: string) {
    return this.repos.verification.getVerdicts(findingId);
  }

  listVerdicts(findingIds?: string[]) {
    return this.repos.verification.listVerdicts(findingIds);
  }

  /** Compute consensus: all agree TRUE_POSITIVE → verified, all FALSE_POSITIVE → false-positive */
  computeConsensus(findingId: string): "verified" | "false-positive" | "disputed" | "pending" {
    return this.repos.verification.computeConsensus(findingId);
  }

  logEvent(event: Omit<PipelineEvent, "id">, options: { syncGraph?: boolean } = {}): string {
    return this.repos.pipeline.logEvent(event, options);
  }

  getEvents(scanId: string, opts?: { stage?: string; eventType?: string }) {
    return this.repos.pipeline.getEvents(scanId, opts);
  }

  /** Bounded retained receipts for explicit verification lifecycle recovery. */
  getRecentScanEvents(scanId: string, eventType: string, limit = 100, tools?: string[]) {
    return this.repos.pipeline.getRecentScanEvents(scanId, eventType, limit, tools);
  }

  listRecentEvents(limit = 50) {
    return this.repos.pipeline.listRecentEvents(limit);
  }

  /**
   * Read persisted events strictly after a durable `(timestamp, id)` cursor.
   * The UUID tie-breaker makes same-millisecond multi-process writes stable.
   */
  listEventsAfter(
    cursor: { timestamp: number; id: string } | undefined,
    limit = 250,
  ) {
    return this.repos.pipeline.listEventsAfter(cursor, limit);
  }

  saveSession(session: {
    id: string;
    scanId: string;
    agentRole: string;
    turnCount: number;
    messages: unknown[];
    toolContext: Record<string, unknown>;
    status: string;
  }): void {
    return this.repos.pipeline.saveSession(session);
  }

  getSession(scanId: string, agentRole: string) {
    return this.repos.pipeline.getSession(scanId, agentRole);
  }

  getSessionById(sessionId: string) {
    return this.repos.pipeline.getSessionById(sessionId);
  }

  listSessions(opts?: { scanIds?: string[]; status?: string }) {
    return this.repos.pipeline.listSessions(opts);
  }

  upsertCase(record: Omit<CaseRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }): void {
    return this.repos.caseWork.upsertCase(record);
  }

  getCase(caseId: string) {
    return this.repos.caseWork.getCase(caseId);
  }

  listCases(limit = 100) {
    return this.repos.caseWork.listCases(limit);
  }

  upsertWorkItem(record: Omit<WorkItemRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }): void {
    return this.repos.caseWork.upsertWorkItem(record);
  }

  listWorkItems(opts?: { caseId?: string; findingFingerprint?: string; status?: string; limit?: number }) {
    return this.repos.caseWork.listWorkItems(opts);
  }

  claimWorkItem(
    workItemId: string,
    workerId: string,
    opts?: {
      expectedStatus?: WorkItemRecord["status"];
      owner?: string | null;
      summary?: string | null;
    },
  ): boolean {
    return this.repos.caseWork.claimWorkItem(workItemId, workerId, opts);
  }

  upsertArtifact(record: Omit<ArtifactRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }): void {
    return this.repos.caseWork.upsertArtifact(record);
  }

  listArtifacts(opts?: { caseId?: string; findingFingerprint?: string; workItemId?: string; limit?: number }) {
    return this.repos.caseWork.listArtifacts(opts);
  }

  upsertWorker(record: Omit<WorkerRecord, "startedAt" | "updatedAt" | "heartbeatAt"> & {
    startedAt?: string;
    updatedAt?: string;
    heartbeatAt?: string;
  }): void {
    return this.repos.workers.upsertWorker(record);
  }

  listWorkers(limit = 50) {
    return this.repos.workers.listWorkers(limit);
  }

  stopWorkersByLabel(label: string, exceptId?: string): number {
    return this.repos.workers.stopWorkersByLabel(label, exceptId);
  }

  deleteWorkersByStatus(statuses: string | string[]): number {
    return this.repos.workers.deleteWorkersByStatus(statuses);
  }

  /**
   * Upsert a discovered foothold keyed by (credentialKind, valueHash). First
   * write records the discovery attribution (target/finding/scan/turn);
   * subsequent sightings bump `timesSeen` and refresh `lastScanId`/`lastSeenAt`
   * without overwriting the original discovery columns. Returns the stored row.
   *
   * Plaintext is never accepted here — the caller passes a precomputed
   * `valueHash` and a redacted `valuePreview`.
   */
  upsertPersistentCredential(input: PersistentCredentialUpsert): PersistentCredentialRow {
    return this.repos.trust.upsertPersistentCredential(input);
  }

  getPersistentCredential(credentialKind: string, valueHash: string): PersistentCredentialRow | undefined {
    return this.repos.trust.getPersistentCredential(credentialKind, valueHash);
  }

  listPersistentCredentials(query: PersistentCredentialQuery = {}): PersistentCredentialRow[] {
    return this.repos.trust.listPersistentCredentials(query);
  }

  /**
   * Upsert a directed trust edge keyed by
   * (srcKind, srcId, dstKind, dstId, relation). Re-observing an edge refreshes
   * `updatedAt` (and `confidence`/`note`/attribution when provided) rather than
   * inserting a duplicate. Returns the stored row.
   */
  upsertTrustGraphEdge(input: TrustGraphEdgeInput): TrustGraphEdgeRow {
    return this.repos.trust.upsertTrustGraphEdge(input);
  }

  listTrustGraphEdges(query: { srcKind?: string; srcId?: string; relation?: string; limit?: number } = {}): TrustGraphEdgeRow[] {
    return this.repos.trust.listTrustGraphEdges(query);
  }

  /** Get summary stats across all findings */
  getStats() {
    return this.repos.findings.getStats();
  }

  close(): void {
    this.sqlite.close();
  }

  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }
}
