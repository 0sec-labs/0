// PipelineRepository: persistence for pipeline.
import { asc, eq, desc, and, gt, inArray, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { PipelineEvent } from "@0/shared";
import * as schema from "../schema.js";

import { Repository } from "./base.js";

export class PipelineRepository extends Repository {

  // ── Pipeline Events (audit trail) ──

  logEvent(event: Omit<PipelineEvent, "id">, options: { syncGraph?: boolean } = {}): string {
    const id = randomUUID();
    this.db.insert(schema.pipelineEvents).values({
      id,
      scanId: event.scanId,
      stage: event.stage,
      eventType: event.eventType,
      findingId: event.findingId ?? null,
      agentRole: event.agentRole ?? null,
      source: event.source ?? "core",
      payload: JSON.stringify(event.payload),
      timestamp: event.timestamp,
    }).run();
    if (options.syncGraph !== false) this.repos.caseGraph.syncEventGraph(event, id);
    return id;
  }


  getEvents(scanId: string, opts?: { stage?: string; eventType?: string }) {
    const conditions = [eq(schema.pipelineEvents.scanId, scanId)];
    if (opts?.stage) conditions.push(eq(schema.pipelineEvents.stage, opts.stage));
    if (opts?.eventType) conditions.push(eq(schema.pipelineEvents.eventType, opts.eventType));

    return this.db
      .select()
      .from(schema.pipelineEvents)
      .where(and(...conditions))
      .orderBy(schema.pipelineEvents.timestamp)
      .all();
  }


  /** Bounded retained receipts for explicit verification lifecycle recovery. */
  getRecentScanEvents(scanId: string, eventType: string, limit = 100, tools?: string[]) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("invalid scan event limit");
    if (tools && (!tools.length || tools.length > 10 || tools.some(tool => !/^[a-z_]{1,64}$/.test(tool)))) throw new Error("invalid receipt tools");
    return this.db.select().from(schema.pipelineEvents)
      .where(and(eq(schema.pipelineEvents.scanId, scanId), eq(schema.pipelineEvents.eventType, eventType),
        tools ? inArray(sql<string>`CASE WHEN json_valid(${schema.pipelineEvents.payload}) THEN json_extract(${schema.pipelineEvents.payload}, '$.tool') ELSE '' END`, tools) : undefined))
      .orderBy(desc(schema.pipelineEvents.timestamp), desc(schema.pipelineEvents.id)).limit(limit).all();
  }


  listRecentEvents(limit = 50) {
    return this.db
      .select({
        id: schema.pipelineEvents.id,
        scanId: schema.pipelineEvents.scanId,
        scanTarget: schema.scans.target,
        stage: schema.pipelineEvents.stage,
        eventType: schema.pipelineEvents.eventType,
        findingId: schema.pipelineEvents.findingId,
        findingFingerprint: schema.findings.fingerprint,
        agentRole: schema.pipelineEvents.agentRole,
        source: schema.pipelineEvents.source,
        payload: schema.pipelineEvents.payload,
        timestamp: schema.pipelineEvents.timestamp,
      })
      .from(schema.pipelineEvents)
      .innerJoin(schema.scans, eq(schema.pipelineEvents.scanId, schema.scans.id))
      .leftJoin(schema.findings, eq(schema.pipelineEvents.findingId, schema.findings.id))
      .orderBy(desc(schema.pipelineEvents.timestamp))
      .limit(limit)
      .all();
  }


  /**
   * Read persisted events strictly after a durable `(timestamp, id)` cursor.
   * The UUID tie-breaker makes same-millisecond multi-process writes stable.
   */
  listEventsAfter(
    cursor: { timestamp: number; id: string } | undefined,
    limit = 250,
  ) {
    const selectEvents = () => this.db
      .select({
        id: schema.pipelineEvents.id,
        scanId: schema.pipelineEvents.scanId,
        scanTarget: schema.scans.target,
        stage: schema.pipelineEvents.stage,
        eventType: schema.pipelineEvents.eventType,
        findingId: schema.pipelineEvents.findingId,
        findingFingerprint: schema.findings.fingerprint,
        agentRole: schema.pipelineEvents.agentRole,
        source: schema.pipelineEvents.source,
        payload: schema.pipelineEvents.payload,
        timestamp: schema.pipelineEvents.timestamp,
      })
      .from(schema.pipelineEvents)
      .innerJoin(schema.scans, eq(schema.pipelineEvents.scanId, schema.scans.id))
      .leftJoin(schema.findings, eq(schema.pipelineEvents.findingId, schema.findings.id));

    if (!cursor) {
      return selectEvents()
        .orderBy(asc(schema.pipelineEvents.timestamp), asc(schema.pipelineEvents.id))
        .limit(limit)
        .all();
    }

    return selectEvents()
      .where(or(
        gt(schema.pipelineEvents.timestamp, cursor.timestamp),
        and(
          eq(schema.pipelineEvents.timestamp, cursor.timestamp),
          gt(schema.pipelineEvents.id, cursor.id),
        ),
      ))
      .orderBy(asc(schema.pipelineEvents.timestamp), asc(schema.pipelineEvents.id))
      .limit(limit)
      .all();
  }


  // ── Agent Sessions (resumable state) ──

  saveSession(session: {
    id: string;
    scanId: string;
    agentRole: string;
    turnCount: number;
    messages: unknown[];
    toolContext: Record<string, unknown>;
    status: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .insert(schema.agentSessions)
      .values({
        id: session.id,
        scanId: session.scanId,
        agentRole: session.agentRole,
        turnCount: session.turnCount,
        messages: JSON.stringify(session.messages),
        toolContext: JSON.stringify(session.toolContext),
        status: session.status,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.agentSessions.id,
        set: {
          turnCount: session.turnCount,
          messages: JSON.stringify(session.messages),
          toolContext: JSON.stringify(session.toolContext),
          status: session.status,
          updatedAt: now,
        },
      })
      .run();
    this.repos.caseGraph.syncSessionGraph(session);
  }


  getSession(scanId: string, agentRole: string) {
    return this.db
      .select()
      .from(schema.agentSessions)
      .where(
        and(
          eq(schema.agentSessions.scanId, scanId),
          eq(schema.agentSessions.agentRole, agentRole)
        )
      )
      .get();
  }


  getSessionById(sessionId: string) {
    return this.db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, sessionId))
      .get();
  }


  listSessions(opts?: { scanIds?: string[]; status?: string }) {
    const conditions: string[] = [];
    const params: Array<string> = [];

    if (opts?.scanIds?.length) {
      conditions.push(`scanId IN (${opts.scanIds.map(() => "?").join(",")})`);
      params.push(...opts.scanIds);
    }

    if (opts?.status) {
      conditions.push("status = ?");
      params.push(opts.status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.sqlite
      .prepare(`SELECT * FROM agent_sessions ${where} ORDER BY updatedAt DESC`)
      .all(...params) as Array<{
        id: string;
        scanId: string;
        agentRole: string;
        turnCount: number;
        messages: string;
        toolContext: string;
        status: string;
        createdAt: string;
        updatedAt: string;
      }>;
  }
}
