// Per-family finding routes (detail, triage, workflow) over the merged findings view.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { osecDB } from "@0/engine/storage";
import { buildFindingConsoleCommand } from "../finding-handoff.js";
import { audit, auditActor, type AuditCaller } from "./audit.js";
import { json, readJsonObject, requireControlToken } from "./dashboard-http.js";
import { findingsServiceFor } from "./findings-service.js";
import {
  type DBEventRow, type DBFindingRow, type DBScanRow, type DBSessionRow, type DBVerdictRow,
  buildArtifacts, buildCases, buildWorkItems, buildWorkflowSummary, normalizeFinding, normalizeTriageStatus, normalizeWorkflowStatus,
} from "./dashboard-summaries.js";
import { workflowTransitionRejection } from "./dashboard-api.js";

type Persisted = { id: string; kind: string; title?: string; label?: string; owner?: string | null; status?: string; summary?: string | null; content?: string | null };

function collect(db: osecDB, fingerprint: string) {
  const rows = (db.getRelatedFindings(fingerprint) as DBFindingRow[]).map(normalizeFinding);
  const scans = [...new Map(rows.map(row => db.getScan(row.scanId) as DBScanRow | undefined).filter(Boolean).map(scan => [scan!.id, scan!] as const)).values()];
  return {
    rows, scans,
    verdicts: db.listVerdicts(rows.map(row => row.id)) as DBVerdictRow[],
    sessions: db.listSessions({ scanIds: [...new Set(rows.map(row => row.scanId))], status: "running" }) as DBSessionRow[],
    events: scans.flatMap(scan => db.getEvents(scan.id) as DBEventRow[]),
    workItems: (db.listWorkItems?.({ findingFingerprint: fingerprint, limit: 50 }) ?? []) as Persisted[],
    artifacts: (db.listArtifacts?.({ findingFingerprint: fingerprint, limit: 100 }) ?? []) as Persisted[],
  };
}

export async function handleFindingFamilyRequest(
  req: IncomingMessage, res: ServerResponse, fingerprint: string, action: "triage" | "workflow" | undefined,
  dbPath: string | undefined, controlToken: string, engineBearer?: string, caller: AuditCaller = { engineRequest: false },
): Promise<void> {
  const findings = findingsServiceFor(dbPath);
  if (req.method === "POST" && action === "triage") {
    if (!requireControlToken(req, res, controlToken, engineBearer)) return;
    const body = await readJsonObject<{ triageStatus?: string; triageNote?: string }>(req);
    const status = normalizeTriageStatus(body.triageStatus);
    // The decision applies to the whole family, in every database that holds one of its findings.
    await findings.writeFamily(fingerprint, db => db.updateFindingTriageByFingerprint(fingerprint, status, typeof body.triageNote === "string" ? body.triageNote : undefined));
    audit({ actor: auditActor(caller), action: "finding.triage", subject: fingerprint, detail: { fingerprint, decision: status, ...(caller.userId ? { id: caller.userId } : {}) } });
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && action === "workflow") {
    if (!requireControlToken(req, res, controlToken, engineBearer)) return;
    const body = await readJsonObject<{ workflowStatus?: string; workflowAssignee?: string }>(req);
    const heads = (await findings.readFamily(fingerprint, db => db.getLatestFindingByFingerprint(fingerprint))).filter(Boolean);
    const current = heads.sort((a, b) => (b!.timestamp ?? 0) - (a!.timestamp ?? 0))[0];
    if (!current) { json(res, 404, { error: "Not found" }); return; }
    const rejection = workflowTransitionRejection(body.workflowStatus, current.workflowStatus);
    if (rejection) { json(res, rejection.status, { error: rejection.error }); return; }
    const assignee = typeof body.workflowAssignee === "string" ? body.workflowAssignee.trim() : null;
    await findings.writeFamily(fingerprint, db => db.updateFindingWorkflowByFingerprint(fingerprint, normalizeWorkflowStatus(body.workflowStatus), assignee));
    json(res, 200, { ok: true });
    return;
  }

  const parts = await findings.readFamily(fingerprint, db => collect(db, fingerprint));
  const rows = parts.flatMap(part => part.rows).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0) || String(b.id).localeCompare(String(a.id)));
  if (rows.length === 0) { json(res, 404, { error: "Not found" }); return; }
  const verdicts = parts.flatMap(part => part.verdicts);
  const sessions = parts.flatMap(part => part.sessions);
  const scans = [...new Map(parts.flatMap(part => part.scans).map(scan => [scan.id, scan] as const)).values()];
  const workflow = buildWorkflowSummary(rows, verdicts, sessions);
  const scanIds = [...new Set(rows.map(row => row.scanId))];
  const familyCase = buildCases(scans, [{ fingerprint, latest: rows[0], count: rows.length, scanCount: scanIds.length, sourceScanIds: scanIds.sort(), workflow }])[0] ?? null;
  const workItems = parts.flatMap(part => part.workItems);
  const artifacts = parts.flatMap(part => part.artifacts);
  const merged = (await findings.list()).families.find(family => family.key === fingerprint);
  json(res, 200, {
    consoleCommand: buildFindingConsoleCommand(rows[0]!, dbPath),
    fingerprint, case: familyCase, latest: rows[0], rows, workflow,
    provenance: merged?.provenance ?? null,
    workItems: workItems.length > 0
      ? workItems.map(item => ({ id: item.id, kind: item.kind, title: item.title, owner: item.owner ?? null, status: item.status, summary: item.summary ?? "" }))
      : buildWorkItems({ fingerprint, workflow, rows, verdicts }),
    artifacts: artifacts.length > 0
      ? artifacts.map(artifact => ({ id: artifact.id, kind: artifact.kind, label: artifact.label, summary: artifact.content ? `${artifact.content.length} chars captured` : "Persisted artifact" }))
      : buildArtifacts({ fingerprint, latest: rows[0], verdicts, sessions, events: parts.flatMap(part => part.events) }),
  });
}
