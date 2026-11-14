// WorkerRepository: persistence for workers.
import { desc } from "drizzle-orm";
import type { WorkerRecord } from "../../shared/index.js";
import * as schema from "../schema.js";

import { Repository } from "./base.js";

export class WorkerRepository extends Repository {

  upsertWorker(record: Omit<WorkerRecord, "startedAt" | "updatedAt" | "heartbeatAt"> & {
    startedAt?: string;
    updatedAt?: string;
    heartbeatAt?: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .insert(schema.workers)
      .values({
        id: record.id,
        role: record.role,
        status: record.status,
        label: record.label,
        currentCaseId: record.currentCaseId ?? null,
        currentWorkItemId: record.currentWorkItemId ?? null,
        currentScanId: record.currentScanId ?? null,
        pid: record.pid ?? null,
        host: record.host ?? null,
        lastError: record.lastError ?? null,
        heartbeatAt: record.heartbeatAt ?? now,
        startedAt: record.startedAt ?? now,
        updatedAt: record.updatedAt ?? now,
      })
      .onConflictDoUpdate({
        target: schema.workers.id,
        set: {
          role: record.role,
          status: record.status,
          label: record.label,
          currentCaseId: record.currentCaseId ?? null,
          currentWorkItemId: record.currentWorkItemId ?? null,
          currentScanId: record.currentScanId ?? null,
          pid: record.pid ?? null,
          host: record.host ?? null,
          lastError: record.lastError ?? null,
          heartbeatAt: record.heartbeatAt ?? now,
          updatedAt: record.updatedAt ?? now,
        },
      })
      .run();
  }


  listWorkers(limit = 50) {
    return this.db.select().from(schema.workers).orderBy(desc(schema.workers.heartbeatAt)).limit(limit).all();
  }


  stopWorkersByLabel(label: string, exceptId?: string): number {
    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(`
        UPDATE workers
        SET status = 'stopped',
            currentCaseId = NULL,
            currentWorkItemId = NULL,
            currentScanId = NULL,
            updatedAt = @updatedAt,
            heartbeatAt = @heartbeatAt,
            lastError = CASE
              WHEN lastError IS NULL OR lastError = '' THEN 'Superseded by a newer worker with the same label.'
              ELSE lastError
            END
        WHERE label = @label
          AND (@exceptId IS NULL OR id != @exceptId)
          AND status != 'stopped'
      `)
      .run({
        label,
        exceptId: exceptId ?? null,
        updatedAt: now,
        heartbeatAt: now,
      });

    return result.changes;
  }


  deleteWorkersByStatus(statuses: string | string[]): number {
    const values = Array.isArray(statuses) ? statuses : [statuses];
    if (values.length === 0) return 0;

    const placeholders = values.map(() => "?").join(",");
    const result = this.sqlite
      .prepare(`DELETE FROM workers WHERE status IN (${placeholders})`)
      .run(...values);

    return result.changes;
  }
}
