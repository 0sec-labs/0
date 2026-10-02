import { randomUUID, createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { ensureDatabaseDirectory } from "./db-directory.js";
import { resolveOsecDbPath } from "./database.js";
import { createShimmedDatabase, type ShimmedDatabase } from "./wasm-shim.js";

export class LearningStoreError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); this.name = "LearningStoreError"; }
}
export interface LearningSourceLink { path: string; hash: string }
export interface LearningEventInput {
  idempotencyKey: string; projectId: string; kind: string; outcome: string; summary: string;
  evidenceStrength?: "operational" | "hypothesis" | "verified" | "human-feedback";
  workflowId?: string; workflowRevision?: number; executionId?: string; runId?: string; stepId?: string;
  sourceLinks?: LearningSourceLink[]; evidenceRefs?: string[]; evidenceDigests?: string[];
}
export interface LearningEvent extends LearningEventInput { id: string; createdAt: string }
export type KnowledgeStatus = "current" | "stale" | "disabled";
export interface KnowledgeInput { projectId: string; summary: string; evidenceEventIds: string[]; sourceLinks: LearningSourceLink[] }
export interface KnowledgeEntry extends KnowledgeInput { id: string; status: KnowledgeStatus; createdAt: string; updatedAt: string }
export type ImprovementStatus = "applied" | "canary" | "proposed" | "evaluating" | "validated" | "rejected" | "active" | "retired";
export interface LearningRegistryProvenance { registryVersionId: string; registryStorePath: string; snapshotDigest: string; registryStatus: "candidate" | "canary" | "active" | "retired" }
export interface ImprovementInput { projectId: string; kind: string; targetId: string; baseVersion: string; proposal: string; evidenceEventIds: string[]; artifactDigest?: string; registry?: LearningRegistryProvenance }
export interface LearningEvaluationInput { suiteDigest: string; baselineDigest: string; candidateDigest: string; passed: boolean; outcome?: "passed" | "failed" | "inconclusive"; evaluatorDigest?: string; evaluationKind?: "output-fixture" | "security-proof"; metrics: Record<string, number> }
export interface LearningEvaluation extends LearningEvaluationInput { id: string; createdAt: string }
export interface ImprovementCandidate extends ImprovementInput { id: string; status: ImprovementStatus; revision: number; evaluations: LearningEvaluation[]; createdAt: string; updatedAt: string; previousActiveId?: string }
export interface LearningWork { id: string; eventId: string; kind: string; status: "pending" | "claimed" | "completed"; attempts: number; availableAt: number; leaseUntil: number | null; claimToken: string | null; owner: string | null }
export interface LearningListOptions { projectId?: string; limit?: number }

