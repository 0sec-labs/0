// CaseWorkRepository: persistence for caseWork.
import { eq, desc, and } from "drizzle-orm";
import type { ArtifactRecord, CaseRecord, WorkItemRecord } from "@0/shared";
import * as schema from "../schema.js";

import { Repository } from "./base.js";

export class CaseWorkRepository extends Repository {

  // ── Cases / Work Items / Artifacts ──

  upsertCase(record: Omit<CaseRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }): void {
    const now = new Date().toISOString();
    this.db
      .insert(schema.cases)
      .values({
        id: record.id,
        target: record.target,
        targetType: record.targetType,
        latestScanId: record.latestScanId ?? null,
        status: record.status,
        createdAt: record.createdAt ?? now,
        updatedAt: record.updatedAt ?? now,
      })
      .onConflictDoUpdate({
        target: schema.cases.id,
        set: {
          target: record.target,
          targetType: record.targetType,
          latestScanId: record.latestScanId ?? null,
          status: record.status,
          updatedAt: record.updatedAt ?? now,
        },
      })
      .run();
  }


  getCase(caseId: string) {
    return this.db.select().from(schema.cases).where(eq(schema.cases.id, caseId)).get();
  }


  listCases(limit = 100) {
    return this.db.select().from(schema.cases).orderBy(desc(schema.cases.updatedAt)).limit(limit).all();
  }


  upsertWorkItem(record: Omit<WorkItemRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }): void {
    const now = new Date().toISOString();
    this.db
      .insert(schema.workItems)
      .values({
        id: record.id,
        caseId: record.caseId,
        findingFingerprint: record.findingFingerprint ?? null,
        kind: record.kind,
        title: record.title,
        owner: record.owner ?? null,
        status: record.status,
        summary: record.summary ?? null,
        dependsOn: record.dependsOn ?? null,
        createdAt: record.createdAt ?? now,
        updatedAt: record.updatedAt ?? now,
      })
      .onConflictDoUpdate({
        target: schema.workItems.id,
        set: {
          caseId: record.caseId,
          findingFingerprint: record.findingFingerprint ?? null,
          kind: record.kind,
          title: record.title,
          owner: record.owner ?? null,
          status: record.status,
          summary: record.summary ?? null,
          dependsOn: record.dependsOn ?? null,
          updatedAt: record.updatedAt ?? now,
        },
      })
      .run();
  }


  listWorkItems(opts?: { caseId?: string; findingFingerprint?: string; status?: string; limit?: number }) {
    const conditions = [];
    if (opts?.caseId) conditions.push(eq(schema.workItems.caseId, opts.caseId));
    if (opts?.findingFingerprint) conditions.push(eq(schema.workItems.findingFingerprint, opts.findingFingerprint));
    if (opts?.status) conditions.push(eq(schema.workItems.status, opts.status));

    const query = this.db.select().from(schema.workItems).orderBy(desc(schema.workItems.updatedAt)).limit(opts?.limit ?? 200);
    if (conditions.length > 0) return query.where(and(...conditions)).all();
    return query.all();
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
    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(`
        UPDATE work_items
        SET status = 'in_progress',
            owner = @owner,
            summary = COALESCE(@summary, summary),
            updatedAt = @updatedAt
        WHERE id = @id
          AND status = @expectedStatus
      `)
      .run({
        id: workItemId,
        owner: opts?.owner ?? workerId,
        summary: opts?.summary ?? null,
        updatedAt: now,
        expectedStatus: opts?.expectedStatus ?? "todo",
      });

    return result.changes > 0;
  }


  upsertArtifact(record: Omit<ArtifactRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }): void {
    const now = new Date().toISOString();
    this.db
      .insert(schema.artifacts)
      .values({
        id: record.id,
        caseId: record.caseId,
        findingFingerprint: record.findingFingerprint ?? null,
        workItemId: record.workItemId ?? null,
        kind: record.kind,
        label: record.label,
        content: record.content ?? null,
        metadata: record.metadata ? JSON.stringify(record.metadata) : null,
        createdAt: record.createdAt ?? now,
        updatedAt: record.updatedAt ?? now,
      })
      .onConflictDoUpdate({
        target: schema.artifacts.id,
        set: {
          caseId: record.caseId,
          findingFingerprint: record.findingFingerprint ?? null,
          workItemId: record.workItemId ?? null,
          kind: record.kind,
          label: record.label,
          content: record.content ?? null,
          metadata: record.metadata ? JSON.stringify(record.metadata) : null,
          updatedAt: record.updatedAt ?? now,
        },
      })
      .run();
  }


  listArtifacts(opts?: { caseId?: string; findingFingerprint?: string; workItemId?: string; limit?: number }) {
    const conditions = [];
    if (opts?.caseId) conditions.push(eq(schema.artifacts.caseId, opts.caseId));
    if (opts?.findingFingerprint) conditions.push(eq(schema.artifacts.findingFingerprint, opts.findingFingerprint));
    if (opts?.workItemId) conditions.push(eq(schema.artifacts.workItemId, opts.workItemId));

    const query = this.db.select().from(schema.artifacts).orderBy(desc(schema.artifacts.updatedAt)).limit(opts?.limit ?? 200);
    if (conditions.length > 0) return query.where(and(...conditions)).all();
    return query.all();
  }
}
