/**
 * Docs-grounded severity triage for `0 campaign`.
 *
 * After every campaign chat iteration, NEW findings (severity high|medium,
 * triageStatus "new") are checked against the target's own published
 * documentation. When the documentation describes the observed behavior as
 * intended design, the finding is downgraded (severity lowered only) and
 * marked accepted with a note citing the doc page — the same acceptance the
 * operator would perform by hand via `0 findings accept`. When the docs
 * contradict the finding (docs claim a protection the finding shows absent)
 * the verdict keeps the severity; the harness never raises and never deletes.
 *
 * The one-call-per-batch LLM round trip mirrors campaign-objective.ts:
 * strict-JSON instructions, defensive parsing (code-fenced JSON accepted,
 * garbage returns an empty verdict list), and API keys are never logged.
 */

import { osecDB } from "@0/db";
import { severityRank } from "@0/shared";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** Each fetched docs page is capped at this many characters (spec: 64 KiB). */
export const DOCS_FETCH_CHAR_CAP = 64 * 1024;
/** Per-page cap when embedding docs into a triage prompt (spec: first 20k chars). */
export const DOCS_PAGE_PROMPT_CAP = 20_000;
/** Total cap across all embedded pages (spec: 40k chars for two URLs). */
export const DOCS_CONTEXT_TOTAL_CAP = 40_000;
/** Per-finding description excerpt cap inside the prompt. */
const DESCRIPTION_EXCERPT_CAP = 1_200;
/** Upper bound on findings rows pulled per triage pass (the cursor catches up over iterations). */
const TRIAGE_ROW_CAP = 50;

export type TriageSeverity = "high" | "medium" | "low" | "info";

const TRIAGE_SEVERITIES: readonly TriageSeverity[] = ["high", "medium", "low", "info"];

/** A finding shaped for the triage prompt. */
export interface TriageFinding {
  title: string;
  description: string;
  severity: string;
  category: string;
}

/** One model verdict, anchored to a zero-based input position. */
export interface TriageVerdict {
  index: number;
  documented_design: boolean;
  doc_page: string | null;
  reasoning: string;
  /** null when the model named no valid severity — no severity change then. */
  recommended_severity: TriageSeverity | null;
}

/** A findings-table row as seen by the docs-triage cursor. */
export interface TriageFindingRow extends TriageFinding {
  rowid: number;
  id: string;
  fingerprint: string | null;
  triageStatus: string | null;
  /** Prior operator note, if any — new notes are appended to it. */
  triageNote?: string | null;
}

/** Minimal findings-db surface the triage orchestration needs. */
export interface TriageDb {
  /** Findings created after `rowid`, ascending by rowid. */
  listFindingsSince(rowid: number): TriageFindingRow[];
  /**
   * Docs-grounded acceptance: lower `severity` across the finding's
   * fingerprint family and mark it accepted with a triage note, using the
   * same osecDB write path `0 findings accept` uses.
   */
  applyDocsDowngrade(finding: TriageFindingRow, severity: string, note: string): void;
}

export interface DocsTriageRun {
  /** Findings actually sent to the model this pass. */
  checked: number;
  /** Findings whose severity was lowered. */
  downgraded: number;
  /** Checked findings left untouched (verdict said the severity stands). */
  unchanged: number;
  /** New cursor: highest findings.rowid processed by this pass. */
  lastTriagedRowid: number;
}

// ── Prompt construction ─────────────────────────────────────────────────────

function findingSection(finding: TriageFinding, index: number): string {
  const description = finding.description.trim();
  const excerpt = description.length > DESCRIPTION_EXCERPT_CAP
    ? `${description.slice(0, DESCRIPTION_EXCERPT_CAP)}…`
    : description;
  return [
    `#${index + 1} [${finding.severity}] ${finding.title}`,
    `category: ${finding.category}`,
    excerpt || "(no description)",
  ].join("\n");
}

function docsSection(docsContext: string): string {
  const trimmed = docsContext.trim();
  return [
    "The target's own published documentation:",
    trimmed ? trimmed.slice(0, DOCS_CONTEXT_TOTAL_CAP) : "(none provided)",
  ].join("\n");
}

const VERDICT_SHAPE = '"documented_design": boolean, "doc_page": string|null, "reasoning": string, "recommended_severity": "high"|"medium"|"low"|"info"';

