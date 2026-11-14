import { ciReportProvenance } from '../ci-report-provenance.js';
// Database row shapes and pure summarizers that build the dashboard API payloads.
import { ImpactAssessmentSchema } from "@0/engine/shared";
import { createPresentationEvent, type FindingTriageStatus, type PresentationEvent, type PresentationSource } from "@0/engine/shared";
import { readToolCallNames } from "@0/engine";

export type DBFindingRow = {
  id: string;
  scanId: string;
  title: string;
  description: string;
  severity: string;
  category: string;
  status: string;
  fingerprint?: string | null;
  triageStatus?: string | null;
  triageNote?: string | null;
  workflowStatus?: string | null;
  workflowAssignee?: string | null;
  workflowUpdatedAt?: string | null;
  timestamp: number;
  score?: number | null;
  confidence?: number | null;
  cvssScore?: number | null;
  cvssVector?: string | null;
  evidenceRequest: string;
  evidenceResponse: string;
  evidenceAnalysis?: string | null;
  impactAssessment?: unknown;
};

export type DBScanRow = {
  id: string;
  target: string;
  depth: string;
  runtime: string;
  mode: string;
  status: string;
  startedAt: string;
  completedAt?: string | null;
  durationMs?: number | null;
  summary?: string | null;
};

export type DBEventRow = {
  id: string;
  scanId: string;
  stage: string;
  eventType: string;
  findingId?: string | null;
  agentRole?: string | null;
  source?: string;
  payload: string;
  timestamp: number;
};

export type DashboardRecentEventRow = DBEventRow & {
  scanTarget: string;
  findingFingerprint?: string | null;
};

export type DBVerdictRow = {
  id: string;
  findingId: string;
  agentRole: string;
  model: string;
  verdict: string;
  confidence: number;
  reasoning: string;
  timestamp: number;
};

