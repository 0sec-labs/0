import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { z } from "zod";
import { osecDB, resolveOsecDbPath, findingStatuses } from "@0/db";
import type { Finding } from "@0/shared";
import { findingFromRow } from "../finding-focus.js";
import { retainedFindingSnapshot } from "./report-artifacts.js";
import { FindingsAccessError } from "./findings-access-tokens.js";

const boundedId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/);
const severitySchema = z.enum(["critical", "high", "medium", "low", "info"]);
const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), scanId: boundedId.optional(),
  severity: severitySchema.optional(), status: z.enum(findingStatuses).optional(),
  includeSuppressed: z.enum(["true", "false"]).default("false"), cursor: z.string().min(1).max(2048).optional(),
}).strict();
const cursorSchema = z.object({ version: z.literal(1), workspaceId: z.string(), filters: z.string().length(64), timestamp: z.number().finite().nonnegative(), id: boundedId }).strict();
export interface FindingsApiItem { scanId: string; target: string; finding: Finding }

/** Reads only the selected engine database; never falls back to another run store. */
export class FindingsReadApi {
  readonly #dbPath: string;
  readonly workspaceId: string;
  constructor(options: { dbPath?: string; workspaceId: string }) { this.#dbPath = resolveOsecDbPath(options.dbPath); this.workspaceId = options.workspaceId; }
  #item(db: osecDB, id: string): FindingsApiItem {
    const row = db.getFinding(id);
    if (!row) throw new FindingsAccessError("Finding not found.", 404);
    const scan = db.getScan(row.scanId);
    if (!scan) throw new FindingsAccessError("Finding source scan was not retained.", 404);
    return { scanId: row.scanId, target: scan.target, finding: findingFromRow(row, { ...db.getFindingReviewFields(id) }) };
  }
  list(query: URLSearchParams) {
    const raw: Record<string, string> = {};
    for (const [key, value] of query) { if (Object.hasOwn(raw, key)) throw new FindingsAccessError("Repeated finding list parameters are not supported."); raw[key] = value; }
    const parsed = querySchema.safeParse(raw);
    if (!parsed.success) throw new FindingsAccessError("Use limit 1–100, cursor, scanId, severity, status or includeSuppressed.");
    const input = parsed.data;
    const filters = createHash("sha256").update(JSON.stringify({ database: this.#dbPath, scanId: input.scanId ?? null, severity: input.severity ?? null, status: input.status ?? null, includeSuppressed: input.includeSuppressed })).digest("hex");
    let before: { id: string; timestamp: number } | undefined;
    if (input.cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error("encoding");
        const decoded = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
        if (decoded.workspaceId !== this.workspaceId || decoded.filters !== filters) throw new Error("scope");
        before = { id: decoded.id, timestamp: decoded.timestamp };
      } catch { throw new FindingsAccessError("Cursor does not match this workspace and finding filters."); }
    }
    const db = new osecDB(this.#dbPath, { readOnly: true });
    try {
      const rows = db.listFindingsApiPage({ limit: input.limit + 1, scanId: input.scanId, severity: input.severity, status: input.status, includeSuppressed: input.includeSuppressed === "true", before });
      const hasMore = rows.length > input.limit;
      const selected = rows.slice(0, input.limit);
      const last = selected.at(-1);
      const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ version: 1, workspaceId: this.workspaceId, filters, timestamp: last.timestamp, id: last.id })).toString("base64url") : null;
      return { schemaVersion: 1 as const, workspaceId: this.workspaceId, findings: selected.map(row => this.#item(db, row.id)), page: { limit: input.limit, nextCursor, hasMore } };
    } finally { db.close(); }
  }
  detail(id: string) {
    if (!boundedId.safeParse(id).success) throw new FindingsAccessError("Invalid finding ID.");
    const db = new osecDB(this.#dbPath, { readOnly: true });
    try { return { schemaVersion: 1 as const, workspaceId: this.workspaceId, ...this.#item(db, id) }; }
    finally { db.close(); }
  }
  export(query: URLSearchParams) {
    if ([...query.keys()].some(key => key !== "id")) throw new FindingsAccessError("Use repeated id parameters to select export findings.");
    const ids = query.getAll("id");
    if (!ids.length || ids.length > 500 || ids.some(id => !boundedId.safeParse(id).success) || new Set(ids).size !== ids.length) throw new FindingsAccessError("Select 1–500 distinct exact finding IDs.");
    return { schemaVersion: 1 as const, workspaceId: this.workspaceId, coverage: "selected-retained-findings" as const, report: retainedFindingSnapshot(ids, this.#dbPath) };
  }
}

export function handleFindingsReadRequest(req: Pick<IncomingMessage, "method">, url: URL, api: FindingsReadApi): { status: number; data: unknown } | undefined {
  const match = /^\/api\/v1\/findings(?:\/([A-Za-z0-9_.:-]+))?$/.exec(url.pathname);
  if (!match) return;
  if (req.method !== "GET" && req.method !== "HEAD") throw new FindingsAccessError("Findings API is read-only.", 405);
  if (!match[1]) return { status: 200, data: api.list(url.searchParams) };
  if (match[1] === "export") return { status: 200, data: api.export(url.searchParams) };
  if (url.search) throw new FindingsAccessError("Finding detail does not accept query parameters.");
  return { status: 200, data: api.detail(match[1]) };
}
