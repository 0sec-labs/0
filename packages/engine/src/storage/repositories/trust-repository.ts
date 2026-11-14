// TrustRepository: persistence for trust.
import { and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { type PersistentCredentialRow, type PersistentCredentialUpsert, type PersistentCredentialQuery, type TrustGraphEdgeRow, type TrustGraphEdgeInput } from "../types.js";
import { Repository } from "./base.js";

export class TrustRepository extends Repository {

  // ── Persistent credential store (0#771) ──

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
    const now = new Date().toISOString();
    const existing = this.owner.getPersistentCredential(input.credentialKind, input.valueHash);
    if (existing) {
      this.sqlite
        .prepare(
          `UPDATE persistent_credentials
             SET timesSeen = timesSeen + 1,
                 lastScanId = @lastScanId,
                 lastSeenAt = @lastSeenAt,
                 context = COALESCE(context, @context)
           WHERE id = @id`,
        )
        .run({
          id: existing.id,
          lastScanId: input.scanId ?? existing.lastScanId ?? null,
          lastSeenAt: now,
          context: input.context ?? null,
        });
      return this.owner.getPersistentCredential(input.credentialKind, input.valueHash)!;
    }

    const id = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO persistent_credentials
           (id, credentialKind, valueHash, valuePreview, context, target,
            firstScanId, firstFindingId, firstSource, firstTurn, lastScanId,
            timesSeen, firstSeenAt, lastSeenAt)
         VALUES
           (@id, @credentialKind, @valueHash, @valuePreview, @context, @target,
            @firstScanId, @firstFindingId, @firstSource, @firstTurn, @lastScanId,
            1, @firstSeenAt, @lastSeenAt)`,
      )
      .run({
        id,
        credentialKind: input.credentialKind,
        valueHash: input.valueHash,
        valuePreview: input.valuePreview,
        context: input.context ?? null,
        target: input.target ?? null,
        firstScanId: input.scanId ?? null,
        firstFindingId: input.findingId ?? null,
        firstSource: input.source ?? null,
        firstTurn: input.turn ?? null,
        lastScanId: input.scanId ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    return this.owner.getPersistentCredential(input.credentialKind, input.valueHash)!;
  }


  getPersistentCredential(credentialKind: string, valueHash: string): PersistentCredentialRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT * FROM persistent_credentials WHERE credentialKind = ? AND valueHash = ?`,
      )
      .get(credentialKind, valueHash) as PersistentCredentialRow | undefined;
  }


  listPersistentCredentials(query: PersistentCredentialQuery = {}): PersistentCredentialRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.credentialKind) {
      where.push("credentialKind = ?");
      params.push(query.credentialKind);
    }
    if (query.target) {
      where.push("target = ?");
      params.push(query.target);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = query.limit ?? 500;
    return this.sqlite
      .prepare(
        `SELECT * FROM persistent_credentials ${whereSql} ORDER BY lastSeenAt DESC LIMIT ${limit}`,
      )
      .all(...params) as PersistentCredentialRow[];
  }


  // ── Trust graph edges (0#771) ──

  /**
   * Upsert a directed trust edge keyed by
   * (srcKind, srcId, dstKind, dstId, relation). Re-observing an edge refreshes
   * `updatedAt` (and `confidence`/`note`/attribution when provided) rather than
   * inserting a duplicate. Returns the stored row.
   */
  upsertTrustGraphEdge(input: TrustGraphEdgeInput): TrustGraphEdgeRow {
    const now = new Date().toISOString();
    const existing = this.sqlite
      .prepare(
        `SELECT * FROM trust_graph_edges
          WHERE srcKind = ? AND srcId = ? AND dstKind = ? AND dstId = ? AND relation = ?`,
      )
      .get(input.srcKind, input.srcId, input.dstKind, input.dstId, input.relation) as
      | TrustGraphEdgeRow
      | undefined;

    if (existing) {
      this.sqlite
        .prepare(
          `UPDATE trust_graph_edges
              SET scanId = COALESCE(@scanId, scanId),
                  findingId = COALESCE(@findingId, findingId),
                  confidence = COALESCE(@confidence, confidence),
                  note = COALESCE(@note, note),
                  updatedAt = @updatedAt
            WHERE id = @id`,
        )
        .run({
          id: existing.id,
          scanId: input.scanId ?? null,
          findingId: input.findingId ?? null,
          confidence: input.confidence ?? null,
          note: input.note ?? null,
          updatedAt: now,
        });
      return { ...existing, updatedAt: now };
    }

    const id = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO trust_graph_edges
           (id, srcKind, srcId, dstKind, dstId, relation, scanId, findingId,
            confidence, note, createdAt, updatedAt)
         VALUES
           (@id, @srcKind, @srcId, @dstKind, @dstId, @relation, @scanId,
            @findingId, @confidence, @note, @createdAt, @updatedAt)`,
      )
      .run({
        id,
        srcKind: input.srcKind,
        srcId: input.srcId,
        dstKind: input.dstKind,
        dstId: input.dstId,
        relation: input.relation,
        scanId: input.scanId ?? null,
        findingId: input.findingId ?? null,
        confidence: input.confidence ?? null,
        note: input.note ?? null,
        createdAt: now,
        updatedAt: now,
      });
    return {
      id,
      srcKind: input.srcKind,
      srcId: input.srcId,
      dstKind: input.dstKind,
      dstId: input.dstId,
      relation: input.relation,
      scanId: input.scanId ?? null,
      findingId: input.findingId ?? null,
      confidence: input.confidence ?? null,
      note: input.note ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }


  listTrustGraphEdges(query: { srcKind?: string; srcId?: string; relation?: string; limit?: number } = {}): TrustGraphEdgeRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.srcKind) {
      where.push("srcKind = ?");
      params.push(query.srcKind);
    }
    if (query.srcId) {
      where.push("srcId = ?");
      params.push(query.srcId);
    }
    if (query.relation) {
      where.push("relation = ?");
      params.push(query.relation);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = query.limit ?? 500;
    return this.sqlite
      .prepare(
        `SELECT * FROM trust_graph_edges ${whereSql} ORDER BY updatedAt DESC LIMIT ${limit}`,
      )
      .all(...params) as TrustGraphEdgeRow[];
  }
}