/**
 * Build the triage prompt for ONE finding: title, severity, a description
 * excerpt, the target docs context, and a strict-JSON verdict instruction.
 */
export function buildTriagePrompt(finding: TriageFinding, docsContext: string): string {
  return [
    "You are the docs-grounded severity reviewer of an authorized security research campaign.",
    "Decide whether the finding below describes behavior that the target's own published documentation explicitly presents as intended design.",
    "If it does, the finding deserves a downgrade. If the documentation instead claims a protection the finding shows absent, the severity stands (the harness never raises it automatically).",
    "",
    "Finding under review:",
    findingSection(finding, 0),
    "",
    docsSection(docsContext),
    "",
    `Reply with STRICT JSON only (no prose, no markdown): {${VERDICT_SHAPE}}.`,
    '"documented_design" is true ONLY when the documentation explicitly describes the observed behavior as intended.',
    '"doc_page" names the doc page or section that justifies the verdict (null when none).',
    '"recommended_severity" must be the severity the finding deserves if it stands — it is applied only when it lowers the current severity.',
  ].join("\n");
}

/** Batch variant of buildTriagePrompt: one prompt, one JSON-array answer. */
export function buildBatchTriagePrompt(findings: readonly TriageFinding[], docsContext: string): string {
  return [
    "You are the docs-grounded severity reviewer of an authorized security research campaign.",
    "For EACH finding below, decide whether the target's own published documentation explicitly presents the observed behavior as intended design.",
    "Documented-as-intended behavior deserves a downgrade. Documentation that claims a protection the finding shows absent means the severity stands (the harness never raises it automatically).",
    "",
    docsSection(docsContext),
    "",
    `Findings under review (${findings.length}):`,
    ...findings.map((finding, index) => findingSection(finding, index)),
    "",
    `Reply with STRICT JSON only (no prose, no markdown): a JSON array with one object per finding, in the same order, shaped as {${VERDICT_SHAPE}}, plus the zero-based "index" of the finding each verdict refers to.`,
    '"documented_design" is true ONLY when the documentation explicitly describes the observed behavior as intended.',
    '"doc_page" names the doc page or section that justifies the verdict (null when none).',
    '"recommended_severity" must be the severity the finding deserves if it stands — it is applied only when it lowers the current severity.',
  ].join("\n");
}

// ── Defensive parsing (campaign-objective.ts style) ─────────────────────────

/**
 * Parse a model response into triage verdicts. Code-fenced JSON is accepted;
 * garbage, non-array payloads, and structurally broken entries are not.
 * Returns null when the payload cannot be trusted at all.
 */
export function parseTriageVerdicts(raw: string): TriageVerdict[] | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
  if (fence) text = (fence[1] ?? "").trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  let entries: unknown;
  if (Array.isArray(parsed)) entries = parsed;
  else if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).verdicts)) {
    entries = (parsed as Record<string, unknown>).verdicts;
  } else return null;
  const verdicts: TriageVerdict[] = [];
  for (const [position, entry] of (entries as unknown[]).entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const index = typeof item.index === "number" && Number.isInteger(item.index) && item.index >= 0 ? item.index : position;
    const recommended = TRIAGE_SEVERITIES.find((severity) => severity === item.recommended_severity) ?? null;
    verdicts.push({
      index,
      documented_design: item.documented_design === true,
      doc_page: typeof item.doc_page === "string" && item.doc_page.trim() ? item.doc_page : null,
      reasoning: typeof item.reasoning === "string" ? item.reasoning : "",
      recommended_severity: recommended,
    });
  }
  return verdicts;
}

/**
 * Downgrade-only severity clamp: `recommended` wins only when it ranks
 * strictly below `current`; anything else (equal, higher, unknown) keeps the
 * current severity. Uses @0/shared's SEVERITY_RANK as the single source of
 * truth, so `critical` is ranked correctly too.
 */
export function clampSeverity(current: string, recommended: TriageSeverity | null): string {
  if (recommended === null) return current;
  return severityRank(recommended) < severityRank(current) ? recommended : current;
}

