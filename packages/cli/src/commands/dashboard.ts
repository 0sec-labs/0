import { ImpactAssessmentSchema } from "@0/shared/dist/finding-priority.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import type { Command } from "commander";
import chalk from "chalk";
import { z } from "zod";
import {
  createPresentationEvent,
  BackendRequestIdSchema,
  ScanResumeRequestSchema,
  type FindingTriageStatus,
  type PresentationEvent,
  type PresentationSource,
} from "@0/shared";
import { LlmApiRuntime, readToolCallNames, exportReport, isReportExportFormat } from "@0/core";
import { presentationEventBus } from "../presentation/event-bus.js";
import { buildFindingConsoleCommand } from "../finding-handoff.js";
import { workbenchStatus } from "./workbench.js";
import { ConsoleGateway, ConsoleGatewayError } from "../web/console-gateway.js";
import { WebOperatorServices } from "../web/operator-services.js";
import { WebWorkflowService } from "../web/workflows.js";
import { WorkflowTriggerService } from "../web/workflow-triggers.js";
import { GitHubPublicationAuth } from "../web/github-auth.js";
import { DASHBOARD_ASSETS, type EmbeddedDashboardAsset } from "../dashboard-assets.generated.js";
import { findDashboardInstance } from "../web/dashboard-instance.js";
import { BackendConnectionRegistry, backendBearerFromEnv, createBackendHandshake, handleBackendConnectionRequest } from "../web/backend-connections.js";
import { WorkflowEngineService } from "../workflow-engine-service.js";
import { retainedScanSnapshot, retainedFindingSnapshot } from "../web/report-artifacts.js";
import { handleFindingImpactRequest } from "../web/finding-impact.js";
import { FindingsAccessError, FindingsAccessTokenStore, handleFindingsAccessTokenRequest } from "../web/findings-access-tokens.js";
import { FindingsReadApi, handleFindingsReadRequest } from "../web/findings-read-api.js";
import { SkillsStore } from "../web/skills.js";
import { EngagementStore } from "../web/engagements.js";
import { engagementMarkdown } from "../web/engagement-report.js";
import { createWorkspaceServices } from "../web/workspace-services.js";
import { findTeamConfigPath, handleTeamSetupRequest, TeamSetupService } from "../web/team-setup.js";
import { TeamAuth, TeamAuthError, getSessionId } from "../web/team-auth.js";
import { CollaborationService } from "../web/collaboration.js";
import { authorizeTeamApi, handleTeamRequest, assertTeamConsoleMutation } from "../web/team-web.js";
import { handleTeamPresenceStream } from "../web/team-presence-stream.js";
import { homeStateDir } from "@0/shared";
import { assertLocalEngineAvailable, registerLocalEngine } from "../local-engine.js";

type DashboardOptions = {
  dbPath?: string;
  port?: string;
  host?: string;
  assetDir?: string;
  devUrl?: string;
  readyJson?: boolean;
  backendsConfig?: string;
  teamConfig?: string;
  engineTokenEnv?: string;
  engineWorkspace?: string;
  engineScope?: string;
  engineTarget?: string;
  engineAllowApply?: boolean;
  engineTimeCap?: string;
  engineCostCap?: string;
  // Commander 12 maps `--no-open` to `opts.open = false` (not `opts.noOpen = true`).
  // See: https://github.com/tj/commander.js/blob/master/Readme.md#other-option-types-negatable-boolean-and-booleanvalue
  open?: boolean;
};

class WebRequestError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

const WEB_HOST_ALIASES: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

function errorStatusCode(error: unknown): number {
  if (error instanceof z.ZodError) return 400;
  if (error && typeof error === "object" && "statusCode" in error &&
      typeof error.statusCode === "number" && Number.isInteger(error.statusCode) &&
      error.statusCode >= 400 && error.statusCode < 600) return error.statusCode;
  return 500;
}

/** Do not issue a local execution capability through a rebinding hostname. */
function authorizeWebRequest(req: IncomingMessage, origin: string): void {
  const serverUrl = new URL(origin);
  const authority = req.headers.host;
  if (!authority || !/^[A-Za-z0-9.[\]:-]+$/.test(authority)) throw new WebRequestError("Invalid web application host.", 403);
  const requestOrigin = new URL(`http://${authority}`);
  if ((requestOrigin.hostname !== serverUrl.hostname && !WEB_HOST_ALIASES[requestOrigin.hostname]) ||
      requestOrigin.port !== serverUrl.port) throw new WebRequestError("Use the bound loopback host and port.", 403);
  if (req.headers.origin !== undefined && req.headers.origin !== requestOrigin.origin) {
    throw new WebRequestError("Cross-origin web application requests are not allowed.", 403);
  }
  // An OIDC provider returns through a top-level cross-site GET. Its one-use
  // state and browser cookie are checked by TeamAuth before issuing a session.
  const ssoCallback = req.method === "GET" && /^\/api\/team\/auth\/callback(?:\?|$)/.test(req.url ?? "");
  if (req.url?.startsWith("/api/") && req.headers["sec-fetch-site"] === "cross-site" && !ssoCallback) {
    throw new WebRequestError("Cross-site control requests are not allowed.", 403);
  }
  if (!req.url?.startsWith("/") || req.url.startsWith("//")) throw new WebRequestError("Invalid request target.", 400);
}

type ManagedDaemonState = {
  child: ChildProcess;
  label: string;
};

let managedDaemon: ManagedDaemonState | null = null;