export type DBSessionRow = {
  id: string;
  scanId: string;
  agentRole: string;
  turnCount: number;
  messages: string;
  toolContext: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type DBWorkerRow = {
  id: string;
  role: string;
  status: string;
  label: string;
  currentCaseId?: string | null;
  currentWorkItemId?: string | null;
  currentScanId?: string | null;
  pid?: number | null;
  host?: string | null;
  lastError?: string | null;
  heartbeatAt: string;
  startedAt: string;
  updatedAt: string;
};

export type DBWorkItemRow = {
  id: string;
  caseId: string;
  findingFingerprint?: string | null;
  kind: string;
  title: string;
  owner?: string | null;
  status: string;
  summary?: string | null;
  dependsOn?: string | null;
  createdAt: string;
  updatedAt: string;
};

const VALID_TRIAGE_STATUSES = new Set<FindingTriageStatus>(["new", "accepted", "suppressed"]);
const VALID_WORKFLOW_STATUSES = new Set<FindingWorkflowStatus>([
  "backlog",
  "todo",
  "agent_review",
  "in_progress",
  "human_review",
  "blocked",
  "done",
  "cancelled",
]);

export function normalizeTriageStatus(value?: string | null): FindingTriageStatus {
  return value && VALID_TRIAGE_STATUSES.has(value as FindingTriageStatus)
    ? value as FindingTriageStatus
    : "new";
}

export function inferWorkflowStatus(row: {
  status?: string | null;
  triageStatus?: string | null;
}): FindingWorkflowStatus {
  if (row.triageStatus === "accepted" || row.status === "reported" || row.status === "fixed") return "done";
  if (row.triageStatus === "suppressed" || row.status === "false-positive") return "cancelled";
  if (row.status && ["verified", "confirmed", "scored"].includes(row.status)) return "human_review";
  return "backlog";
}

export function normalizeWorkflowStatus(value?: string | null, row?: {
  status?: string | null;
  triageStatus?: string | null;
}): FindingWorkflowStatus {
  if (value && VALID_WORKFLOW_STATUSES.has(value as FindingWorkflowStatus)) {
    return value as FindingWorkflowStatus;
  }
  return inferWorkflowStatus(row ?? {});
}

export function parseSummary(summary?: string | null): Record<string, number> {
  if (!summary) return {};
  try {
    return JSON.parse(summary) as Record<string, number>;
  } catch {
    return {};
  }
}

export function parsePayload(payload: string): Record<string, unknown> | null {
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function presentationEventFromDashboardRow(
  event: DashboardRecentEventRow,
  sequence: number,
): PresentationEvent {
  const payload = parsePayload(event.payload);
  const at = Number.isFinite(event.timestamp)
    ? new Date(event.timestamp).toISOString()
    : new Date(0).toISOString();
  const source: PresentationSource =
    event.source === "cli" || event.source === "dashboard" || event.source === "adapter"
      ? event.source
      : "core";
  return createPresentationEvent({
    source,
    sequence,
    at,
    eventType: event.eventType,
    payload: event.eventType === "tool_artifact" && payload ? { ...payload, presentationEventId: event.id } : payload ?? { rawPayload: event.payload },
    scanId: event.scanId,
  });
}

export function summarizeRecentEvent(event: {
  stage: string;
  eventType: string;
  payload: Record<string, unknown> | null;
}): string {
  const payload = event.payload ?? {};
  const headline =
    typeof payload.summary === "string" && payload.summary.trim()
      ? payload.summary.trim()
      : typeof payload.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : typeof payload.reason === "string" && payload.reason.trim()
          ? payload.reason.trim()
          : typeof payload.status === "string" && payload.status.trim()
            ? payload.status.trim()
            : null;

  if (headline) return headline;

  // `tool_calls` rows come in two shapes: action-level rows carry
  // `calls[].name`, rows written before that upgrade carry only
  // `tools: string[]`. This is an append-only audit table — read both.
  const toolNames = readToolCallNames(payload);
  if (toolNames.length > 0) {
    const turn = typeof payload.turn === "number" ? `turn ${payload.turn} · ` : "";
    return `${turn}tools: ${toolNames.join(", ")}`;
  }

  if (typeof payload.excerpt === "string" && payload.excerpt.trim()) {
    const turn = typeof payload.turn === "number" ? `turn ${payload.turn} · ` : "";
    return `${turn}no tool calls · ${payload.excerpt.trim().slice(0, 120)}`;
  }

  const fields = [
    payload.target,
    payload.kind,
    payload.templateId,
    payload.verdict,
    payload.owner,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .slice(0, 2);

  if (fields.length > 0) return fields.join(" · ");
  return `${event.stage} ${event.eventType}`.replaceAll("_", " ");
}

export function summarizeScan(scan: DBScanRow) {
  const summary = parseSummary(scan.summary);
  return {
    id: scan.id,
    target: scan.target,
    depth: scan.depth,
    runtime: scan.runtime,
    mode: scan.mode,
    status: scan.status,
    startedAt: scan.startedAt,
    completedAt: scan.completedAt ?? null,
    durationMs: scan.durationMs ?? null,
    ciImport: ciReportProvenance(scan.summary),
    summary: {
      totalFindings: summary.totalFindings ?? 0,
      totalAttacks: summary.totalAttacks ?? 0,
      critical: summary.critical ?? 0,
      high: summary.high ?? 0,
      medium: summary.medium ?? 0,
      low: summary.low ?? 0,
      info: summary.info ?? 0,
    },
  };
}

export function summarizeWorker(
  worker: DBWorkerRow,
  workItemsById: Map<string, DBWorkItemRow>,
  casesById: Map<string, { target: string }>,
) {
  const heartbeatFresh = Date.now() - Date.parse(worker.heartbeatAt) < 20_000;
  const currentWorkItem = worker.currentWorkItemId ? workItemsById.get(worker.currentWorkItemId) : null;
  const currentCase = worker.currentCaseId ? casesById.get(worker.currentCaseId) : null;
  return {
    id: worker.id,
    role: worker.role === "orchestrator" ? "orchestrator" : "orchestrator",
    status: worker.status,
    label: worker.label,
    currentCaseId: worker.currentCaseId ?? null,
    currentCaseTarget: currentCase?.target ?? null,
    currentWorkItemId: worker.currentWorkItemId ?? null,
    currentWorkItemTitle: currentWorkItem?.title ?? null,
    currentWorkItemKind: (currentWorkItem?.kind as "surface_map" | "hypothesis" | "poc_build" | "blind_verify" | "consensus" | "human_review" | undefined) ?? null,
    currentScanId: worker.currentScanId ?? null,
    pid: worker.pid ?? null,
    host: worker.host ?? null,
    lastError: worker.lastError ?? null,
    heartbeatAt: worker.heartbeatAt,
    startedAt: worker.startedAt,
    updatedAt: worker.updatedAt,
    isActive: heartbeatFresh && worker.status !== "stopped",
  };
}

const EXECUTABLE_WORK_KINDS = new Set(["surface_map", "hypothesis", "poc_build", "blind_verify", "consensus"]);

export function summarizeQueue(workItems: DBWorkItemRow[], workers: DBWorkerRow[]) {
  const executableScope = workItems.filter((item) => Boolean(item.findingFingerprint));
  const workItemsById = new Map(executableScope.map((item) => [item.id, item] as const));
  const workItemsByCaseId = new Map<string, DBWorkItemRow[]>();

  for (const item of executableScope) {
    const list = workItemsByCaseId.get(item.caseId) ?? [];
    list.push(item);
    workItemsByCaseId.set(item.caseId, list);
  }

  let runnable = 0;
  let blockedByDependency = 0;
  let active = 0;
  let manualReview = 0;
  let recoveredClaims = 0;

  for (const item of executableScope) {
    if (item.status === "in_progress") active += 1;
    if (item.kind === "human_review" && item.status === "todo") manualReview += 1;
    if (item.summary?.includes("Recovered after stale worker")) recoveredClaims += 1;

    if (!EXECUTABLE_WORK_KINDS.has(item.kind)) continue;
    const dependency = item.dependsOn ? workItemsById.get(item.dependsOn) : null;
    const siblings = workItemsByCaseId.get(item.caseId) ?? [];
    const hasActiveSibling = siblings.some((candidate) => candidate.id !== item.id && candidate.status === "in_progress");
    const dependencyDone = !item.dependsOn || dependency?.status === "done";

    if (item.status === "todo" && dependencyDone && !hasActiveSibling) {
      runnable += 1;
    } else if ((item.status === "todo" || item.status === "backlog") && !dependencyDone) {
      blockedByDependency += 1;
    }
  }

  const staleWorkers = workers.filter(
    (worker) => worker.status === "error" && typeof worker.lastError === "string" && worker.lastError.includes("Heartbeat expired"),
  ).length;

  return {
    runnable,
    active,
    blockedByDependency,
    manualReview,
    staleWorkers,
    recoveredClaims,
  };
}

export function normalizeFinding(row: DBFindingRow) {
  let impact: unknown = row.impactAssessment;
  if (typeof impact === "string") { try { impact = JSON.parse(impact); } catch { impact = undefined; } }
  const parsedImpact = ImpactAssessmentSchema.safeParse(impact);
  return {
    ...row,
    impactAssessment: parsedImpact.success ? parsedImpact.data : null,
    triageStatus: normalizeTriageStatus(row.triageStatus),
    workflowStatus: normalizeWorkflowStatus(row.workflowStatus, row),
    workflowAssignee: row.workflowAssignee ?? null,
    workflowUpdatedAt: row.workflowUpdatedAt ?? null,
  };
}

export function buildWorkflowSummary(
  rows: DBFindingRow[],
  verdicts: DBVerdictRow[],
  sessions: Array<Pick<DBSessionRow, "status" | "agentRole">>,
  historicalVerdictCounts?: { truePositive: number; falsePositive: number; unsure: number; total: number },
) {
  const latest = rows[0]!;
  const verdictCounts = historicalVerdictCounts ?? verdicts.reduce(
    (acc, verdict) => {
      if (verdict.verdict === "TRUE_POSITIVE") acc.truePositive += 1;
      else if (verdict.verdict === "FALSE_POSITIVE") acc.falsePositive += 1;
      else acc.unsure += 1;
      acc.total += 1;
      return acc;
    },
    { truePositive: 0, falsePositive: 0, unsure: 0, total: 0 },
  );

  let consensus: "verified" | "false-positive" | "disputed" | "pending" = "pending";
  if (verdictCounts.total > 0) {
    if (verdictCounts.truePositive === verdictCounts.total) consensus = "verified";
    else if (verdictCounts.falsePositive === verdictCounts.total) consensus = "false-positive";
    else consensus = "disputed";
  }

  const activeAgentRoles = [...new Set(
    sessions
      .filter((session) => session.status === "running")
      .map((session) => session.agentRole),
  )];

  const persistedStatus = normalizeWorkflowStatus(latest.workflowStatus, latest);
  const evidenceSignal =
    consensus === "verified"
      ? "strong"
      : consensus === "disputed" || verdictCounts.total > 0 || (latest.confidence ?? 0) >= 0.7
        ? "medium"
        : "weak";

  const recommendedStatus =
    activeAgentRoles.length > 0
      ? "in_progress"
      : consensus === "disputed" || verdictCounts.total > 0
        ? "agent_review"
        : consensus === "verified" || consensus === "false-positive" || ["verified", "confirmed", "scored", "reported", "fixed", "false-positive"].includes(latest.status)
          ? "human_review"
          : persistedStatus;

  const reviewGate = deriveReviewGate(consensus, verdictCounts, latest.status);
  const phase = deriveWorkflowPhase(persistedStatus, reviewGate, activeAgentRoles.length > 0);
  const reviewReason = deriveReviewReason(reviewGate, consensus, verdictCounts, activeAgentRoles, latest.status);

  const status =
    persistedStatus === "done" || persistedStatus === "cancelled"
      ? persistedStatus
      : recommendedStatus;

  return {
    status,
    persistedStatus,
    recommendedStatus,
    phase,
    reviewGate,
    reviewReason,
    assignee: latest.workflowAssignee ?? null,
    updatedAt: latest.workflowUpdatedAt ?? null,
    consensus,
    activeAgentRoles,
    evidenceSignal,
    verdictCounts,
  };
}

function deriveWorkflowPhase(
  persistedStatus: FindingWorkflowStatus,
  reviewGate: "none" | "agent_review" | "human_review",
  hasActiveAgents: boolean,
): "backlog" | "todo" | "in_progress" | "blocked" | "done" | "cancelled" {
  if (persistedStatus === "done" || persistedStatus === "cancelled" || persistedStatus === "blocked") {
    return persistedStatus;
  }
  if (hasActiveAgents || persistedStatus === "in_progress") return "in_progress";
  if (persistedStatus === "todo") return "todo";
  if (persistedStatus === "agent_review" || persistedStatus === "human_review") return "todo";
  if (reviewGate !== "none") return "todo";
  return "backlog";
}

function deriveReviewGate(
  consensus: "verified" | "false-positive" | "disputed" | "pending",
  verdictCounts: { truePositive: number; falsePositive: number; unsure: number; total: number },
  latestStatus: string,
): "none" | "agent_review" | "human_review" {
  if (
    consensus === "verified"
    || consensus === "false-positive"
    || ["verified", "confirmed", "scored", "reported", "fixed", "false-positive"].includes(latestStatus)
  ) {
    return "human_review";
  }

  if (consensus === "disputed" || verdictCounts.total > 0) {
    return "agent_review";
  }

  return "none";
}

function deriveReviewReason(
  reviewGate: "none" | "agent_review" | "human_review",
  consensus: "verified" | "false-positive" | "disputed" | "pending",
  verdictCounts: { truePositive: number; falsePositive: number; unsure: number; total: number },
  activeAgentRoles: string[],
  recordedStatus: string,
): string | null {
  if (reviewGate === "human_review") {
    if (consensus === "verified") return "Retained verifier votes indicate a true positive and need operator sign-off; inspect the reproduction evidence.";
    if (consensus === "false-positive") return "Retained verifier votes indicate a false positive and need final suppression.";
    return `Recorded status is ${recordedStatus}; no verifier verdicts are retained. Review the evidence before disposition.`;
  }

  if (reviewGate === "agent_review") {
    if (consensus === "disputed") return "Agent verdicts disagree and need another pass.";
    if (verdictCounts.total > 0) return "At least one verifier has voted, but consensus is not final yet.";
    if (activeAgentRoles.length > 0) return "Verifier activity is in progress and may need follow-up review.";
  }

  return null;
}

export function groupFindings(
  rows: DBFindingRow[],
  verdictsByFindingId: Map<string, DBVerdictRow[]>,
  sessionsByScanId: Map<string, DBSessionRow[]>,
) {
  const map = new Map<string, DBFindingRow[]>();
  for (const row of rows) {
    const key = row.fingerprint ?? row.id;
    const list = map.get(key) ?? [];
    list.push(normalizeFinding(row));
    map.set(key, list);
  }

  return [...map.entries()]
    .map(([fingerprint, items]) => {
      const sorted = items.sort((a, b) => b.timestamp - a.timestamp);
      const latest = sorted[0];
      const familyVerdicts = sorted.flatMap((item) => verdictsByFindingId.get(item.id) ?? []);
      const familySessions = [...new Map(
        sorted
          .flatMap((item) => sessionsByScanId.get(item.scanId) ?? [])
          .map((session) => [session.id, session]),
      ).values()];
      return {
        fingerprint,
        latest,
        count: sorted.length,
        scanCount: new Set(sorted.map((item) => item.scanId)).size,
        sourceScanIds: [...new Set(sorted.map((item) => item.scanId))].sort(),
        workflow: buildWorkflowSummary(sorted, familyVerdicts, familySessions),
      };
    })
    .sort((a, b) => b.latest.timestamp - a.latest.timestamp);
}

export function caseIdFromTarget(target: string): string {
  return `case:${encodeURIComponent(target.trim().toLowerCase())}`;
}

export function inferCaseTargetType(scan: DBScanRow | undefined): "ai-app" | "package" | "repository" | "web-app" | "unknown" {
  if (!scan) return "unknown";
  if (scan.mode === "web") return "web-app";
  if (scan.mode === "probe" || scan.mode === "mcp") return "ai-app";
  if (scan.target.startsWith("http://") || scan.target.startsWith("https://")) return "ai-app";
  if (scan.target.startsWith("/") || scan.target.startsWith(".") || scan.target.includes("/")) return "repository";
  if (!scan.target.includes(" ")) return "package";
  return "unknown";
}

export function buildCases(scans: DBScanRow[], groups: ReturnType<typeof groupFindings>) {
  const scansById = new Map(scans.map((scan) => [scan.id, scan] as const));
  const map = new Map<string, {
    id: string;
    target: string;
    targetType: "ai-app" | "package" | "repository" | "web-app" | "unknown";
    latestScanId: string | null;
    latestTimestamp: number;
    scanIds: Set<string>;
    familyFingerprints: Set<string>;
    activeRunCount: number;
    reviewCount: number;
    openWorkItemCount: number;
  }>();

  for (const scan of scans) {
    const caseId = caseIdFromTarget(scan.target);
    const existing = map.get(caseId) ?? {
      id: caseId,
      target: scan.target,
      targetType: inferCaseTargetType(scan),
      latestScanId: scan.id,
      latestTimestamp: Date.parse(scan.startedAt) || 0,
      scanIds: new Set<string>(),
      familyFingerprints: new Set<string>(),
      activeRunCount: 0,
      reviewCount: 0,
      openWorkItemCount: 0,
    };

    existing.scanIds.add(scan.id);
    if (scan.status === "running") existing.activeRunCount += 1;
    const started = Date.parse(scan.startedAt) || 0;
    if (started >= existing.latestTimestamp) {
      existing.latestTimestamp = started;
      existing.latestScanId = scan.id;
      existing.target = scan.target;
      existing.targetType = inferCaseTargetType(scan);
    }
    map.set(caseId, existing);
  }

  for (const group of groups) {
    const scan = scansById.get(group.latest.scanId);
    if (!scan) continue;
    const caseId = caseIdFromTarget(scan.target);
    const existing = map.get(caseId);
    if (!existing) continue;
    existing.familyFingerprints.add(group.fingerprint);
    if (group.workflow.reviewGate !== "none") existing.reviewCount += 1;
    if (group.workflow.phase !== "done" && group.workflow.phase !== "cancelled") existing.openWorkItemCount += 1;
  }

  return [...map.values()]
    .map((item) => ({
      id: item.id,
      target: item.target,
      targetType: item.targetType,
      latestScanId: item.latestScanId,
      scanCount: item.scanIds.size,
      familyCount: item.familyFingerprints.size,
      activeRunCount: item.activeRunCount,
      reviewCount: item.reviewCount,
      openWorkItemCount: item.openWorkItemCount,
    }))
    .sort((a, b) => b.activeRunCount - a.activeRunCount || b.reviewCount - a.reviewCount || b.familyCount - a.familyCount);
}

export function buildWorkItems(args: {
  fingerprint: string;
  workflow: ReturnType<typeof buildWorkflowSummary>;
  rows: DBFindingRow[];
  verdicts: DBVerdictRow[];
}) {
  const { fingerprint, workflow, rows, verdicts } = args;
  const latest = rows[0]!;
  const hasAnalysis = Boolean(latest.evidenceAnalysis?.trim());
  const hasEvidence = Boolean(latest.evidenceRequest.trim() || latest.evidenceResponse.trim());
  const hasVerifierVotes = verdicts.length > 0;
  const activeOwner = workflow.activeAgentRoles[0] ?? null;

  return [
    {
      id: `${fingerprint}:surface_map`,
      kind: "surface_map",
      title: "Attack surface mapping",
      owner: "attack-surface-agent",
      status: hasEvidence ? "done" : "in_progress",
      summary: "Map the target, reachable surfaces, and initial candidate family context.",
    },
    {
      id: `${fingerprint}:hypothesis`,
      kind: "hypothesis",
      title: "Exploit hypothesis",
      owner: "research-agent",
      status: hasAnalysis ? "done" : hasEvidence ? "in_progress" : "todo",
      summary: "Turn the initial surface signal into a concrete exploit theory.",
    },
    {
      id: `${fingerprint}:poc_build`,
      kind: "poc_build",
      title: "PoC build",
      owner: workflow.assignee ?? activeOwner,
      status: workflow.phase === "in_progress" ? "in_progress" : hasEvidence ? "done" : "todo",
      summary: "Create or refine the exploit artifact chain and reproduction steps.",
    },
    {
      id: `${fingerprint}:blind_verify`,
      kind: "blind_verify",
      title: "Blind verify",
      owner: activeOwner,
      status: workflow.phase === "in_progress" ? "in_progress" : hasVerifierVotes ? "done" : "todo",
      summary: "Independent verifier takes only the PoC and artifact path.",
    },
    {
      id: `${fingerprint}:consensus`,
      kind: "consensus",
      title: "Consensus",
      owner: "consensus-agent",
      status: workflow.reviewGate === "agent_review" ? "in_progress" : hasVerifierVotes ? "done" : "backlog",
      summary: "Resolve partial or conflicting verifier evidence into the next step.",
    },
    {
      id: `${fingerprint}:human_review`,
      kind: "human_review",
      title: "Human review",
      owner: "operator",
      status:
        workflow.phase === "done" || workflow.phase === "cancelled"
          ? "done"
          : workflow.reviewGate === "human_review"
            ? "in_progress"
            : workflow.reviewGate === "agent_review"
              ? "blocked"
              : "backlog",
      summary: "Final operator sign-off before report, suppression, or closure.",
    },
  ] as const;
}

export function buildArtifacts(args: {
  fingerprint: string;
  latest: DBFindingRow;
  verdicts: DBVerdictRow[];
  sessions: DBSessionRow[];
  events: DBEventRow[];
}) {
  const { fingerprint, latest, verdicts, sessions, events } = args;
  return [
    {
      id: `${fingerprint}:request`,
      kind: "request",
      label: "Exploit request",
      summary: latest.evidenceRequest ? `${latest.evidenceRequest.length} chars captured` : "No request artifact captured",
    },
    {
      id: `${fingerprint}:response`,
      kind: "response",
      label: "Exploit response",
      summary: latest.evidenceResponse ? `${latest.evidenceResponse.length} chars captured` : "No response artifact captured",
    },
    {
      id: `${fingerprint}:analysis`,
      kind: "analysis",
      label: "Analysis",
      summary: latest.evidenceAnalysis ? "Research analysis attached" : "No attached family analysis yet",
    },
    {
      id: `${fingerprint}:verdicts`,
      kind: "verdicts",
      label: "Verifier verdicts",
      summary: verdicts.length > 0 ? `${verdicts.length} verifier vote${verdicts.length > 1 ? "s" : ""}` : "No blind verifier verdicts yet",
    },
    {
      id: `${fingerprint}:sessions`,
      kind: "sessions",
      label: "Agent missions",
      summary: sessions.length > 0 ? `${sessions.length} agent mission${sessions.length > 1 ? "s" : ""} linked` : "No agent missions linked",
    },
    {
      id: `${fingerprint}:events`,
      kind: "events",
      label: "Pipeline events",
      summary: events.length > 0 ? `${events.length} audit event${events.length > 1 ? "s" : ""} recorded` : "No pipeline events linked",
    },
  ] as const;
}

export function groupByKey<T, K extends keyof T>(rows: T[], key: K) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== "string") continue;
    const list = map.get(value) ?? [];
    list.push(row);
    map.set(value, list);
  }
  return map;
}

export type FindingWorkflowStatus =
  | "backlog"
  | "todo"
  | "agent_review"
  | "in_progress"
  | "human_review"
  | "blocked"
  | "done"
  | "cancelled";