/** Assemble the prompt-level docs context: first 20k chars per page, 40k total. */
export function buildDocsContext(pages: readonly string[]): string {
  return pages
    .map((page) => page.slice(0, DOCS_PAGE_PROMPT_CAP))
    .join("\n\n")
    .slice(0, DOCS_CONTEXT_TOTAL_CAP);
}

/**
 * Batch triage: ONE LLM call for all new findings, defensive parse, verdicts
 * returned in input order (duplicates and out-of-range indexes dropped).
 * Any LLM failure returns [] so the findings stay untouched.
 */
export async function triageFindings(
  findings: readonly TriageFinding[],
  docsPages: readonly string[],
  llm: (prompt: string) => Promise<string>,
): Promise<TriageVerdict[]> {
  if (findings.length === 0) return [];
  let raw: string;
  try {
    raw = await llm(buildBatchTriagePrompt(findings, buildDocsContext(docsPages)));
  } catch {
    return [];
  }
  const parsed = parseTriageVerdicts(raw);
  if (parsed === null) return [];
  const seen = new Set<number>();
  const verdicts: TriageVerdict[] = [];
  for (const verdict of parsed) {
    if (verdict.index >= findings.length || seen.has(verdict.index)) continue;
    seen.add(verdict.index);
    verdicts.push(verdict);
  }
  return verdicts.sort((a, b) => a.index - b.index);
}

// ── Real collaborators (used by campaign.ts wiring) ──────────────────────────

/**
 * Fetch one operator-provided docs URL as plain text, capped at
 * DOCS_FETCH_CHAR_CAP. Returns null on any failure — the caller logs it and
 * continues without that page. This is documentation, not the target, so the
 * fetch is not subject to the scope file; the campaign logs it instead.
 */
export async function fetchDocsPage(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    const text = await response.text();
    return text.slice(0, DOCS_FETCH_CHAR_CAP);
  } catch {
    return null;
  }
}

export interface TriageLlmConfig {
  model: string;
  apiKey: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

/** One chat-completions call that resolves to the raw model text; throws on failure. */
export async function callTriageLlm(prompt: string, config: TriageLlmConfig): Promise<string> {
  const response = await (config.fetchImpl ?? fetch)(config.endpoint ?? OPENROUTER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model.replace(/^openrouter\//, ""),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) throw new Error(`triage endpoint returned HTTP ${response.status}`);
  const payload = (await response.json()) as Record<string, unknown>;
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const message = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>).message : undefined;
  const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
  if (typeof content !== "string" || !content.trim()) throw new Error("triage endpoint returned no message content");
  return content;
}

/**
 * The production TriageDb adapter over @0/db's osecDB — the same handle the
 * findings CLI uses. Reads use a plain SELECT (osecDB exposes no rowid API);
 * triage writes go through updateFindingTriageByFingerprint, the exact path
 * `0 findings accept` takes, so workflowStatus/triagedAt bookkeeping stays
 * identical to a manual acceptance.
 */
export class OsecTriageDb implements TriageDb {
  constructor(private readonly dbPath: string) {}

  listFindingsSince(rowid: number): TriageFindingRow[] {
    let db: osecDB;
    try {
      db = new osecDB(this.dbPath);
    } catch {
      return [];
    }
    try {
      const rows = triageDbHandle(db)
        .prepare(
          `SELECT rowid AS rowid, id, fingerprint, title, description, severity, category, triageStatus, triageNote
           FROM findings WHERE rowid > ? ORDER BY rowid LIMIT ${TRIAGE_ROW_CAP}`,
        )
        .all(rowid);
      return rows
        .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
        .map((row) => ({
          rowid: typeof row.rowid === "number" ? row.rowid : 0,
          id: String(row.id ?? ""),
          fingerprint: typeof row.fingerprint === "string" && row.fingerprint ? row.fingerprint : null,
          title: String(row.title ?? ""),
          description: String(row.description ?? ""),
          severity: String(row.severity ?? ""),
          category: String(row.category ?? ""),
          triageStatus: typeof row.triageStatus === "string" ? row.triageStatus : null,
          triageNote: typeof row.triageNote === "string" ? row.triageNote : null,
        }))
        .filter((row) => row.id && row.title);
    } catch {
      // Locked or unreadable database behaves like "no new findings": the
      // cursor does not advance and the next iteration retries.
      return [];
    } finally {
      db.close();
    }
  }

  applyDocsDowngrade(finding: TriageFindingRow, severity: string, note: string): void {
    const db = new osecDB(this.dbPath);
    try {
      const sqlite = triageDbHandle(db);
      if (finding.fingerprint) {
        // Severity has no dedicated osecDB API; the downgrade is a targeted
        // family-wide UPDATE so every family row stays consistent with the
        // triage write below (which is family-wide by fingerprint).
        sqlite.prepare("UPDATE findings SET severity = ? WHERE fingerprint = ?").run(severity, finding.fingerprint);
        // Same write path `0 findings accept` uses.
        db.updateFindingTriageByFingerprint(finding.fingerprint, "accepted", note);
      } else {
        // fingerprint is backfilled to id on migration, but stay safe for
        // rows that predate the backfill: keep the write single-row and raw.
        sqlite
          .prepare(
            "UPDATE findings SET severity = ?, triageStatus = 'accepted', triageNote = ?, triagedAt = ? WHERE id = ?",
          )
          .run(severity, note, new Date().toISOString(), finding.id);
      }
    } finally {
      db.close();
    }
  }
}

/** osecDB keeps its SQLite handle private; these two operations are the only consumers. */
function triageDbHandle(db: osecDB): { prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown } } {
  return (db as unknown as { sqlite: { prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown } } }).sqlite;
}

