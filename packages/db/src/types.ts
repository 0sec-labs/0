// Shared row and option types for the database facade and repositories.
import { and, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as schema from "./schema.js";


// Drizzle infers UUID-shaped text from Node's randomUUID default, while SQLite
// itself permits existing legacy and orchestrator-provided string identifiers.
export type SQLiteScanId = `${string}-${string}-${string}-${string}-${string}`;


// ── Persistent credential store + trust graph (0#771) ──

/** A stored persistent-credential row. NEVER carries the plaintext secret. */
export interface PersistentCredentialRow {
  id: string;
  credentialKind: string;
  valueHash: string;
  valuePreview: string;
  context: string | null;
  target: string | null;
  firstScanId: string | null;
  firstFindingId: string | null;
  firstSource: string | null;
  firstTurn: number | null;
  lastScanId: string | null;
  timesSeen: number;
  firstSeenAt: string;
  lastSeenAt: string;
}


/**
 * Input to {@link osecDB.upsertPersistentCredential}. The caller is
 * responsible for hashing the secret — `valueHash` + `valuePreview` are the
 * only representations of the value that reach the DB. Plaintext must never be
 * passed here.
 */
export interface PersistentCredentialUpsert {
  credentialKind: string;
  valueHash: string;
  valuePreview: string;
  context?: string | null;
  target?: string | null;
  scanId?: string | null;
  findingId?: string | null;
  source?: string | null;
  turn?: number | null;
}


export interface PersistentCredentialQuery {
  credentialKind?: string;
  target?: string;
  limit?: number;
}


export interface TrustGraphEdgeRow {
  id: string;
  srcKind: string;
  srcId: string;
  dstKind: string;
  dstId: string;
  relation: string;
  scanId: string | null;
  findingId: string | null;
  confidence: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}


export interface TrustGraphEdgeInput {
  srcKind: string;
  srcId: string;
  dstKind: string;
  dstId: string;
  relation: string;
  scanId?: string | null;
  findingId?: string | null;
  confidence?: number | null;
  note?: string | null;
}


export type OsecDbOpenOptions = {
  /**
   * Open an existing database for reads without migrations, schema DDL, stale
   * lock recovery, or directory creation. Use this for a second process
   * inspecting a database owned by a live dashboard or worker.
   */
  readOnly?: boolean;
};