type DBFindingRow = {
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

type DBScanRow = {
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

type DBEventRow = {
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

type DashboardRecentEventRow = DBEventRow & {
  scanTarget: string;
  findingFingerprint?: string | null;
};

type DBVerdictRow = {
  id: string;
  findingId: string;
  agentRole: string;
  model: string;
  verdict: string;
  confidence: number;
  reasoning: string;
  timestamp: number;
};

type DBSessionRow = {
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

type DBWorkerRow = {
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

type DBWorkItemRow = {
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
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => {});
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendFile(res: ServerResponse, filePath: string, controlToken?: string): void {
  const ext = extname(filePath);
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  res.writeHead(200, {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Type": contentType,
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
  });
  let content: string | Buffer = readFileSync(filePath);
  // Inject the per-session control token into HTML pages so the dashboard
  // frontend can attach it to control API requests.
  if (controlToken && ext === ".html") {
    content = content.toString().replace(
      "</head>",
      `<meta name="0-control-token" content="${controlToken}"></head>`,
    );
  }
  res.end(content);
}

function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  const onData = (chunk: Buffer | string) => {
    if (settled) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > maxBytes) {
      settled = true;
      req.removeListener("data", onData);
      req.resume();
      reject(new WebRequestError("Request body too large.", 413));
      return;
    }
    chunks.push(data);
  };
  req.on("data", onData);
  req.on("end", () => {
    if (settled) return;
    settled = true;
    try {
      const data = Buffer.concat(chunks, bytes).toString("utf8");
      resolve(data ? JSON.parse(data) : {});
    } catch { reject(new WebRequestError("Request body is not valid JSON.", 400)); }
  });
  req.on("error", error => {
    if (!settled) { settled = true; reject(error); }
  });
  return promise;
}

function normalizeTriageStatus(value?: string | null): FindingTriageStatus {
  return value && VALID_TRIAGE_STATUSES.has(value as FindingTriageStatus)
    ? value as FindingTriageStatus
    : "new";
}

function inferWorkflowStatus(row: {
  status?: string | null;
  triageStatus?: string | null;
}): FindingWorkflowStatus {
  if (row.triageStatus === "accepted" || row.status === "reported" || row.status === "fixed") return "done";
  if (row.triageStatus === "suppressed" || row.status === "false-positive") return "cancelled";
  if (row.status && ["verified", "confirmed", "scored"].includes(row.status)) return "human_review";
  return "backlog";
}

function normalizeWorkflowStatus(value?: string | null, row?: {
  status?: string | null;
  triageStatus?: string | null;
}): FindingWorkflowStatus {
  if (value && VALID_WORKFLOW_STATUSES.has(value as FindingWorkflowStatus)) {
    return value as FindingWorkflowStatus;
  }
  return inferWorkflowStatus(row ?? {});
}

function parseSummary(summary?: string | null): Record<string, number> {
  if (!summary) return {};
  try {
    return JSON.parse(summary) as Record<string, number>;
  } catch {
    return {};
  }
}

function parsePayload(payload: string): Record<string, unknown> | null {
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function presentationEventFromDashboardRow(
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

function summarizeRecentEvent(event: {
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

function summarizeScan(scan: DBScanRow) {
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

function summarizeWorker(
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

function summarizeQueue(workItems: DBWorkItemRow[], workers: DBWorkerRow[]) {
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

function normalizeFinding(row: DBFindingRow) {
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

function buildWorkflowSummary(
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
  } else if (latest.status === "false-positive") {
    consensus = "false-positive";
  } else if (["verified", "confirmed", "scored", "reported", "fixed"].includes(latest.status)) {
    consensus = "verified";
  }

  const activeAgentRoles = [...new Set(
    sessions
      .filter((session) => session.status === "running")
      .map((session) => session.agentRole),
  )];

  const persistedStatus = normalizeWorkflowStatus(latest.workflowStatus, latest);
  const evidenceSignal =
    consensus === "verified" || latest.status === "reported" || latest.status === "scored" || latest.status === "fixed"
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
  const reviewReason = deriveReviewReason(reviewGate, consensus, verdictCounts, activeAgentRoles);

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
): string | null {
  if (reviewGate === "human_review") {
    if (consensus === "verified") return "Consensus indicates a true positive and needs operator sign-off.";
    if (consensus === "false-positive") return "Consensus indicates a false positive and needs final suppression.";
    return "Verification artifacts are strong enough for human disposition.";
  }

  if (reviewGate === "agent_review") {
    if (consensus === "disputed") return "Agent verdicts disagree and need another pass.";
    if (verdictCounts.total > 0) return "At least one verifier has voted, but consensus is not final yet.";
    if (activeAgentRoles.length > 0) return "Verifier activity is in progress and may need follow-up review.";
  }

  return null;
}

function groupFindings(
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
        workflow: buildWorkflowSummary(sorted, familyVerdicts, familySessions),
      };
    })
    .sort((a, b) => b.latest.timestamp - a.latest.timestamp);
}

function caseIdFromTarget(target: string): string {
  return `case:${encodeURIComponent(target.trim().toLowerCase())}`;
}

function inferCaseTargetType(scan: DBScanRow | undefined): "ai-app" | "package" | "repository" | "web-app" | "unknown" {
  if (!scan) return "unknown";
  if (scan.mode === "web") return "web-app";
  if (scan.mode === "probe" || scan.mode === "mcp") return "ai-app";
  if (scan.target.startsWith("http://") || scan.target.startsWith("https://")) return "ai-app";
  if (scan.target.startsWith("/") || scan.target.startsWith(".") || scan.target.includes("/")) return "repository";
  if (!scan.target.includes(" ")) return "package";
  return "unknown";
}

function buildCases(scans: DBScanRow[], groups: ReturnType<typeof groupFindings>) {
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

function buildWorkItems(args: {
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

function buildArtifacts(args: {
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
      label: "Agent sessions",
      summary: sessions.length > 0 ? `${sessions.length} agent session${sessions.length > 1 ? "s" : ""} linked` : "No agent sessions linked",
    },
    {
      id: `${fingerprint}:events`,
      kind: "events",
      label: "Pipeline events",
      summary: events.length > 0 ? `${events.length} audit event${events.length > 1 ? "s" : ""} recorded` : "No pipeline events linked",
    },
  ] as const;
}

function parseScanPath(pathname: string): { scanId: string; suffix?: "events" | "findings" } | null {
  const match = pathname.match(/^\/api\/scans\/([^/]+)(?:\/(events|findings))?$/);
  if (!match) return null;
  return {
    scanId: decodeURIComponent(match[1]),
    suffix: match[2] as "events" | "findings" | undefined,
  };
}


function isPresentationEventsStreamPath(pathname: string): boolean {
  return pathname === "/api/v1/presentation/events";
}
function parseRecentEventsPath(pathname: string): boolean {
  return pathname === "/api/events/recent";
}

function parseFindingFamilyPath(pathname: string): { fingerprint: string; action?: "triage" | "workflow" } | null {
  const match = pathname.match(/^\/api\/finding-family\/([^/]+)(?:\/(triage|workflow))?$/);
  if (!match) return null;
  return {
    fingerprint: decodeURIComponent(match[1]),
    action: match[2] as "triage" | "workflow" | undefined,
  };
}

function parseControlPath(pathname: string): {
  action:
    | "recover-stale-workers"
    | "prune-stopped-workers"
    | "reset-database"
    | "start-daemon"
    | "stop-daemon"
    | "launch-run";
} | null {
  const match = pathname.match(/^\/api\/control\/(recover-stale-workers|prune-stopped-workers|reset-database|start-daemon|stop-daemon|launch-run)$/);
  if (!match) return null;
  return {
    action: match[1] as
      | "recover-stale-workers"
      | "prune-stopped-workers"
      | "reset-database"
      | "start-daemon"
      | "stop-daemon"
      | "launch-run",
  };
}

function resolveCliEntrypoint(): string {
  return resolve(process.argv[1] ?? join(process.cwd(), "dist", "index.js"));
}

function startManagedDaemon(args: {
  dbPath?: string;
  label: string;
  pollIntervalMs?: number;
}): { pid: number | null; label: string } {
  if (managedDaemon?.child.exitCode === null && !managedDaemon.child.killed) {
    return { pid: managedDaemon.child.pid ?? null, label: managedDaemon.label };
  }

  const cliEntrypoint = resolveCliEntrypoint();
  const childArgs = [
    cliEntrypoint,
    "orchestrate",
    "--watch",
    "--poll-interval",
    String(args.pollIntervalMs ?? 2000),
    "--label",
    args.label,
  ];

  if (args.dbPath) {
    childArgs.push("--db-path", args.dbPath);
  }

  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    stdio: "ignore",
  });

  child.unref();
  managedDaemon = { child, label: args.label };
  child.once("exit", () => {
    if (managedDaemon?.child.pid === child.pid) {
      managedDaemon = null;
    }
  });

  return { pid: child.pid ?? null, label: args.label };
}

function isLiveLocalPid(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ESRCH") return false;
    return true;
  }
}

function stopDaemonWorkers(
  osecDb: typeof import("@0/db").osecDB,
  dbPath: string | undefined,
): number {
  const db = new osecDb(dbPath);

  try {
    const workers = db.listWorkers(100) as DBWorkerRow[];
    let stopped = 0;

    for (const worker of workers) {
      const heartbeatFresh = Date.now() - Date.parse(worker.heartbeatAt) < 20_000;
      if (worker.status === "stopped" || !heartbeatFresh) continue;

      if (worker.pid) {
        try {
          process.kill(worker.pid, "SIGTERM");
          stopped += 1;
        } catch {
          // Ignore already-exited or inaccessible processes.
        }
      }

      db.upsertWorker({
        id: worker.id,
        role: "orchestrator",
        status: "stopped",
        label: worker.label,
        currentCaseId: null,
        currentWorkItemId: null,
        currentScanId: null,
        pid: worker.pid ?? null,
        host: worker.host ?? null,
        lastError: worker.lastError?.trim() || "Stopped from dashboard control.",
      });
    }

    if (managedDaemon?.child.pid) {
      try {
        managedDaemon.child.kill("SIGTERM");
      } catch {
        // Ignore if already gone.
      }
      managedDaemon = null;
    }
    return stopped;
  } finally {
    db.close();
  }
}

function groupByKey<T, K extends keyof T>(rows: T[], key: K) {
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

type DashboardAssetDirectory = {
  path: string;
  cleanup?: () => void;
};

function materializeEmbeddedDashboardAssets(
  assets: readonly EmbeddedDashboardAsset[],
): DashboardAssetDirectory | null {
  if (assets.length === 0) return null;

  const assetDir = mkdtempSync(join(tmpdir(), "0-dashboard-"));
  try {
    for (const [relativePath, contentBase64] of assets) {
      const candidate = resolve(assetDir, `.${relativePath.replaceAll("\\", "/")}`);
      if (candidate === assetDir || !candidate.startsWith(`${assetDir}${sep}`)) {
        throw new Error(`Invalid embedded dashboard asset path: ${JSON.stringify(relativePath)}`);
      }
      mkdirSync(dirname(candidate), { recursive: true, mode: 0o700 });
      writeFileSync(candidate, Buffer.from(contentBase64, "base64"), { mode: 0o600 });
    }
    if (!existsSync(join(assetDir, "index.html"))) {
      throw new Error("Embedded dashboard assets do not contain index.html.");
    }
  } catch (error) {
    rmSync(assetDir, { recursive: true, force: true });
    throw error;
  }

  return {
    path: assetDir,
    cleanup: () => rmSync(assetDir, { recursive: true, force: true }),
  };
}

function resolveDashboardAssetDir(explicitAssetDir?: string): DashboardAssetDirectory {
  const moduleDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
  const candidates = [
    ...(explicitAssetDir ? [resolve(explicitAssetDir)] : []),
    join(moduleDir, "dashboard"),
    join(moduleDir, "..", "dashboard"),
    // A source checkout must serve the freshly built workspace dashboard,
    // not an unrelated stale root bundle left by an earlier packaging run.
    join(process.cwd(), "packages", "dashboard", "dist"),
    join(process.cwd(), "dist", "dashboard"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      return { path: candidate };
    }
  }

  const embedded = materializeEmbeddedDashboardAssets(DASHBOARD_ASSETS);
  if (embedded) return embedded;
  throw new Error("Dashboard assets not found. Run `pnpm build` to generate the dashboard app.");
}

function resolveAssetPath(assetDir: string, pathname: string): string | null {
  const trimmed = pathname === "/" ? "/index.html" : pathname;
  const assetRoot = resolve(assetDir);
  const candidate = resolve(assetRoot, `.${trimmed}`);
  if (candidate !== assetRoot && !candidate.startsWith(`${assetRoot}${sep}`)) return null;
  if (!existsSync(candidate)) return null;
  return candidate;
}

function requireControlToken(req: IncomingMessage, res: ServerResponse, controlToken: string, engineBearer?: string): boolean {
  const provided = req.headers["x-0-control-token"];
  const matches = (a: unknown, b: string) => typeof a === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const bearer = typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
  if (!matches(provided, controlToken) && !matches(bearer, controlToken) && !(engineBearer && matches(bearer, engineBearer))) {
    json(res, 403, { error: "Invalid or missing control token" });
    return false;
  }
  return true;
}


function consoleEventsAfter(value: string | null): number {
  if (value === null || value === "") return 0;
  const after = Number(value);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new ConsoleGatewayError("Event cursor must be a non-negative integer.", 400);
  }
  return after;
}

async function handleWebConsoleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  gateway: ConsoleGateway,
  operator: WebOperatorServices,
  workflows: WebWorkflowService,
  triggers: WorkflowTriggerService,
  github: GitHubPublicationAuth,
  team?: { auth: TeamAuth; collaboration?: CollaborationService },
): Promise<boolean> {
  if (!requestUrl.pathname.startsWith("/api/console/")) return false;
  const method = req.method ?? "GET";
  const path = requestUrl.pathname.slice("/api/console/".length);
  const input = method === "GET" || method === "HEAD" ? undefined : await readJson(req);
  const member = team?.auth.resolveSession(req);
  const author = member ? { userId: member.userId, displayName: member.displayName } : undefined;
  if (team && method !== "GET" && method !== "HEAD") {
    const readResume = /^saved\/[^/]+\/resume$/.test(path) && input !== null && typeof input === "object" && Object.keys(input).length === 0;
    if (/^saved\/[^/]+\/resume$/.test(path) && team.auth.resolveSession(req)?.role !== "owner" && !readResume) throw new WebRequestError("Only workspace owners can override a saved conversation's configuration.", 403);
    const liveId = /^sessions\/([^/]+)/.exec(path)?.[1];
    const bodyId = input && typeof input === "object" && "sessionId" in input && typeof input.sessionId === "string" ? input.sessionId : undefined;
    const savedId = /^saved\/([^/]+)/.exec(path)?.[1];
    const savedLiveId = savedId ? gateway.list().find(item => item.id === savedId || item.savedId === savedId)?.id : undefined;
    const id = liveId ?? bodyId ?? savedLiveId;
    if (id && !readResume) assertTeamConsoleMutation(req, id, team.auth, team.collaboration, gateway);
  }
  try {
    if (path === "execution" && method === "GET") { json(res, 200, await workbenchStatus()); return true; }
    if (path === "github" && method === "GET") { json(res, 200, { github: await github.status() }); return true; }
    if (path === "github/connect" && method === "POST") { json(res, 200, { github: await github.connect(input) }); return true; }
    if (path === "github/device-auth" && method === "POST") { json(res, 202, { github: await github.start() }); return true; }
    if (path === "github/device-auth" && method === "DELETE") { json(res, 200, { github: await github.cancel() }); return true; }
    const trigger = await triggers.handle(method, requestUrl, input);
    if (trigger) { json(res, trigger.status, trigger.data); return true; }
    const workflow = await workflows.handle(requestUrl.pathname, method, input, requestUrl.searchParams);
    if (workflow) {
      if (team?.collaboration && method !== "GET" && method !== "HEAD" && workflow.status >= 200 && workflow.status < 300) {
        const definition = workflow.data && typeof workflow.data === "object" && "definition" in workflow.data ? workflow.data.definition : undefined;
        const id = definition && typeof definition === "object" && "id" in definition && typeof definition.id === "string" ? definition.id : /^\/api\/console\/workflow-definitions\/([^/]+)/.exec(requestUrl.pathname)?.[1];
        if (id) team.collaboration.notifyChanged("workflow", decodeURIComponent(id));
      }
      json(res, workflow.status, workflow.data); return true;
    }
    const service = await operator.handle(requestUrl.pathname, method, input, requestUrl.searchParams);
    if (service) { json(res, service.status, service.data); return true; }
    if (path === "search" && method === "GET") {
      json(res, 200, await gateway.search({
        q: requestUrl.searchParams.get("q") ?? "",
        ...(requestUrl.searchParams.has("limit") ? { limit: Number(requestUrl.searchParams.get("limit")) } : {}),
        ...(requestUrl.searchParams.has("offset") ? { offset: Number(requestUrl.searchParams.get("offset")) } : {}),
      }));
      return true;
    }
    if (path === "sessions") {
      if (method === "GET") json(res, 200, { sessions: gateway.list() });
      else if (method === "POST") {
        const session = gateway.create(input);
        if (team?.auth.enabled && team.collaboration) team.collaboration.register(session.id, getSessionId(req)!);
        json(res, 201, { session });
      }
      else json(res, 405, { error: "Method not allowed." });
      return true;
    }
    const parts = path.split("/").map(part => decodeURIComponent(part));
    if (parts.some(part => !/^[A-Za-z0-9_.:-]+$/.test(part))) throw new ConsoleGatewayError("Invalid resource identifier.", 400);
    if (parts[0] === "saved") {
      const id = parts[1];
      if (!id && method === "GET") {
        const limit = requestUrl.searchParams.get("limit");
        json(res, 200, { sessions: gateway.listSaved({
          ...(requestUrl.searchParams.get("cwd") ? { cwd: requestUrl.searchParams.get("cwd") } : {}),
          ...(limit ? { limit: Number(limit) } : {}),
        }) });
      } else if (id && parts.length === 2 && method === "GET") json(res, 200, gateway.loadSaved(id));
      else if (id && parts.length === 2 && method === "DELETE") { gateway.deleteSaved(id); json(res, 200, { ok: true }); }
      else if (id && parts[2] === "archive" && method === "POST") json(res, 200, { session: gateway.archiveSaved(id, input) });
      else if (id && parts[2] === "resume" && method === "POST") json(res, 201, { session: await gateway.resume(id, input) });
      else if (id && parts[2] === "export" && method === "GET") json(res, 200, gateway.exportSaved(id));
      else json(res, 405, { error: "Method not allowed." });
      return true;
    }
    if (parts[0] !== "sessions" || !parts[1]) return false;
    const id = parts[1];
    const action = parts[2];
    if (!action && method === "GET") json(res, 200, { snapshot: gateway.get(id) });
    else if (!action && method === "DELETE") {
      workflows.cancelSession(id);
      await gateway.close(id);
      json(res, 200, { ok: true });
    } else if (action === "events" && method === "GET") {
      json(res, 200, gateway.eventsAfter(id, consoleEventsAfter(requestUrl.searchParams.get("after"))));
    } else if (action === "messages" && method === "POST") {
      const message = author && input && typeof input === "object" && !("workerId" in input) && (!("mode" in input) || input.mode === "send") ? { ...input, mode: "queue" } : input;
      json(res, 202, { session: await gateway.send(id, message, author) });
    }
    else if (action === "cancel" && method === "POST") json(res, 200, { session: await gateway.cancel(id) });
    else if (action === "configuration" && method === "PATCH") json(res, 200, { session: await gateway.configure(id, input) });
    else if (action === "clear" && method === "POST") json(res, 200, { session: await gateway.clear(id) });
    else if (action === "continue" && method === "POST") json(res, 202, { session: await gateway.continue(id, input, author) });
    else if (action === "harness" && method === "POST") json(res, 200, await gateway.harness(id, input));
    else if (action === "save" && method === "POST") json(res, 200, { session: gateway.save(id) });
    else if (action === "archive" && method === "POST") {
      workflows.cancelSession(id);
      json(res, 200, { session: await gateway.archive(id) });
    }
    else if (action === "delete" && method === "POST") {
      workflows.cancelSession(id);
      json(res, 200, await gateway.delete(id));
    } else if (action === "export" && method === "GET") json(res, 200, gateway.export(id));
    else if (action === "queue" && method === "DELETE") json(res, 200, { session: gateway.removeQueued(id, parts[3]) });
    else if (action === "decisions" && parts[3] && method === "POST") json(res, 200, { session: gateway.resolveDecision(id, parts[3], input) });
    else if (action === "workers") {
      const workerId = parts[3];
      if (!workerId && method === "GET") json(res, 200, { workers: gateway.workers(id) });
      else if (workerId === "stop" && method === "POST") json(res, 200, { session: await gateway.drainWorkers(id) });
      else if (workerId && parts[4] === "export" && method === "GET") json(res, 200, gateway.exportWorker(id, workerId));
      else if (workerId && parts[4] === "stop" && method === "POST") json(res, 200, { worker: await gateway.stopWorker(id, workerId) });
      else if (workerId && parts[4] === "messages" && method === "POST") {
        const body = z.object({ text: z.unknown() }).strict().parse(input);
        json(res, 202, { session: gateway.sendWorker(id, workerId, body.text, author) });
      } else json(res, 405, { error: "Method not allowed." });
    } else json(res, 405, { error: "Method not allowed." });
    return true;
  } catch (error) {
    if (error instanceof z.ZodError) { json(res, 400, { error: "Invalid console request payload." }); return true; }
    if (error instanceof ConsoleGatewayError) { json(res, error.statusCode, { error: error.message }); return true; }
    throw error;
  }
}

type PresentationCursor = {
  timestamp: number;
  id: string;
};

function encodePresentationCursor(cursor: PresentationCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodePresentationCursor(value: string | string[] | undefined): PresentationCursor | undefined {
  const encoded = Array.isArray(value) ? value[0] : value;
  if (!encoded) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      timestamp?: unknown;
      id?: unknown;
    };
    return typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp) && typeof parsed.id === "string"
      ? { timestamp: parsed.timestamp, id: parsed.id }
      : undefined;
  } catch {
    return undefined;
  }
}

function writePresentationSse(
  res: ServerResponse,
  event: PresentationEvent,
  cursor?: PresentationCursor,
): void {
  if (cursor) res.write(`id: ${encodePresentationCursor(cursor)}\n`);
  res.write(`event: presentation\ndata: ${JSON.stringify(event)}\n\n`);
}

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  dbPath: string | undefined,
  controlToken: string,
  engineBearer?: string,
): Promise<boolean> {
  const { osecDB } = await import("@0/db");

  if (isPresentationEventsStreamPath(pathname)) {
    if (req.method !== "GET") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }

    const db = new osecDB(dbPath);
    let sequence = 0;
    let cursor = decodePresentationCursor(req.headers["last-event-id"]);
    const sendPersisted = () => {
      try {
        const events = (cursor
          ? db.listEventsAfter(cursor, 250)
          : (db.listRecentEvents(250) as DashboardRecentEventRow[]).slice().reverse()
        ) as DashboardRecentEventRow[];
        for (const event of events) {
          const nextCursor = { timestamp: event.timestamp, id: event.id };
          writePresentationSse(
            res,
            presentationEventFromDashboardRow(event, ++sequence),
            nextCursor,
          );
          cursor = nextCursor;
        }
      } catch {
        // The next polling pass may succeed after a concurrent DB rotation.
      }
    };

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sendPersisted();
    const poll = setInterval(sendPersisted, 750);
    const unsubscribe = presentationEventBus.subscribe({
      emit(event) {
        // Core scan events are persisted and arrive through the ordered DB poll.
        // Local CLI output has no DB row and remains useful to same-process users.
        if (event.source !== "core") writePresentationSse(res, event);
      },
    });
    req.once("close", () => {
      clearInterval(poll);
      unsubscribe();
      db.close();
    });
    return true;
  }

  const controlPath = parseControlPath(pathname);

  if (controlPath) {
    if (req.method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }

    // Require a per-session token on all state-changing control endpoints.
    // The token is injected into the dashboard HTML at serve time and sent
    // back as a header, preventing CSRF and cross-origin abuse.
    if (!requireControlToken(req, res, controlToken, engineBearer)) {
      return true;
    }

    if (controlPath.action === "recover-stale-workers") {
      const { recoverStaleWorkers } = await import("./orchestrate.js");
      const body = (await readJson(req)) as { staleAfterMs?: number };
      const recovered = recoverStaleWorkers(
        dbPath,
        typeof body.staleAfterMs === "number" ? body.staleAfterMs : 30_000,
      );
      json(res, 200, { ok: true, recovered });
      return true;
    }

    if (controlPath.action === "prune-stopped-workers") {
      const db = new osecDB(dbPath);
      try {
        const deleted = db.deleteWorkersByStatus("stopped");
        json(res, 200, { ok: true, deleted });
      } finally {
        db.close();
      }
      return true;
    }

    if (controlPath.action === "start-daemon") {
      const body = (await readJson(req)) as { label?: string; pollIntervalMs?: number };
      const db = new osecDB(dbPath);
      try {
        const activeWorkers = (db.listWorkers(100) as DBWorkerRow[]).filter((worker) =>
          worker.status !== "stopped" && Date.now() - Date.parse(worker.heartbeatAt) < 20_000,
        );
        if (activeWorkers.length > 0) {
          json(res, 409, { error: "An active daemon is already heartbeating. Stop it before starting another local daemon." });
          return true;
        }
      } finally {
        db.close();
      }

      const started = startManagedDaemon({
        dbPath,
        label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : "control-plane-1",
        pollIntervalMs: typeof body.pollIntervalMs === "number" ? body.pollIntervalMs : 2000,
      });
      json(res, 200, { ok: true, ...started });
      return true;
    }

    if (controlPath.action === "stop-daemon") {
      const stopped = stopDaemonWorkers(osecDB, dbPath);
      json(res, 200, { ok: true, stopped });
      return true;
    }

    if (controlPath.action === "reset-database") {
      const { resetOsecDatabase } = await import("@0/db");
      const { seedVerificationWorkbench } = await import("./db.js");
      const body = (await readJson(req)) as { seed?: string };
      const seed = typeof body.seed === "string" ? body.seed.trim().toLowerCase() : "verification";

      if (!["verification", "empty"].includes(seed)) {
        json(res, 400, { error: `Unsupported seed preset: ${seed}` });
        return true;
      }

      const activeWorkerDb = new osecDB(dbPath);
      try {
        const hasActiveWorker = (activeWorkerDb.listWorkers(100) as DBWorkerRow[]).some((worker) =>
          ["idle", "claiming", "running", "sleeping"].includes(worker.status)
            && Date.now() - Date.parse(worker.heartbeatAt) < 20_000
            && (worker.pid ? isLiveLocalPid(worker.pid) : true),
        );
        if (hasActiveWorker) {
          json(res, 409, { error: "Stop active orchestration daemons before resetting the local database." });
          return true;
        }
      } finally {
        activeWorkerDb.close();
      }

      const path = resetOsecDatabase(dbPath);
      const resetDb = new osecDB(dbPath);
      try {
        const seeded = seed === "verification"
          ? seedVerificationWorkbench(resetDb)
          : { scans: 0, families: 0, workers: 0 };
        json(res, 200, { ok: true, path, seed, ...seeded });
      } finally {
        resetDb.close();
      }
      return true;
    }
  }

  if (pathname === "/api/dashboard") {
      const db = new osecDB(dbPath);
      try {
        const scans = db.listScans(100) as DBScanRow[];
        // Rank current family assessments globally before fetching bounded evidence bodies.
        // Historical verdicts and running roles still determine the same review gates.
        const families = db.listFindingFamiliesByBusinessPriority({ limit: 5000 });
        const groups = families.map(family => {
          const latest = normalizeFinding(family.latest as DBFindingRow);
          return { fingerprint: family.key, latest, count: family.count, scanCount: family.scanCount,
            workflow: buildWorkflowSummary([latest], [], family.activeSessions, family.verdictCounts) };
        });
        const workItems = (db.listWorkItems?.({ limit: 5000 }) ?? []) as DBWorkItemRow[];
        const workers = (db.listWorkers?.(50) ?? []) as DBWorkerRow[];
        const derivedCases = buildCases(scans, groups);
        const persistedCases = (db.listCases?.(200) ?? []) as Array<{
          id: string;
          target: string;
          targetType: string;
          latestScanId?: string | null;
          status: string;
        }>;
        const cases = derivedCases.map((item) => {
          const persisted = persistedCases.find((row) => row.id === item.id);
          return {
            ...item,
            targetType: (persisted?.targetType as typeof item.targetType | undefined) ?? item.targetType,
            latestScanId: persisted?.latestScanId ?? item.latestScanId,
          };
        });
        const casesById = new Map(cases.map((item) => [item.id, item] as const));
        const workItemsById = new Map(workItems.map((item) => [item.id, item] as const));
        json(res, 200, {
          scans: scans.map(summarizeScan),
          cases,
          groups,
          workers: workers.map((worker) => summarizeWorker(worker, workItemsById, casesById)),
          queue: summarizeQueue(workItems, workers),
        });
      } finally {
        db.close();
    }
    return true;
  }

  if (pathname === "/api/scans") {
    const db = new osecDB(dbPath);
    try {
      const scans = db.listScans(100) as DBScanRow[];
      json(res, 200, { scans: scans.map(summarizeScan) });
    } finally {
      db.close();
    }
    return true;
  }

  if (parseRecentEventsPath(pathname)) {
    const url = new URL(req.url ?? pathname, "http://localhost");
    const rawLimit = Number(url.searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 20;
    const db = new osecDB(dbPath);
    try {
      const events = (db.listRecentEvents(limit) as DashboardRecentEventRow[])
        .map((event, index) => {
          const payload = parsePayload(event.payload);
          const presentation = presentationEventFromDashboardRow(event, index + 1);
          return {
            id: event.id,
            scanId: event.scanId,
            scanTarget: event.scanTarget,
            stage: event.stage,
            eventType: event.eventType,
            findingId: event.findingId ?? null,
            findingFingerprint: event.findingFingerprint ?? null,
            agentRole: event.agentRole ?? null,
            summary: summarizeRecentEvent({
              stage: event.stage,
              eventType: event.eventType,
              payload,
            }),
            payload,
            timestamp: event.timestamp,
            presentation,
          };
        });

      json(res, 200, { events });
    } finally {
      db.close();
    }
    return true;
  }

  const scanPath = parseScanPath(pathname);
  if (scanPath) {
    const db = new osecDB(dbPath);
    try {
      const scan = db.getScan(scanPath.scanId) as DBScanRow | undefined;
      if (!scan) {
        json(res, 404, { error: "Scan not found" });
        return true;
      }

      if (scanPath.suffix === "events") {
        const events = (db.getEvents(scanPath.scanId) as DBEventRow[]).map((event) => ({
          ...event,
          payload: parsePayload(event.payload),
        }));
        json(res, 200, { scan: summarizeScan(scan), events });
        return true;
      }

      if (scanPath.suffix === "findings") {
        const findings = (db.getFindings(scanPath.scanId) as DBFindingRow[]).map(normalizeFinding);
        const verdicts = db.listVerdicts(findings.map((finding) => finding.id)) as DBVerdictRow[];
        const sessions = db.listSessions({
          scanIds: [scanPath.scanId],
          status: "running",
        }) as DBSessionRow[];
        json(res, 200, {
          scan: summarizeScan(scan),
          findings,
          groups: groupFindings(
            findings,
            groupByKey(verdicts, "findingId"),
            groupByKey(sessions, "scanId"),
          ),
        });
        return true;
      }

      json(res, 200, { scan: summarizeScan(scan) });
    } finally {
      db.close();
    }
    return true;
  }

  const familyPath = parseFindingFamilyPath(pathname);
  if (familyPath) {
    const db = new osecDB(dbPath);
    try {
      if (req.method === "POST" && familyPath.action === "triage") {
        if (!requireControlToken(req, res, controlToken, engineBearer)) {
          return true;
        }
        const body = (await readJson(req)) as { triageStatus?: string; triageNote?: string };
        db.updateFindingTriageByFingerprint(
          familyPath.fingerprint,
          normalizeTriageStatus(body.triageStatus),
          typeof body.triageNote === "string" ? body.triageNote : undefined,
        );
        json(res, 200, { ok: true });
        return true;
      }

      if (req.method === "POST" && familyPath.action === "workflow") {
        if (!requireControlToken(req, res, controlToken, engineBearer)) {
          return true;
        }
        const body = (await readJson(req)) as { workflowStatus?: string; workflowAssignee?: string };
        db.updateFindingWorkflowByFingerprint(
          familyPath.fingerprint,
          normalizeWorkflowStatus(body.workflowStatus),
          typeof body.workflowAssignee === "string" ? body.workflowAssignee.trim() : null,
        );
        json(res, 200, { ok: true });
        return true;
      }

      const rows = (db.getRelatedFindings(familyPath.fingerprint) as DBFindingRow[]).map(normalizeFinding);
      if (rows.length === 0) {
        json(res, 404, { error: "Not found" });
        return true;
      }

      const verdicts = db.listVerdicts(rows.map((row) => row.id)) as DBVerdictRow[];
      const sessions = db.listSessions({
        scanIds: [...new Set(rows.map((row) => row.scanId))],
        status: "running",
      }) as DBSessionRow[];
      const scans = [...new Map(
        rows
          .map((row) => db.getScan(row.scanId) as DBScanRow | undefined)
          .filter(Boolean)
          .map((scan) => [scan!.id, scan!] as const),
      ).values()];
      const allEvents = scans.flatMap((scan) => (db.getEvents(scan.id) as DBEventRow[]));
      const workflow = buildWorkflowSummary(
        rows,
        verdicts,
        sessions,
      );
      const familyCase = buildCases(
        scans,
        [{
          fingerprint: familyPath.fingerprint,
          latest: rows[0],
          count: rows.length,
          scanCount: new Set(rows.map((row) => row.scanId)).size,
          workflow,
        }],
      )[0] ?? null;
      const persistedWorkItems = (db.listWorkItems?.({ findingFingerprint: familyPath.fingerprint, limit: 50 }) ?? []) as Array<{
        id: string;
        kind: string;
        title: string;
        owner?: string | null;
        status: string;
        summary?: string | null;
      }>;
      const persistedArtifacts = (db.listArtifacts?.({ findingFingerprint: familyPath.fingerprint, limit: 100 }) ?? []) as Array<{
        id: string;
        kind: string;
        label: string;
        content?: string | null;
      }>;
      const derivedWorkItems = buildWorkItems({
        fingerprint: familyPath.fingerprint,
        workflow,
        rows,
        verdicts,
      });
      const derivedArtifacts = buildArtifacts({
        fingerprint: familyPath.fingerprint,
        latest: rows[0],
        verdicts,
        sessions,
        events: allEvents,
      });

      json(res, 200, {
        consoleCommand: buildFindingConsoleCommand(rows[0]!, dbPath),
        fingerprint: familyPath.fingerprint,
        case: familyCase,
        latest: rows[0],
        rows,
        workflow,
        workItems: persistedWorkItems.length > 0
          ? persistedWorkItems.map((item) => ({
              id: item.id,
              kind: item.kind,
              title: item.title,
              owner: item.owner ?? null,
              status: item.status,
              summary: item.summary ?? "",
            }))
          : derivedWorkItems,
        artifacts: persistedArtifacts.length > 0
          ? persistedArtifacts.map((artifact) => ({
              id: artifact.id,
              kind: artifact.kind,
              label: artifact.label,
              summary: artifact.content ? `${artifact.content.length} chars captured` : "Persisted artifact",
            }))
          : derivedArtifacts,
      });
    } finally {
      db.close();
    }
    return true;
  }

  return false;
}

function isLoopbackDashboardHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

export function registerDashboardCommand(program: Command): void {
  program
    .command("dashboard")
    .alias("web")
    .description("Run the local browser console and operations workspace")
    .option("--db-path <path>", "Path to SQLite database")
    .option("--port <port>", "Port to bind; 0 chooses a free loopback port", "48123")
    .option("--host <host>", "Loopback host to bind (127.0.0.0/8 or ::1)", "127.0.0.1")
    .option("--asset-dir <path>", "Path to built dashboard assets")
    .option("--dev-url <url>", "Loopback Vite server for authenticated frontend hot reload")
    .option("--backends-config <path>", "Trusted backend connection registry JSON (default ~/.0/backends.json)")
    .option("--team-config <path>", "Enable workspace accounts, roles, and shared conversation controls")
    .option("--engine-token-env <name>", "Environment variable holding the engine bearer credential (32–4096 characters)")
    .option("--engine-workspace <path>", "Engine-owned authorized workspace for persistent workflow calls")
    .option("--engine-scope <path>", "Engine-owned scope JSON for persistent live-target workflows")
    .option("--engine-target <target>", "Restrict persistent workflow calls to this target")
    .option("--engine-allow-apply", "Admit explicitly approved patch application in persistent workflow calls")
    .option("--engine-time-cap <ms>", "Server workflow deadline ceiling (default 600000 ms)")
    .option("--engine-cost-cap <usd>", "Server workflow estimated cost ceiling (default $5)")
    .option("--ready-json", "Emit the bound dashboard URL as machine-readable JSON")
    .option("--no-open", "Do not auto-open a browser")
    .action(async (opts: DashboardOptions) => {
      const host = opts.host?.trim() || "127.0.0.1";
      const port = parseInt(opts.port ?? "48123", 10);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port: ${opts.port ?? "48123"}`);
      }
      if (!isLoopbackDashboardHost(host)) {
        throw new Error(
          "Dashboard only binds loopback addresses (127.0.0.0/8 or ::1). Use an SSH tunnel or an authenticated reverse proxy bound to local loopback for remote access.",
        );
      }
      let origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
      let devUrl: URL | undefined;
      if (opts.devUrl) {
        devUrl = new URL(opts.devUrl);
        const devHost = devUrl.hostname.replace(/^\[|\]$/g, "");
        if (devUrl.protocol !== "http:" || devUrl.username || devUrl.password || !isLoopbackDashboardHost(devHost)) {
          throw new Error("The frontend development server must use an HTTP loopback URL without credentials.");
        }
      }


      if (port !== 0 && !opts.dbPath && !opts.assetDir && !opts.devUrl && !opts.backendsConfig && !opts.engineTokenEnv && !opts.engineWorkspace && !opts.engineScope && !opts.engineTarget && !opts.engineAllowApply && !opts.engineTimeCap && !opts.engineCostCap && await findDashboardInstance(origin)) {
        console.log(chalk.gray(`  0 web is already running: ${origin}`));
        if (opts.readyJson) console.log(`ZERO_DASHBOARD_READY ${JSON.stringify({ url: origin })}`);
        if (opts.open !== false) openBrowser(`${origin}/console`);
        return;
      }

      const engineBearer = backendBearerFromEnv(opts.engineTokenEnv);
      const explicitTeamConfig = opts.teamConfig ?? process.env.ZERO_TEAM_CONFIG;
      const teamConfigPath = findTeamConfigPath({ workspacePath: opts.engineWorkspace ?? process.cwd(), explicitConfigPath: explicitTeamConfig });
      if (!engineBearer && !teamConfigPath && [opts.engineWorkspace, opts.engineScope, opts.engineTarget, opts.engineAllowApply, opts.engineTimeCap, opts.engineCostCap].some(value => value !== undefined && value !== false)) throw new Error("Engine admission options require --engine-token-env or --team-config.");
      const timeCapMs = opts.engineTimeCap === undefined ? 600_000 : Number(opts.engineTimeCap);
      const costCapUsd = opts.engineCostCap === undefined ? 5 : Number(opts.engineCostCap);
      if (!Number.isInteger(timeCapMs) || timeCapMs < 1 || timeCapMs > 86_400_000 || !Number.isFinite(costCapUsd) || costCapUsd <= 0 || costCapUsd > 1000) throw new Error("Engine limits must be positive, with time at most 86400000 ms and cost at most $1000.");
      const controlToken = randomUUID();
      let teamAuth = new TeamAuth({ configPath: teamConfigPath, origin });
      let teamDirectory = teamAuth.enabled ? join(homeStateDir(), "teams", createHash("sha256").update(teamAuth.workspaceId!).digest("hex")) : undefined;
      if (teamDirectory) { mkdirSync(teamDirectory, { recursive: true, mode: 0o700 }); if (!explicitTeamConfig) opts.dbPath = join(teamDirectory, "data.db"); else opts.dbPath ??= join(teamDirectory, "data.db"); }
      let collaboration = teamAuth.enabled ? new CollaborationService({ workspaceId: teamAuth.workspaceId!, stateDir: join(teamDirectory!, "collaboration"), resolveSession: sessionId => teamAuth.resolveSessionId(sessionId) }) : undefined;
      // Never recover another live host's database while opening a second UI.
      assertLocalEngineAvailable(opts.dbPath);
      const capabilities = ["sessions", "workflows", "schedules", "approvals", "events", "workspaces", "artifacts", "model-connections", "operator-services", "process-controls", "learning", "workflow-engine"];
      let localHandshake = createBackendHandshake(opts.dbPath, capabilities);
      let backends = new BackendConnectionRegistry({ configPath: opts.backendsConfig, localHandshake });
      let engine: WorkflowEngineService | undefined;
      let startupGateway: ConsoleGateway | undefined;
      let startupOperator: WebOperatorServices | undefined;
      let startupWorkflows: WebWorkflowService | undefined;
      let startupTriggers: WorkflowTriggerService | undefined;
      let startupGitHub: GitHubPublicationAuth | undefined;
      let startupAssetCleanup: (() => void) | undefined;
      try {
        const { path: assetDir, cleanup: cleanupAssetDir } = resolveDashboardAssetDir(opts.assetDir);
        startupAssetCleanup = cleanupAssetDir;
        const buildServices = (auth: TeamAuth, dbPath = opts.dbPath, stateDir = teamDirectory) => createWorkspaceServices({ auth, dbPath, stateDir, workspace: opts.engineWorkspace, scopePath: opts.engineScope, target: opts.engineTarget, allowApply: opts.engineAllowApply, controlToken, engineBearer, timeCapMs, costCapUsd });
        let services = await buildServices(teamAuth);
        let { skills, gateway: consoleGateway, engagements, operator, workflows, triggers, github } = services;
        engine = services.engine;
        startupGateway = consoleGateway; startupOperator = operator; startupWorkflows = workflows; startupTriggers = triggers; startupGitHub = github;
        let findingsAccess = new FindingsAccessTokenStore({ workspaceId: teamAuth.workspaceId ?? localHandshake.engineId, stateDir: join(teamDirectory ?? homeStateDir(), "findings-api-access") });
        let findingsRead = new FindingsReadApi({ workspaceId: teamAuth.workspaceId ?? localHandshake.engineId, dbPath: opts.dbPath });
        const activeResponses = new Set<ServerResponse>();
        let setupResponse: ServerResponse | undefined;
        const setup = new TeamSetupService({ workspacePath: opts.engineWorkspace ?? process.cwd(), configPath: teamConfigPath, origin: () => origin, currentAuth: () => teamAuth,
          activate: async prepared => {
            if (consoleGateway.hasActiveTurns() || workflows.hasActiveWork()) throw new TeamAuthError("Finish active work before creating a team workspace.", 409);
            const next = await buildServices(prepared.auth, prepared.dbPath, prepared.stateDir);
            let nextBackends: BackendConnectionRegistry | undefined;
            let nextUnregister: (() => void) | undefined;
            try {
              const nextHandshake = createBackendHandshake(prepared.dbPath, capabilities);
              nextBackends = new BackendConnectionRegistry({ configPath: opts.backendsConfig, localHandshake: nextHandshake });
              const nextAccess = new FindingsAccessTokenStore({ workspaceId: prepared.workspaceId, stateDir: join(prepared.stateDir, "findings-api-access") });
              const nextRead = new FindingsReadApi({ workspaceId: prepared.workspaceId, dbPath: prepared.dbPath });
              const nextCollaboration = new CollaborationService({ workspaceId: prepared.workspaceId, stateDir: join(prepared.stateDir, "collaboration"), resolveSession: sessionId => prepared.auth.resolveSessionId(sessionId) });
              nextUnregister = registerLocalEngine({ url: origin, token: controlToken, engineId: nextHandshake.engineId, serverInstanceId: nextHandshake.serverInstanceId!, pid: process.pid, workspace: opts.engineWorkspace ?? process.cwd() }, prepared.dbPath);
              if (consoleGateway.hasActiveTurns() || workflows.hasActiveWork()) throw new TeamAuthError("Finish active work before creating a team workspace.", 409);
              await services.dispose();
              for (const response of activeResponses) if (response !== setupResponse) response.end();
              backends.dispose(); unregisterLocalEngine?.();
              services = next; teamAuth = prepared.auth; teamDirectory = prepared.stateDir; opts.dbPath = prepared.dbPath; collaboration = nextCollaboration; localHandshake = nextHandshake; backends = nextBackends; unregisterLocalEngine = nextUnregister;
              ({ skills, gateway: consoleGateway, engagements, operator, workflows, triggers, github } = next); engine = next.engine; findingsAccess = nextAccess; findingsRead = nextRead;
              startupGateway = consoleGateway; startupOperator = operator; startupWorkflows = workflows; startupTriggers = triggers; startupGitHub = github;
            } catch (cause) { nextBackends?.dispose(); nextUnregister?.(); await next.dispose().catch(() => {}); throw cause; }
          },
        });

        const server = createServer(async (req, res) => {
          activeResponses.add(res); const releaseResponse = () => activeResponses.delete(res); res.once("close", releaseResponse); res.once("finish", releaseResponse);
          try { authorizeWebRequest(req, origin); }
          catch (error) {
            json(res, error instanceof WebRequestError ? error.statusCode : 403, { error: error instanceof Error ? error.message : "Invalid request origin." });
            return;
          }
          let requestUrl = new URL(req.url ?? "/", origin);
          const requestId = BackendRequestIdSchema.safeParse(req.headers["x-0-request-id"]);
          res.setHeader("X-0-Request-ID", requestId.success ? requestId.data : randomUUID());

          try {
            if (requestUrl.pathname.startsWith("/api/")) {
              const findingsCredential = findingsAccess.authenticate(req, requestUrl);
              if (requestUrl.pathname === "/api/v1/findings" || requestUrl.pathname.startsWith("/api/v1/findings/")) {
                if (setup.status().pending) throw new WebRequestError("Workspace setup is in progress. Try again shortly.", 503);
                if (!findingsCredential) throw new FindingsAccessError("A findings API key is required in the Authorization header.", 401);
                const reply = handleFindingsReadRequest(req, requestUrl, findingsRead);
                if (!reply) throw new FindingsAccessError("Findings API route was not found.", 404);
                json(res, reply.status, reply.data); return;
              }
              const ssoNavigation = requestUrl.pathname === "/api/team/auth/sso" || requestUrl.pathname === "/api/team/auth/callback";
              if (!(ssoNavigation && req.method === "GET") && !requireControlToken(req, res, controlToken, engineBearer)) return;
              if (requestUrl.pathname === "/api/team/setup" || requestUrl.pathname === "/api/team/users") {
                if (requestUrl.pathname === "/api/team/setup" && req.method === "POST" && !setup.status().pending) setupResponse = res;
                try {
                  const reply = await handleTeamSetupRequest(req, requestUrl, setup, () => readJson(req));
                  if (reply) { for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value); json(res, reply.status, reply.data); return; }
                } finally { if (setupResponse === res) setupResponse = undefined; }
              }
              if (setup.status().pending && requestUrl.pathname !== "/api/team/session") throw new WebRequestError("Workspace setup is in progress. Try again shortly.", 503);
              if (handleTeamPresenceStream(req, res, requestUrl, teamAuth, collaboration)) return;
              const teamReply = await handleTeamRequest(req, requestUrl, teamAuth, collaboration, consoleGateway, () => readJson(req), async (kind, id) => {
                if (kind === "report") { engagements.get(id); return; }
                const definition = await workflows.handle(`/api/console/workflow-definitions/${encodeURIComponent(id)}`, "GET", undefined, new URLSearchParams());
                if (!definition || definition.status !== 200) throw new WebRequestError("Workflow was not found.", 404);
              });
              if (teamReply) {
                for (const [name, value] of Object.entries(teamReply.headers ?? {})) res.setHeader(name, value);
                if (teamReply.redirect) { res.writeHead(teamReply.status, { Location: teamReply.redirect, "Cache-Control": "no-store" }); res.end(); }
                else json(res, teamReply.status, teamReply.data);
                return;
              }
              const bearer = req.headers.authorization;
              const engineRequest = Boolean(engineBearer && typeof bearer === "string" && bearer.startsWith("Bearer ") && Buffer.byteLength(bearer.slice(7)) === Buffer.byteLength(engineBearer) && timingSafeEqual(Buffer.from(bearer.slice(7)), Buffer.from(engineBearer)));
              if (!engineRequest) authorizeTeamApi(teamAuth, req, requestUrl.pathname);
              res.setHeader("X-0-Engine-ID", localHandshake.engineId);
              const expectedEngineId = req.headers["x-0-expected-engine-id"];
              if (expectedEngineId !== undefined && expectedEngineId !== localHandshake.engineId) throw new WebRequestError("Request belongs to a different engine identity.", 409);
              const findingsAccessReply = await handleFindingsAccessTokenRequest(req, requestUrl, teamAuth, findingsAccess, () => readJson(req));
              if (findingsAccessReply) { json(res, findingsAccessReply.status, findingsAccessReply.data); return; }
              const backendRoute = await handleBackendConnectionRequest(req, res, requestUrl, backends);
              if (backendRoute.handled) return;
              if (backendRoute.localPath) requestUrl = new URL(backendRoute.localPath, origin);
              const skillsRoute = requestUrl.pathname.match(/^\/api\/skills(?:\/(.*))?$/);
              if (skillsRoute) {
                const member = teamAuth.resolveSession(req);
                const access = { allowHostEdits: !teamAuth.enabled || engineRequest || member?.role === "owner", canWrite: !teamAuth.enabled || engineRequest || member?.role !== "viewer" };
                const path = skillsRoute[1] ?? "";
                let decodedPath: string;
                try { decodedPath = decodeURIComponent(path); } catch { throw new WebRequestError("Invalid skill identifier.", 400); }
                const method = req.method ?? "GET";
                if (!path && method === "GET") json(res, 200, skills.list(access));
                else if (!path && method === "POST") json(res, 201, { skill: skills.create(await readJson(req)) });
                else if (path === "import" && method === "POST") json(res, 201, { skill: skills.import(await readJson(req, 12 * 1024 * 1024)) });
                else if (path === "mounts" && method === "POST") json(res, 201, { mount: skills.mount(await readJson(req)) });
                else if (path.startsWith("mounts/") && method === "DELETE") { skills.unmount(decodedPath.slice(7)); json(res, 200, { ok: true }); }
                else if (path.endsWith("/copy") && method === "POST") json(res, 201, { skill: skills.copy(decodedPath.slice(0, -5), await readJson(req), access) });
                else if (path.endsWith("/export") && method === "GET") {
                  const id = decodedPath.slice(0, -7); const bundle = skills.export(id);
                  res.setHeader("Content-Disposition", `attachment; filename="${bundle.name}.skill.json"`); json(res, 200, bundle);
                }
                else if (path && method === "GET") json(res, 200, { skill: skills.get(decodedPath, access) });
                else if (path && method === "PUT") json(res, 200, { skill: skills.update(decodedPath, await readJson(req), access) });
                else throw new WebRequestError("Method not allowed.", 405);
                return;
              }
              const engagementRoute = requestUrl.pathname.match(/^\/api\/engagements(?:\/([^/]+)(?:\/(report))?)?$/);
              if (engagementRoute) {
                const member = teamAuth.resolveSession(req);
                const engagementActor = member ? { userId: member.userId, displayName: member.displayName } : undefined;
                const id = engagementRoute[1] ? decodeURIComponent(engagementRoute[1]) : undefined;
                if (engagementRoute[2]) {
                  if (req.method !== "GET") throw new WebRequestError("Use GET to read an engagement report.", 405);
                  const format = requestUrl.searchParams.get("format") ?? "json";
                  if (format !== "json" && format !== "markdown") throw new WebRequestError("Use json or markdown for an engagement report.", 400);
                  const report = engagements.report(id!);
                  if (format === "json") { res.setHeader("Content-Disposition", `attachment; filename="engagement-${id}.json"`); json(res, 200, report); }
                  else { res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="engagement-${id}.md"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(engagementMarkdown(report)); }
                } else if (req.method === "GET") json(res, 200, id ? { engagement: engagements.get(id) } : { engagements: engagements.list() });
                else if (req.method === "POST" && !id) {
                  const engagement = engagements.create(await readJson(req), engagementActor);
                  collaboration?.notifyChanged("report", engagement.id);
                  json(res, 201, { engagement });
                }
                else if (req.method === "PATCH" && id) {
                  const engagement = engagements.update(id, await readJson(req), engagementActor);
                  collaboration?.notifyChanged("report", engagement.id);
                  json(res, 200, { engagement });
                }
                else throw new WebRequestError("Method not allowed.", 405);
                return;
              }
              if (requestUrl.pathname === "/api/control/launch-run") {
                if (req.method !== "POST") throw new WebRequestError("Use POST to launch a run.", 405);
                const body = z.object({ target: z.string().trim().min(1).max(4096), depth: z.enum(["quick", "default", "deep"]).optional(), runtime: z.enum(["api", "auto"]).optional(), mode: z.enum(["deep", "web"]).optional(), ensureDaemon: z.boolean().optional() }).strict().parse(await readJson(req));
                if (body.runtime !== undefined || body.mode !== undefined) throw new WebRequestError("The selected engine owns its model and assessment execution. Submit a target and depth, or use a workflow for specialized execution.", 400);
                if (body.ensureDaemon) throw new WebRequestError("Engine runs do not require a separate orchestration daemon. Configure a workflow schedule for recurring work.", 400);
                const session = await engine!.invoke("create_session", { config: { target: body.target, title: `Assessment: ${body.target}` } }) as { id: string };
                const execution = await engine!.invoke("start_assessment", { sessionId: session.id, target: body.target, plan: { goal: "unknown-vulnerabilities", depth: body.depth ?? "default", runCount: 1, executionMode: "sequential", timeCapMs, costCapUsd } }) as { id: string; jobId?: string };
                json(res, 202, { ok: true, engineOwned: true, sessionId: session.id, runId: execution.id, jobId: execution.jobId });
                return;
              }
              if (requestUrl.pathname === "/api/workflow-engine/call") {
                if (!engine) throw new WebRequestError("This engine does not admit persistent workflow calls.", 403);
                if (req.method !== "POST") throw new WebRequestError("Method not allowed.", 405);
                const input = z.object({ name: z.string().min(1).max(128), args: z.record(z.unknown()) }).strict().parse(await readJson(req));
                if (!engineRequest && typeof input.args.sessionId === "string") assertTeamConsoleMutation(req, input.args.sessionId, teamAuth, collaboration, consoleGateway);
                json(res, 200, await engine.invoke(input.name, input.args));
                return;
              }
              const resumeScan = requestUrl.pathname.match(/^\/api\/scans\/([^/]+)\/resume$/);
              if (resumeScan) {
                if (req.method !== "POST") throw new WebRequestError("Use POST to resume a scan.", 405);
                const request = ScanResumeRequestSchema.parse(await readJson(req));
                const result = await workflows.resumeScan(decodeURIComponent(resumeScan[1]!), { ...request, timeCapMs: Math.min(request.timeCapMs ?? timeCapMs, timeCapMs), costCapUsd: Math.min(request.costCapUsd ?? costCapUsd, costCapUsd) });
                json(res, result.status, result.data);
                return;
              }
              if (/^\/api\/findings\/[^/]+\/impact-assessment$/.test(requestUrl.pathname)) {
                const input = req.method === "POST" || req.method === "DELETE" ? await readJson(req) : undefined;
                const result = handleFindingImpactRequest(requestUrl.pathname, req.method ?? "GET", input, { dbPath: opts.dbPath });
                if (result) { json(res, result.status, result.data); return; }
              }
              const exportScan = requestUrl.pathname.match(/^\/api\/scans\/([^/]+)\/export$/);
              if (exportScan || requestUrl.pathname === "/api/findings/export") {
                if (req.method !== "GET") throw new WebRequestError("Use GET to export a report.", 405);
                const requestedFormat = requestUrl.searchParams.get("format") ?? "json";
                const format = requestedFormat === "md" ? "markdown" : requestedFormat;
                if (!isReportExportFormat(format)) throw new WebRequestError("Unsupported report export format.", 400);
                const report = exportScan
                  ? retainedScanSnapshot(decodeURIComponent(exportScan[1]!), opts.dbPath, workflows.retainedScanReport(decodeURIComponent(exportScan[1]!)))
                  : retainedFindingSnapshot((requestUrl.searchParams.get("ids") ?? "").split(",").filter(Boolean), opts.dbPath);
                const artifact = await exportReport(report, format, exportScan ? `0-scan-${decodeURIComponent(exportScan[1]!)}` : "0-findings");
                res.writeHead(200, { "Content-Type": artifact.contentType, "Content-Disposition": `attachment; filename="${artifact.filename}"`, "Content-Length": artifact.body.byteLength, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
                res.end(artifact.body);
                return;
              }
              const consoleHandled = await handleWebConsoleApiRequest(req, res, requestUrl, consoleGateway, operator, workflows, triggers, github, engineRequest ? undefined : { auth: teamAuth, collaboration });
              if (consoleHandled) return;
              const handled = await handleApiRequest(req, res, requestUrl.pathname, opts.dbPath, controlToken, engineBearer);
              if (!handled) json(res, 404, { error: "Not found" });
              return;
            }

            if (devUrl) {
              if (req.method !== "GET" && req.method !== "HEAD") throw new WebRequestError("Asset method not allowed.", 405);
              const assetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, devUrl);
              const response = await fetch(assetUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
              const contentType = response.headers.get("content-type") ?? "application/octet-stream";
              const data = Buffer.from(await response.arrayBuffer());
              if (data.length > 16_000_000) throw new WebRequestError("Development asset is too large.", 413);
              const body = contentType.includes("text/html")
                ? data.toString("utf8").replace("</head>", `<meta name="0-control-token" content="${controlToken}"></head>`)
                : data;
              res.writeHead(response.status, { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
              res.end(req.method === "HEAD" ? undefined : body);
              return;
            }
            const explicitAsset = resolveAssetPath(assetDir, requestUrl.pathname);
            if (explicitAsset) {
              sendFile(res, explicitAsset, controlToken);
              return;
            }

            if (extname(requestUrl.pathname)) {
              json(res, 404, { error: "Asset not found" });
              return;
            }

            // Inject the control token into HTML so the dashboard JS can read it.
            sendFile(res, join(assetDir, "index.html"), controlToken);
          } catch (err) {
            json(res, errorStatusCode(err), { error: err instanceof Error ? err.message : "Web application request failed." });
          }
        });
        let dashboardAssetsCleaned = false;
        let unregisterLocalEngine: (() => void) | undefined;
        const cleanupDashboardAssets = () => {
          if (dashboardAssetsCleaned) return;
          dashboardAssetsCleaned = true;
          unregisterLocalEngine?.();
          cleanupAssetDir?.();
        };
        server.once("close", cleanupDashboardAssets);

        let retriedPort = false;
        server.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "EADDRINUSE" && port !== 0 && !retriedPort) {
            retriedPort = true;
            console.log(chalk.gray(`  Port ${port} is in use; opening 0 web on a free port.`));
            server.listen(0, host, onListening);
            return;
          }
          console.error(`Unable to start 0 web: ${error.message}`);
          cleanupDashboardAssets();
          process.exit(1);
        });
        const onListening = () => {
          const address = server.address();
          if (address && typeof address !== "string") {
            origin = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
          }
          const url = origin;
          try {
            unregisterLocalEngine = registerLocalEngine({ url, token: controlToken, engineId: localHandshake.engineId, serverInstanceId: localHandshake.serverInstanceId!, pid: process.pid, workspace: opts.engineWorkspace ?? process.cwd() }, opts.dbPath);
          } catch (error) {
            console.error(error instanceof Error ? error.message : "Unable to register the local engine.");
            void Promise.resolve().then(shutdown);
            return;
          }
          console.log(chalk.red.bold("  ◆ 0") + chalk.gray(" dashboard"));
          console.log(chalk.gray(`  ${url}`));
          if (opts.readyJson) console.log(`ZERO_DASHBOARD_READY ${JSON.stringify({ url })}`);
          console.log(chalk.gray("  Ctrl+C to stop"));
          if (opts.open !== false) openBrowser(`${url}/console`);
        };
        server.listen(port, host, onListening);

        let shuttingDown = false;
        const shutdown = () => {
          if (shuttingDown) return;
          shuttingDown = true;
          backends.dispose();
          void Promise.resolve(engine?.dispose()).then(() => triggers.dispose()).then(() => consoleGateway.closeAll()).then(() => workflows.dispose()).finally(() => {
            operator.dispose();
            github.dispose();
            server.close(() => {
              cleanupDashboardAssets();
              process.exit(0);
            });
          });
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      } catch (error) {
        backends.dispose();
        await startupTriggers?.dispose().catch(() => {});
        await startupGateway?.closeAll().catch(() => {});
        await startupWorkflows?.dispose().catch(() => {});
        startupOperator?.dispose();
        startupGitHub?.dispose();
        await engine?.dispose().catch(() => {});
        startupAssetCleanup?.();
        throw error;
      }
    });
}

type FindingWorkflowStatus =
  | "backlog"
  | "todo"
  | "agent_review"
  | "in_progress"
  | "human_review"
  | "blocked"
  | "done"
  | "cancelled";