// ── Orchestration ───────────────────────────────────────────────────────────

export const TRIAGE_NOTE_PREFIX = "docs-grounded triage";

/** Triage note in the spec's format, appended to any prior operator note. */
export function triageNote(reasoning: string, docPage: string | null, priorNote?: string | null): string {
  const note = `${TRIAGE_NOTE_PREFIX}: ${reasoning || "no reasoning provided"} (doc: ${docPage ?? "none"})`;
  return priorNote ? `${priorNote} | ${note}` : note;
}

/** Only fresh, unsupervised high/medium findings go to the model. */
function isTriageEligible(row: TriageFindingRow): boolean {
  const severity = row.severity.trim().toLowerCase();
  return (severity === "high" || severity === "medium") && (row.triageStatus ?? "new") === "new";
}

/**
 * One docs-triage pass: collect findings since the cursor, batch-triage the
 * eligible ones, apply downgrade-only verdicts through the db adapter.
 *
 * Cursor rules: the cursor advances to the highest rowid read whenever the
 * pass completed (even with zero eligible findings — the eligibility filter
 * resolved them). When the LLM fails, nothing is processed, nothing is
 * written, and the cursor stays so the same findings are retried after the
 * next chat iteration.
 */
export async function runDocsTriage(options: {
  db: TriageDb;
  docsPages: readonly string[];
  llm: (prompt: string) => Promise<string>;
  lastTriagedRowid?: number;
}): Promise<DocsTriageRun> {
  const cursor = options.lastTriagedRowid ?? 0;
  const rows = options.db.listFindingsSince(cursor);
  if (rows.length === 0) return { checked: 0, downgraded: 0, unchanged: 0, lastTriagedRowid: cursor };
  const highestRowid = rows.reduce((max, row) => Math.max(max, row.rowid), cursor);
  const eligible = rows.filter(isTriageEligible);
  if (eligible.length === 0) {
    return { checked: 0, downgraded: 0, unchanged: 0, lastTriagedRowid: highestRowid };
  }
  const verdicts = await triageFindings(eligible, options.docsPages, options.llm);
  if (verdicts.length === 0) {
    // LLM failure or unparseable answer: skip silently, retry next iteration.
    return { checked: 0, downgraded: 0, unchanged: 0, lastTriagedRowid: cursor };
  }
  let downgraded = 0;
  for (const verdict of verdicts) {
    const row = eligible[verdict.index];
    if (!row || !verdict.documented_design) continue;
    const severity = clampSeverity(row.severity, verdict.recommended_severity);
    options.db.applyDocsDowngrade(row, severity, triageNote(verdict.reasoning, verdict.doc_page, row.triageNote));
    if (severity !== row.severity) downgraded += 1;
  }
  return {
    checked: eligible.length,
    downgraded,
    unchanged: eligible.length - downgraded,
    lastTriagedRowid: highestRowid,
  };
}
