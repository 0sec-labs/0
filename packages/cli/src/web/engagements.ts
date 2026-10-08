import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { osecDB } from "@0/db";
import { homeStateDir, type Finding, type ScanReport } from "@0/shared";
import { retainedScanSnapshot } from "./report-artifacts.js";

export class EngagementError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); this.name = "EngagementError"; }
}
const scanIdsSchema = z.array(z.string().trim().min(1).max(160)).max(100).refine(ids => new Set(ids).size === ids.length, "Scan IDs must be unique.");
const fieldsSchema = z.object({ name: z.string().trim().min(1).max(160), description: z.string().trim().max(8000).default(""), scanIds: scanIdsSchema.default([]), notes: z.string().trim().max(16000).optional() }).strict();
const recordSchema = fieldsSchema.extend({ id: z.string().uuid(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
const updateSchema = fieldsSchema.partial().strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), workspace: z.string(), engagements: z.array(recordSchema).max(200) }).strict();
export type EngagementRecord = z.infer<typeof recordSchema>;
export type EngagementInput = z.input<typeof fieldsSchema>;
export type EngagementPatch = z.input<typeof updateSchema>;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new EngagementError(result.error.issues.map(issue => issue.message).join(" "));
  return result.data;
}

/** Operator-local collections, isolated by canonical workspace. Not a tenancy boundary. */
export class EngagementStore {
  readonly workspace: string;
  readonly #path: string;
  readonly #directory: string;
  readonly #dbPath?: string;
  constructor(options: { workspace: string; stateDir?: string; dbPath?: string }) {
    this.workspace = realpathSync(options.workspace);
    this.#directory = join(options.stateDir ?? homeStateDir(), "engagements");
    this.#path = join(this.#directory, `${createHash("sha256").update(this.workspace).digest("hex")}.json`);
    this.#dbPath = options.dbPath;
  }
  #read(): EngagementRecord[] {
    let fd: number;
    try { fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []; throw new EngagementError("Engagement storage could not be read.", 500); }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new EngagementError("Invalid engagement storage.", 500);
      const source = readFileSync(fd);
      if (source.byteLength > MAX_STATE_BYTES) throw new EngagementError("Engagement storage exceeds its size limit.", 500);
      const state = stateSchema.safeParse(JSON.parse(source.toString("utf8")));
      if (!state.success || state.data.workspace !== this.workspace || new Set(state.data.engagements.map(row => row.id)).size !== state.data.engagements.length) throw new EngagementError("Invalid engagement storage.", 500);
      return state.data.engagements;
    } catch (cause) { if (cause instanceof EngagementError) throw cause; throw new EngagementError("Invalid engagement storage.", 500); }
    finally { closeSync(fd); }
  }
  #write(engagements: EngagementRecord[]): void {
    const body = JSON.stringify({ schemaVersion: 1, workspace: this.workspace, engagements });
    if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new EngagementError("Engagement storage limit reached.", 409);
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, body, { flag: "wx", mode: 0o600 }); renameSync(temporary, this.#path); }
    finally { try { unlinkSync(temporary); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; } }
  }
  #validateScans(ids: string[]): void {
    if (!ids.length) return;
    const db = new osecDB(this.#dbPath);
    try { for (const id of ids) if (!db.getScan(id)) throw new EngagementError(`Selected scan was not found: ${id}`, 404); }
    finally { db.close(); }
  }
  list(): EngagementRecord[] { return this.#read().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id: string): EngagementRecord {
    const row = this.#read().find(item => item.id === id);
    if (!row) throw new EngagementError("Engagement not found in this workspace.", 404);
    return row;
  }
  create(input: unknown): EngagementRecord {
    const fields = parse(fieldsSchema, input);
    this.#validateScans(fields.scanIds);
    const rows = this.#read();
    if (rows.length >= 200) throw new EngagementError("Engagement limit reached.", 409);
    const now = new Date().toISOString();
    const row: EngagementRecord = { ...fields, id: randomUUID(), createdAt: now, updatedAt: now };
    this.#write([...rows, row]); return structuredClone(row);
  }
  update(id: string, input: unknown): EngagementRecord {
    const patch = parse(updateSchema, input);
    const rows = this.#read();
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) throw new EngagementError("Engagement not found in this workspace.", 404);
    if (patch.scanIds) this.#validateScans(patch.scanIds);
    const row = parse(recordSchema, { ...rows[index], ...patch, updatedAt: new Date().toISOString() });
    rows[index] = row; this.#write(rows); return structuredClone(row);
  }
  report(id: string): EngagementReport {
    const engagement = this.get(id);
    const db = new osecDB(this.#dbPath);
    try {
      const sources = engagement.scanIds.map(scanId => {
        const scan = db.getScan(scanId);
        if (!scan) throw new EngagementError(`Selected scan was not found: ${scanId}`, 404);
        return { scan: { id: scan.id, target: scan.target, status: scan.status, startedAt: scan.startedAt, completedAt: scan.completedAt, durationMs: scan.durationMs }, report: retainedScanSnapshot(scanId, this.#dbPath) };
      });
      return assembleEngagementReport(engagement, sources);
    } finally { db.close(); }
  }
}

type ReviewStatus = "verified" | "rejected" | "unreviewed";
export interface EngagementReportSource {
  scan: { id: string; target: string; status: string; startedAt: string; completedAt: string | null; durationMs: number | null };
  report: ScanReport;
}
export interface EngagementFindingGroup {
  key: string; fingerprint?: string; reviewStatus: ReviewStatus;
  occurrences: Array<{ scanId: string; findingId: string; finding: Finding }>;
}
export interface EngagementReport {
  schemaVersion: 1; engagement: EngagementRecord;
  coverage: { scanIds: string[]; kind: "selected-retained-scans" };
  scans: Array<EngagementReportSource["scan"] & { warnings: ScanReport["warnings"]; executionSuccessful?: boolean; exitReason?: ScanReport["exitReason"]; error?: string }>;
  findingGroups: EngagementFindingGroup[];
  summary: { scanCount: number; findingCount: number; uniqueFindingCount: number; verified: number; rejected: number; unreviewed: number };
}
function reviewStatus(finding: Finding): ReviewStatus {
  if (finding.status === "false-positive") return "rejected";
  if (finding.status === "verified" || finding.verification_result?.status === "reproduced") return "verified";
  return "unreviewed";
}
/** Exact selected evidence only. Conflicting family review states remain unreviewed. */
export function assembleEngagementReport(engagement: EngagementRecord, sources: EngagementReportSource[]): EngagementReport {
  const record = parse(recordSchema, engagement);
  const byScan = new Map(sources.map(source => [source.scan.id, source]));
  if (byScan.size !== sources.length || sources.length !== record.scanIds.length || record.scanIds.some(id => !byScan.has(id))) throw new EngagementError("Report sources must match exactly the selected scan IDs.", 404);
  const groups = new Map<string, EngagementFindingGroup>();
  let findingCount = 0;
  const scans = record.scanIds.map(id => {
    const source = byScan.get(id)!;
    for (const finding of source.report.findings) {
      findingCount++;
      const fingerprint = finding.fingerprint?.trim();
      const key = fingerprint ? `fingerprint:${fingerprint}` : `source:${id}:${finding.id}`;
      const status = reviewStatus(finding);
      let group = groups.get(key);
      if (!group) { group = { key, ...(fingerprint ? { fingerprint } : {}), reviewStatus: status, occurrences: [] }; groups.set(key, group); }
      else if (group.reviewStatus !== status) group.reviewStatus = "unreviewed";
      group.occurrences.push({ scanId: id, findingId: finding.id, finding: structuredClone(finding) });
    }
    return { ...source.scan, warnings: structuredClone(source.report.warnings), executionSuccessful: source.report.executionSuccessful, exitReason: source.report.exitReason, ...(source.report.error ? { error: source.report.error } : {}) };
  });
  const findingGroups = [...groups.values()];
  return { schemaVersion: 1, engagement: structuredClone(record), coverage: { scanIds: [...record.scanIds], kind: "selected-retained-scans" }, scans,
    findingGroups, summary: { scanCount: scans.length, findingCount, uniqueFindingCount: findingGroups.length,
      verified: findingGroups.filter(group => group.reviewStatus === "verified").length, rejected: findingGroups.filter(group => group.reviewStatus === "rejected").length, unreviewed: findingGroups.filter(group => group.reviewStatus === "unreviewed").length } };
}