/** Normalize source targets exactly once at capture time, without fetching remote targets. */
export function learningProjectId(target: string): string {
  let identity = target.trim();
  const sourceTarget = identity.startsWith("source:");
  const path = sourceTarget ? identity.slice("source:".length).trim() : identity;
  // Arbitrary explicit project IDs retain their spelling. URLs remain remote identities,
  // including source: URLs; credential-bearing URLs are only ever included in the hash.
  const remote = /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
  if (!remote && path && (sourceTarget || isAbsolute(path) || /^\.{1,2}(?:\/|$)/.test(path) || path.startsWith("~/"))) {
    identity = resolve(path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
    try { identity = realpathSync(identity); } catch { /* Missing source targets still have a stable absolute identity. */ }
  }
  return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}
export function learningArtifactDigest(proposal: string): string { return `sha256:${createHash("sha256").update(proposal).digest("hex")}`; }
function fail(message: string, status = 400): never { throw new LearningStoreError(message, status); }
function bounded(value: unknown, name: string, max = 256): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /\0/.test(value)) fail(`Invalid ${name}.`);
  // This store accepts structured summaries, never credential or opaque payload capture.
  if (/-----BEGIN .*PRIVATE KEY|(?:api[_-]?key|authorization|password|access[_-]?token)\s*[:=]\s*\S+|\b(?:sk-|ghp_)[A-Za-z0-9_-]{16,}/i.test(value)) fail(`Credential-like content in ${name}.`);
}
function refs(values: unknown, name: string): asserts values is string[] {
  if (!Array.isArray(values) || values.length > 64) fail(`Invalid ${name}.`);
  for (const value of values) bounded(value, name, 1024);
}
function sources(value: unknown): asserts value is LearningSourceLink[] {
  if (!Array.isArray(value) || value.length > 64) fail("Invalid source links.");
  for (const item of value) { if (!item || typeof item !== "object" || Object.keys(item).some(key => !["path", "hash"].includes(key))) fail("Invalid source link."); bounded(item.path, "source path", 4096); bounded(item.hash, "source hash"); }
}
function limit(value?: number): number { return Number.isInteger(value) && value! > 0 ? Math.min(value!, 200) : 100; }
function read<T>(db: ShimmedDatabase, table: string, id: string): T | null { const row = db.prepare(`SELECT body FROM ${table} WHERE id = ?`).all(id)[0] as { body: string } | undefined; return row ? JSON.parse(row.body) as T : null; }
function write(db: ShimmedDatabase, table: string, value: { id: string; projectId: string; updatedAt?: string; createdAt: string }): void { db.prepare(`INSERT INTO ${table}(id,project_id,body,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at`).run(value.id, value.projectId, JSON.stringify(value), value.updatedAt ?? value.createdAt); }
export function initializeLearningTables(db: ShimmedDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS learning_events(id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_knowledge(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_candidates(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_suggestion_keys(key TEXT PRIMARY KEY,candidate_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_active(project_id TEXT NOT NULL,kind TEXT NOT NULL,target_id TEXT NOT NULL,candidate_id TEXT NOT NULL,PRIMARY KEY(project_id,kind,target_id));
    CREATE TABLE IF NOT EXISTS learning_work(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,lease_until INTEGER,claim_token TEXT,owner TEXT,UNIQUE(event_id,kind));
    CREATE INDEX IF NOT EXISTS learning_events_project ON learning_events(project_id,updated_at);
    CREATE INDEX IF NOT EXISTS learning_work_ready ON learning_work(status,available_at,lease_until);`);
}
/** Can be called inside the workflow store transaction: event + outbox commit together. */
export function appendLearningEvent(db: ShimmedDatabase, input: LearningEventInput): LearningEvent {
  const allowed = ["idempotencyKey", "projectId", "kind", "outcome", "summary", "evidenceStrength", "workflowId", "workflowRevision", "executionId", "runId", "stepId", "sourceLinks", "evidenceRefs", "evidenceDigests"];
  if (!input || typeof input !== "object" || Object.keys(input).some(key => !allowed.includes(key))) fail("Invalid learning event fields.");
  for (const field of ["idempotencyKey", "projectId", "kind", "outcome"] as const) bounded(input[field], field);
  bounded(input.summary, "summary", 4000);
  for (const field of ["workflowId", "executionId", "runId", "stepId"] as const) if (input[field] !== undefined) bounded(input[field], field);
  if (input.workflowRevision !== undefined && (!Number.isSafeInteger(input.workflowRevision) || input.workflowRevision < 1)) fail("Invalid workflow revision.");
  if (input.evidenceStrength !== undefined && !["operational", "hypothesis", "verified", "human-feedback"].includes(input.evidenceStrength)) fail("Invalid evidence strength.");
  if (input.sourceLinks !== undefined) sources(input.sourceLinks);
  if (input.evidenceRefs !== undefined) refs(input.evidenceRefs, "evidence refs");
  if (input.evidenceDigests !== undefined) refs(input.evidenceDigests, "evidence digests");
  const existing = db.prepare("SELECT body FROM learning_events WHERE idempotency_key=?").all(input.idempotencyKey)[0] as { body: string } | undefined;
  if (existing) {
    const event = JSON.parse(existing.body) as LearningEvent;
    const { id: _id, createdAt: _createdAt, ...original } = event;
    // Stable field ordering, including optional fields, permits retries from serialized jobs.
    const normalize = (v: object) => JSON.stringify(Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b))));
    if (normalize(original) !== normalize(input)) fail("Idempotency key already describes a different event.", 409);
    return event;
  }
  const event: LearningEvent = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  db.prepare("INSERT INTO learning_events(id,idempotency_key,project_id,body,updated_at) VALUES(?,?,?,?,?)").run(event.id, event.idempotencyKey, event.projectId, JSON.stringify(event), event.createdAt);
  return event;
}
export function enqueueLearningWork(db: ShimmedDatabase, eventId: string, kind = "derive-knowledge"): LearningWork {
  bounded(eventId, "event ID"); bounded(kind, "work kind");
  if (!read(db, "learning_events", eventId)) fail("Learning event not found.", 404);
  db.prepare("INSERT OR IGNORE INTO learning_work(id,event_id,kind,status,available_at) VALUES(?,?,?,'pending',?)").run(randomUUID(), eventId, kind, Date.now());
  return workRow(db.prepare("SELECT * FROM learning_work WHERE event_id=? AND kind=?").all(eventId, kind)[0] as Record<string, unknown>);
}
function workRow(row: Record<string, unknown>): LearningWork { return { id: String(row.id), eventId: String(row.event_id), kind: String(row.kind), status: row.status as LearningWork["status"], attempts: Number(row.attempts), availableAt: Number(row.available_at), leaseUntil: row.lease_until === null ? null : Number(row.lease_until), claimToken: row.claim_token === null ? null : String(row.claim_token), owner: row.owner === null ? null : String(row.owner) }; }

/** Tenant-local persistence. Trusted server evaluators alone may record evaluation receipts. */
export class LearningStore {
  readonly #db: ShimmedDatabase;
  readonly #ownsDatabase: boolean;
  constructor(dbPath?: string | ShimmedDatabase) { this.#ownsDatabase = typeof dbPath !== "object"; if (typeof dbPath === "object") this.#db = dbPath; else { const path = resolveOsecDbPath(dbPath); ensureDatabaseDirectory(path); this.#db = createShimmedDatabase(path); } this.#db.pragma("busy_timeout = 5000"); initializeLearningTables(this.#db); }
  close(): void { if (this.#ownsDatabase) this.#db.close(); }
  appendEvent(input: LearningEventInput): LearningEvent { return this.#db.transaction(() => appendLearningEvent(this.#db, input))(); }
  recordExperience(input: LearningEventInput, kind = "derive-knowledge"): LearningEvent { return this.#db.transaction(() => { const event = appendLearningEvent(this.#db, input); enqueueLearningWork(this.#db, event.id, kind); return event; })(); }
  getEvent(id: string): LearningEvent | null { return read(this.#db, "learning_events", id); }
  #list<T>(table: string, options: LearningListOptions = {}): T[] { return this.#db.prepare(`SELECT body FROM ${table} WHERE (? IS NULL OR project_id=?) ORDER BY updated_at DESC,id LIMIT ?`).all(options.projectId ?? null, options.projectId ?? null, limit(options.limit)).map(row => JSON.parse((row as {body: string}).body) as T); }
  listEvents(options?: LearningListOptions): LearningEvent[] { return this.#list("learning_events", options); }
  listKnowledge(options?: LearningListOptions): KnowledgeEntry[] { return this.#list("learning_knowledge", options); }
  getKnowledge(id: string): KnowledgeEntry | null { return read(this.#db, "learning_knowledge", id); }
  #checkEvidence(projectId: string, ids: string[]): void { refs(ids, "evidence event IDs"); if (!ids.length) fail("Evidence is required."); for (const id of ids) { const event = this.getEvent(id); if (!event || event.projectId !== projectId) fail("Evidence must belong to the same project."); } }
  putKnowledge(input: KnowledgeInput): KnowledgeEntry {
    bounded(input.projectId, "project ID"); bounded(input.summary, "knowledge summary", 4000); sources(input.sourceLinks); this.#checkEvidence(input.projectId, input.evidenceEventIds);
    // A new run or memory-record ID must not undo an operator's choice to stop
    // using the same source lesson. Fresh source hashes still admit a new lesson.
    if (input.sourceLinks.length) {
      const fingerprint = (links: LearningSourceLink[]) => JSON.stringify([...links].sort((a, b) => a.path.localeCompare(b.path) || a.hash.localeCompare(b.hash)));
      const matching = this.#db.prepare("SELECT body FROM learning_knowledge WHERE project_id=? AND json_extract(body,'$.summary')=? AND json_extract(body,'$.status')='disabled'").all(input.projectId, input.summary);
      for (const row of matching) {
        const prior = JSON.parse((row as { body: string }).body) as KnowledgeEntry;
        if (fingerprint(prior.sourceLinks) === fingerprint(input.sourceLinks)) return prior;
      }
    }
    const identity = `knowledge:${createHash("sha256").update(JSON.stringify({ projectId: input.projectId, summary: input.summary, sourceLinks: [...input.sourceLinks].sort((a,b) => a.path.localeCompare(b.path)), evidenceEventIds: [...input.evidenceEventIds].sort() })).digest("hex")}`;
    const existing = this.getKnowledge(identity); if (existing) return existing;
    const now = new Date().toISOString(); const entry: KnowledgeEntry = { projectId: input.projectId, summary: input.summary, sourceLinks: input.sourceLinks, evidenceEventIds: input.evidenceEventIds, id: identity, status: "current", createdAt: now, updatedAt: now }; write(this.#db, "learning_knowledge", entry); return entry;
  }
  setKnowledgeStatus(id: string, status: KnowledgeStatus): KnowledgeEntry {
    if (!["current", "stale", "disabled"].includes(status)) fail("Invalid knowledge status.");
    const entry = this.getKnowledge(id); if (!entry) fail("Knowledge not found.", 404);
    // Stale source-backed knowledge needs a new evidence entry, never merely a status reset.
    if (status === "current" && entry.status !== "current") fail("Retain fresh evidence before reactivating knowledge.", 409);
    entry.status = status; entry.updatedAt = new Date().toISOString(); write(this.#db, "learning_knowledge", entry); return entry;
  }
  invalidateKnowledge(projectId: string, currentHashes: Record<string, string>): number {
    bounded(projectId, "project ID");
    return this.#db.transaction(() => { let count = 0; const rows = this.#db.prepare("SELECT body FROM learning_knowledge WHERE project_id=?").all(projectId); for (const row of rows) { const entry = JSON.parse((row as {body:string}).body) as KnowledgeEntry; if (entry.status === "current" && entry.sourceLinks.some(link => !Object.hasOwn(currentHashes, link.path) || currentHashes[link.path] !== link.hash)) { this.setKnowledgeStatus(entry.id, "stale"); count++; } } return count; })();
  }
  createCandidate(input: ImprovementInput): ImprovementCandidate {
    for (const field of ["projectId", "kind", "targetId", "baseVersion"] as const) bounded(input[field], field); bounded(input.proposal, "proposal", 16000); this.#checkEvidence(input.projectId, input.evidenceEventIds);
    if (input.artifactDigest !== undefined && input.artifactDigest !== learningArtifactDigest(input.proposal)) fail("Candidate artifact digest mismatch.");
    if (input.registry) { for (const field of ["registryVersionId", "registryStorePath", "snapshotDigest"] as const) bounded(input.registry[field], field, 4096); if (!["candidate", "canary", "active", "retired"].includes(input.registry.registryStatus)) fail("Invalid registry status."); }
    const now = new Date().toISOString(); const value: ImprovementCandidate = { projectId: input.projectId, kind: input.kind, targetId: input.targetId, baseVersion: input.baseVersion, proposal: input.proposal, evidenceEventIds: input.evidenceEventIds, artifactDigest: learningArtifactDigest(input.proposal), ...(input.registry ? {registry: input.registry} : {}), id: randomUUID(), status: "proposed", revision: 1, evaluations: [], createdAt: now, updatedAt: now }; write(this.#db, "learning_candidates", value); return value;
  }
  createWorkflowSuggestion(input: ImprovementInput): ImprovementCandidate | null {
    if (input.kind !== "workflow-restore" || input.registry) fail("Invalid workflow suggestion.");
    const key = learningArtifactDigest(JSON.stringify([input.projectId,input.targetId,input.baseVersion,input.proposal]));
    return this.#db.transaction(() => {
      if (this.#db.prepare("SELECT candidate_id FROM learning_suggestion_keys WHERE key=?").all(key).length) return null;
      const candidate = this.createCandidate(input);
      this.#db.prepare("INSERT INTO learning_suggestion_keys(key,candidate_id) VALUES(?,?)").run(key,candidate.id);
      return candidate;
    })();
  }
  getCandidate(id: string): ImprovementCandidate | null { return read(this.#db, "learning_candidates", id); }
  listCandidates(options?: LearningListOptions): ImprovementCandidate[] { return this.#list("learning_candidates", options); }
  #candidate(id: string, revision: number): ImprovementCandidate { const value = this.getCandidate(id); if (!value) fail("Candidate not found.", 404); if (value.revision !== revision) fail("Candidate changed. Reload before updating.", 409); return value; }
  #saveCandidate(value: ImprovementCandidate): ImprovementCandidate { value.revision++; value.updatedAt = new Date().toISOString(); write(this.#db, "learning_candidates", value); return value; }
  transitionCandidate(id: string, revision: number, status: ImprovementStatus): ImprovementCandidate {
    return this.#db.transaction(() => { const value = this.#candidate(id, revision); const allowed: Partial<Record<ImprovementStatus, ImprovementStatus[]>> = { proposed: ["evaluating", "rejected"], evaluating: ["rejected"], validated: ["rejected"] }; if (!allowed[value.status]?.includes(status)) fail("Invalid candidate transition.", 409); value.status = status; return this.#saveCandidate(value); })();
  }
  recordEvaluation(id: string, revision: number, input: LearningEvaluationInput): ImprovementCandidate {
    for (const field of ["suiteDigest", "baselineDigest", "candidateDigest"] as const) bounded(input[field], field);
    if (input.evaluatorDigest !== undefined) bounded(input.evaluatorDigest, "evaluator digest");
    if (input.evaluationKind !== undefined && !["output-fixture", "security-proof"].includes(input.evaluationKind)) fail("Invalid evaluation kind.");
    if (input.outcome !== undefined && !["passed", "failed", "inconclusive"].includes(input.outcome)) fail("Invalid evaluation outcome.");
    if (input.outcome !== undefined && input.passed !== (input.outcome === "passed")) fail("Contradictory evaluation outcome.");
    if (typeof input.passed !== "boolean" || !input.metrics || typeof input.metrics !== "object" || Array.isArray(input.metrics) || Object.keys(input.metrics).length > 32 || Object.entries(input.metrics).some(([key, value]) => key.length > 128 || typeof value !== "number" || !Number.isFinite(value))) fail("Invalid evaluation metrics.");
    return this.#db.transaction(() => { const value = this.#candidate(id, revision); if (value.evaluations.length >= 64) fail("Too many evaluation receipts."); if (value.status !== "evaluating") fail("Candidate is not evaluating.", 409); if (input.candidateDigest !== value.artifactDigest) fail("Evaluation does not match the candidate artifact.", 409); value.evaluations.push({ ...(input.evaluatorDigest ? {evaluatorDigest: input.evaluatorDigest} : {}), ...(input.evaluationKind ? {evaluationKind: input.evaluationKind} : {}), ...(input.outcome ? {outcome: input.outcome} : {}), suiteDigest: input.suiteDigest, baselineDigest: input.baselineDigest, candidateDigest: input.candidateDigest, passed: input.passed, metrics: input.metrics, id: randomUUID(), createdAt: new Date().toISOString() }); value.status = input.outcome === "inconclusive" ? "evaluating" : input.passed ? "validated" : "rejected"; return this.#saveCandidate(value); })();
  }
  /** Reviewed workflow edit, distinct from evaluated security deployment. */
  markWorkflowSuggestionApplied(id: string, revision: number): ImprovementCandidate {
    const value = this.#candidate(id, revision);
    if (value.kind !== "workflow-restore" || value.registry || value.status !== "proposed") fail("Suggestion is no longer available.", 409);
    value.status = "applied";
    return this.#saveCandidate(value);
  }
  getActiveCandidate(projectId: string, kind: string, targetId: string): ImprovementCandidate | null { const row = this.#db.prepare("SELECT candidate_id FROM learning_active WHERE project_id=? AND kind=? AND target_id=?").all(projectId, kind, targetId)[0] as {candidate_id:string} | undefined; return row ? this.getCandidate(row.candidate_id) : null; }
  activateCandidate(id: string, revision: number, expectedActiveId: string | null = null): ImprovementCandidate {
    return this.#db.transaction(() => { const value = this.#candidate(id, revision); if (value.status !== "validated" || !value.evaluations.at(-1)?.passed) fail("Candidate needs a passing evaluation.", 409); const active = this.getActiveCandidate(value.projectId, value.kind, value.targetId); if ((active?.id ?? null) !== expectedActiveId) fail("Active version changed.", 409); if (active) { active.status = "retired"; this.#saveCandidate(active); value.previousActiveId = active.id; } value.status = "active"; this.#db.prepare("INSERT INTO learning_active(project_id,kind,target_id,candidate_id) VALUES(?,?,?,?) ON CONFLICT(project_id,kind,target_id) DO UPDATE SET candidate_id=excluded.candidate_id").run(value.projectId, value.kind, value.targetId, value.id); return this.#saveCandidate(value); })();
  }
  rollbackCandidate(id: string, revision: number): ImprovementCandidate {
    return this.#db.transaction(() => { const value = this.#candidate(id, revision); if (value.status !== "active" || this.getActiveCandidate(value.projectId, value.kind, value.targetId)?.id !== id) fail("Candidate is not active.", 409); value.status = "retired"; const previous = value.previousActiveId ? this.getCandidate(value.previousActiveId) : null; if (previous) { previous.status = "active"; this.#saveCandidate(previous); this.#db.prepare("UPDATE learning_active SET candidate_id=? WHERE project_id=? AND kind=? AND target_id=?").run(previous.id, value.projectId, value.kind, value.targetId); } else this.#db.prepare("DELETE FROM learning_active WHERE project_id=? AND kind=? AND target_id=?").run(value.projectId, value.kind, value.targetId); return this.#saveCandidate(value); })();
  }
  enqueue(eventId: string, kind = "derive-knowledge"): LearningWork { return enqueueLearningWork(this.#db, eventId, kind); }
  claimWork(owner: string, leaseMs = 60_000, now = Date.now(), projectId?: string): LearningWork | null {
    bounded(owner, "worker owner"); if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 3_600_000) fail("Invalid lease.");
    return this.#db.transaction(() => { const row = this.#db.prepare("SELECT id FROM learning_work WHERE ((status='pending' AND available_at<=?) OR (status='claimed' AND lease_until<=?)) AND (? IS NULL OR event_id IN (SELECT id FROM learning_events WHERE project_id=?)) ORDER BY available_at,id LIMIT 1").all(now, now, projectId ?? null, projectId ?? null)[0] as {id:string} | undefined; if (!row) return null; this.#db.prepare("UPDATE learning_work SET status='claimed',owner=?,claim_token=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(owner, randomUUID(), now + leaseMs, row.id); return workRow(this.#db.prepare("SELECT * FROM learning_work WHERE id=?").all(row.id)[0] as Record<string, unknown>); })();
  }
  queueStatus(projectId?: string): {pending: number; claimed: number; completed: number} { const counts = {pending: 0, claimed: 0, completed: 0}; for (const row of this.#db.prepare("SELECT status,COUNT(*) AS count FROM learning_work WHERE (? IS NULL OR event_id IN (SELECT id FROM learning_events WHERE project_id=?)) GROUP BY status").all(projectId ?? null, projectId ?? null)) { const value = row as {status: keyof typeof counts; count: number}; counts[value.status] = Number(value.count); } return counts; }
  /** Mirror a trusted external registry's existing lifecycle; this is not a promotion API. */
  mirrorRegistryCandidate(input: ImprovementInput & {registry: LearningRegistryProvenance}, status: ImprovementStatus, evaluations: LearningEvaluationInput[] = []): ImprovementCandidate {
    if (!["proposed", "canary", "active", "retired", "rejected", "validated", "evaluating"].includes(status)) fail("Invalid registry mirror status.");
    const matching: Record<string, ImprovementStatus> = {candidate: status === "rejected" ? "rejected" : "proposed", canary: "canary", active: "active", retired: "retired"};
    if (matching[input.registry.registryStatus] !== status) fail("Mirror status must match the registry.");
    if (evaluations.length > 64) fail("Too many evaluation receipts.");
    for (const receipt of evaluations) { if (receipt.evaluationKind !== "output-fixture") fail("External registry receipts are output fixtures."); for (const field of ["suiteDigest", "baselineDigest", "candidateDigest"] as const) bounded(receipt[field], field); if (receipt.candidateDigest !== input.registry.snapshotDigest) fail("Registry receipt snapshot does not match."); if (typeof receipt.passed !== "boolean" || !receipt.metrics || typeof receipt.metrics !== "object" || Array.isArray(receipt.metrics) || Object.keys(receipt.metrics).length > 32 || Object.entries(receipt.metrics).some(([k,v]) => k.length > 128 || typeof v !== "number" || !Number.isFinite(v))) fail("Invalid mirror receipt."); }
    return this.#db.transaction(() => { const rows = this.#db.prepare("SELECT body FROM learning_candidates WHERE project_id=?").all(input.projectId); const existing = rows.map(row => JSON.parse((row as {body:string}).body) as ImprovementCandidate).find(candidate => candidate.registry?.registryStorePath === input.registry.registryStorePath && candidate.registry.registryVersionId === input.registry.registryVersionId);
      if (existing && (existing.proposal !== input.proposal || existing.registry?.snapshotDigest !== input.registry.snapshotDigest)) fail("Immutable registry artifact changed.", 409);
      const value = existing ?? this.createCandidate(input); value.status = status; value.registry = input.registry;
      for (const receipt of evaluations) if (!value.evaluations.some(v => v.suiteDigest === receipt.suiteDigest && v.candidateDigest === receipt.candidateDigest && v.baselineDigest === receipt.baselineDigest && v.passed === receipt.passed)) value.evaluations.push({...receipt, id: randomUUID(), createdAt: new Date().toISOString()});
      return this.#saveCandidate(value);
    })();
  }
  #finishWork(id: string, token: string, status: "completed" | "pending", delayMs: number, now: number): void { if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 86_400_000 || !Number.isSafeInteger(now)) fail("Invalid retry delay."); const result = this.#db.prepare("UPDATE learning_work SET status=?,available_at=?,owner=NULL,claim_token=NULL,lease_until=NULL WHERE id=? AND status='claimed' AND claim_token=? AND lease_until>?").run(status, now + delayMs, id, token, now); if (!result.changes) fail("Work lease expired or belongs to another worker.", 409); }
  completeWork(id: string, token: string, now = Date.now()): void { this.#finishWork(id, token, "completed", 0, now); }
  retryWork(id: string, token: string, delayMs = 1000, now = Date.now()): void { this.#finishWork(id, token, "pending", delayMs, now); }
}
