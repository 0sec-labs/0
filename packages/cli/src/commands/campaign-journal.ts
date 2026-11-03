/**
 * Journal + findings-delta helpers for `0 campaign`.
 *
 * The journal is the campaign's crash-safe source of truth: every state
 * change is persisted atomically (tmp file + rename) so a killed
 * supervisor can resume after the last completed iteration without
 * redoing work. Findings-delta reads are read-only (node:sqlite
 * DatabaseSync) and never write to the campaign database.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CampaignObjective, FindingSummary } from "./campaign-objective.js";

export type CampaignIterationKind = "scan" | "chat";

export interface CampaignIterationRecord {
  kind: CampaignIterationKind;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  /** One-line human summary surfaced in the campaign report. */
  summary: string;
  /** Session id of the engine-attached console session, when attached. */
  sessionId?: string | null;
  /** Objective that drove a chat iteration (omitted for recon-fallback-free scans). */
  objective?: CampaignObjective;
  timedOut?: boolean;
  /** Path of the captured iteration transcript, when written. */
  transcriptPath?: string;
}

export interface CampaignJournal {
  target: string;
  config: Record<string, unknown>;
  startedAt: string;
  iterations: CampaignIterationRecord[];
  findingsBaseline: number;
  totalCostEstimateUsd: number;
}

export interface CampaignPlannedIteration {
  index: number;
  kind: CampaignIterationKind;
}

export function initJournal(
  target: string,
  config: Record<string, unknown>,
  findingsBaseline: number,
  startedAt = new Date().toISOString(),
): CampaignJournal {
  return { target, config, startedAt, iterations: [], findingsBaseline, totalCostEstimateUsd: 0 };
}

/** Load an existing journal; null when absent or unreadable (fresh start). */
export function loadJournal(path: string): CampaignJournal | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.target !== "string" || !Array.isArray(parsed.iterations)) return null;
    return parsed as unknown as CampaignJournal;
  } catch {
    return null;
  }
}

/** Crash-safe write: tmp file in the same directory, then rename. */
export function saveJournal(path: string, journal: CampaignJournal): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(journal, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Planned iteration sequence: the default campaign is uniform — every
 * iteration is an engine-attached chat session. `--with-scan` opts into
 * one classic breadth scan as iteration 1 (spec §Change 4).
 */
export function planIterations(options: { iterations: number; withScan?: boolean }): CampaignPlannedIteration[] {
  const iterations = Math.max(1, options.iterations);
  if (options.withScan) {
    return Array.from({ length: iterations }, (_, slot) => ({
      index: slot + 1,
      kind: (slot === 0 ? "scan" : "chat") as CampaignIterationKind,
    }));
  }
  return Array.from({ length: iterations }, (_, slot) => ({ index: slot + 1, kind: "chat" as CampaignIterationKind }));
}

/** Parse the markdown summary block of a scan run (`--format md`). */
export function parseScanSummary(stdout: string): { attacks: number | null; findings: number | null; durationMs: number | null } {
  const attacks = stdout.match(/\*\*Attacks:\*\*\s*(\d+)/)?.[1];
  const findings = stdout.match(/\*\*Findings:\*\*\s*(\d+)/)?.[1];
  const duration = stdout.match(/\|\s*Duration\s*\|\s*([\d.]+)\s*s/)?.[1];
  return {
    attacks: attacks === undefined ? null : Number(attacks),
    findings: findings === undefined ? null : Number(findings),
    durationMs: duration === undefined ? null : Math.round(Number(duration) * 1000),
  };
}

/** Filesystem-safe identifier used for default db/journal filenames. */
export function sanitizeTarget(target: string): string {
  return target
    .replace(/^[a-zA-Z][\w+.-]*:\/\//, "")
    .replace(/[^a-zA-Z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "campaign-target";
}

/** Console-visible session title so the operator can follow the loop live. */
export function campaignSessionTitle(index: number, objective: string): string {
  const slug = objective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `Campaign iter ${index}${slug ? `: ${slug}` : ""}`;
}

/**
 * Count finding rows in the campaign database. Read-only; a missing or
 * locked database counts as zero findings (deltas resume from the next
 * successful read).
 */
export function countFindingsInDb(dbPath: string): number {
  const findings = queryFindings(dbPath, "SELECT COUNT(*) AS count FROM findings");
  if (findings === null) return 0;
  const first = findings[0] as Record<string, unknown> | undefined;
  const count = first?.count;
  return typeof count === "number" ? count : 0;
}

/** Recent finding titles+severities for the objective prompt. */
export function listFindingSummaries(dbPath: string, limit = 100): FindingSummary[] {
  const rows = queryFindings(
    dbPath,
    `SELECT title, severity FROM findings ORDER BY timestamp DESC LIMIT ${Math.max(1, Math.min(1000, limit))}`,
  );
  if (rows === null) return [];
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .map((row) => ({ title: String(row.title ?? ""), severity: String(row.severity ?? "") }))
    .filter((row) => row.title);
}

function queryFindings(dbPath: string, sql: string): Record<string, unknown>[] | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    return db.prepare(sql).all() as unknown as Record<string, unknown>[];
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Read the in_scope hosts of the scope policy for briefs and prompts. */
export function readScopeHosts(scopePath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(scopePath, "utf8")) as Record<string, unknown>;
    const inScope = parsed.in_scope;
    if (!Array.isArray(inScope)) return [];
    return inScope.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}
