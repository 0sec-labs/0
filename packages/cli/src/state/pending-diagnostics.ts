/**
 * Crash and error reports for the 0security engine, from either interface.
 *
 * One engine, one reporter: the terminal (`surface: "cli"`) and the browser
 * (`surface: "web"`) both hand a finite {@link DiagnosticInfo} to
 * {@link handleDiagnosticReport}, which applies the consent model from
 * `feedback.ts` and reaches the single 0security Sentry project through
 * `submitFeedback`. Nothing here widens that model:
 *
 *   - `off`, any opt-out env var, or no HTTPS destination: the report is dropped
 *     and NOTHING is written to disk.
 *   - `ask`: the finite report is stored locally as a pending report. It is only
 *     ever transmitted after the operator previews the literal bytes and
 *     confirms (web UI), never from this module.
 *   - `automatic`: one best-effort, short-timeout submit. Never throws.
 *
 * Pending files hold only the bounded fields {@link DiagnosticInfo} accepts.
 * They are re-validated through the builder on every read, so a tampered file
 * cannot smuggle free text onto the wire.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "@0/engine/shared";
import {
  buildDiagnosticFeedback, submissionBlockedReason, submitFeedback,
  type DiagnosticInfo, type DiagnosticMetadata, type FeedbackPayload,
} from "./feedback.js";

export const MAX_PENDING_REPORTS = 10;
export const MAX_PENDING_REPORT_BYTES = 8 * 1024;
const PENDING_ID = /^[0-9a-f]{32}$/;
const DEFAULT_AUTOMATIC_TIMEOUT_MS = 2000;

type Env = Record<string, string | undefined>;
export type DiagnosticPolicy = "off" | "ask" | "automatic";

export interface PendingReportSummary {
  id: string;
  createdAt: string;
  surface: "cli" | "web";
  category: string;
}

interface PendingRecord {
  version: 1;
  id: string;
  createdAt: string;
  info: Omit<DiagnosticInfo, "error" | "exitOutput" | "toolName">;
}

export function isPendingReportId(value: unknown): value is string {
  return typeof value === "string" && PENDING_ID.test(value);
}

export function pendingDirectory(homeDir?: string): string {
  return join(homeStateDir(homeDir), "diagnostics", "pending");
}

function recordFor(payload: FeedbackPayload, createdAt: string): PendingRecord | null {
  const d = payload.diagnostic;
  if (!d) return null;
  return {
    version: 1, id: d.eventId, createdAt,
    info: {
      kind: d.kind as DiagnosticInfo["kind"], surface: d.surface, ...(d.command ? { command: d.command } : {}),
      category: d.category, platform: d.platform, arch: d.arch, runtime: d.runtime, runtimeVersion: d.runtimeVersion,
      version: payload.version ?? "unknown", timestamp: payload.timestamp, frames: d.frames, eventId: d.eventId,
    },
  };
}

/** Rebuild the transmit-safe payload from a stored record, re-applying every builder bound. */
function payloadFor(record: PendingRecord): FeedbackPayload {
  return buildDiagnosticFeedback({ ...record.info, eventId: record.id });
}

function readRecord(path: string, id: string): PendingRecord | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_PENDING_REPORT_BYTES) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PendingRecord> | null;
    if (!raw || typeof raw !== "object" || raw.version !== 1 || raw.id !== id || typeof raw.info !== "object" || raw.info === null) return null;
    const createdAt = typeof raw.createdAt === "string" && Number.isFinite(Date.parse(raw.createdAt)) ? new Date(raw.createdAt).toISOString() : null;
    if (!createdAt) return null;
    return { version: 1, id, createdAt, info: raw.info };
  } catch {
    return null;
  }
}

function ids(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((name) => name.endsWith(".json") && isPendingReportId(name.slice(0, -5)) ? [name.slice(0, -5)] : []);
  } catch {
    return [];
  }
}

/** Persist a built report as pending. Bounded count and size; the oldest report is evicted. Never throws. */
export function savePendingReport(payload: FeedbackPayload, options: { homeDir?: string; now?: () => Date } = {}): boolean {
  try {
    const record = recordFor(payload, (options.now?.() ?? new Date()).toISOString());
    if (!record || !isPendingReportId(record.id)) return false;
    const body = JSON.stringify(record);
    if (Buffer.byteLength(body, "utf8") > MAX_PENDING_REPORT_BYTES) return false;
    const dir = pendingDirectory(options.homeDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* best effort on foreign filesystems */ }
    const existing = listPendingReports(options.homeDir);
    // Oldest first; keep room for the new report.
    for (const old of existing.slice(0, Math.max(0, existing.length - MAX_PENDING_REPORTS + 1))) deletePendingReport(old.id, options.homeDir);
    const target = join(dir, `${record.id}.json`);
    const temp = join(dir, `.${record.id}.tmp`);
    writeFileSync(temp, body, { mode: 0o600, flag: "w" });
    renameSync(temp, target);
    return true;
  } catch {
    return false;
  }
}

/** Newest-last list of pending reports. Unreadable or oversize files are ignored. */
export function listPendingReports(homeDir?: string): PendingReportSummary[] {
  const dir = pendingDirectory(homeDir);
  const out: PendingReportSummary[] = [];
  for (const id of ids(dir)) {
    const record = readRecord(join(dir, `${id}.json`), id);
    if (!record) continue;
    const payload = payloadFor(record);
    const d = payload.diagnostic as DiagnosticMetadata;
    out.push({ id, createdAt: record.createdAt, surface: d.surface, category: d.category });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** The re-validated payload for one pending report, or null for a malformed id / missing / unreadable file. */
export function readPendingReport(id: unknown, homeDir?: string): { summary: PendingReportSummary; payload: FeedbackPayload } | null {
  if (!isPendingReportId(id)) return null;
  const record = readRecord(join(pendingDirectory(homeDir), `${id}.json`), id);
  if (!record) return null;
  const payload = payloadFor(record);
  const d = payload.diagnostic as DiagnosticMetadata;
  return { summary: { id, createdAt: record.createdAt, surface: d.surface, category: d.category }, payload };
}

export function deletePendingReport(id: unknown, homeDir?: string): boolean {
  if (!isPendingReportId(id)) return false;
  try {
    const path = join(pendingDirectory(homeDir), `${id}.json`);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Delete every pending report; returns how many were removed. */
export function discardPendingReports(homeDir?: string): number {
  let removed = 0;
  for (const id of ids(pendingDirectory(homeDir))) if (deletePendingReport(id, homeDir)) removed += 1;
  return removed;
}

export type DiagnosticOutcome = "dropped" | "pending" | "submitted" | "failed";

export interface DiagnosticReportOptions {
  env?: Env;
  homeDir?: string;
  now?: () => Date;
  /** Live consent preference. Defaults to the persisted `diagnosticReporting` setting. */
  policy?: () => DiagnosticPolicy;
  submit?: typeof submitFeedback;
  timeoutMs?: number;
}

async function livePolicy(): Promise<DiagnosticPolicy> {
  try {
    const { getSettings } = await import("./settings-store.js");
    return getSettings().diagnosticReporting;
  } catch {
    return "off";
  }
}

/**
 * The single intake for crash/error reports from either interface. Applies the
 * consent model and never throws. The kill switch and opt-outs beat every mode.
 */
export async function handleDiagnosticReport(info: DiagnosticInfo, options: DiagnosticReportOptions = {}): Promise<DiagnosticOutcome> {
  try {
    const env = options.env ?? process.env;
    const policy = options.policy ? options.policy() : await livePolicy();
    if (policy !== "ask" && policy !== "automatic") return "dropped";
    const payload = buildDiagnosticFeedback(info);
    // Opt-out env vars, an invalid destination, or no destination at all: neither send nor store.
    if (submissionBlockedReason(env, { allowCloud: false }, payload) !== null) return "dropped";
    if (policy === "ask") return savePendingReport(payload, options) ? "pending" : "dropped";
    const result = await (options.submit ?? submitFeedback)(payload, env, {
      allowCloud: false, timeoutMs: options.timeoutMs ?? DEFAULT_AUTOMATIC_TIMEOUT_MS,
      diagnosticConsent: { policy: "automatic" },
    });
    return result.ok ? "submitted" : "failed";
  } catch {
    return "failed";
  }
}
