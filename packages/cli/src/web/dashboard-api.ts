// Dashboard HTTP API route handlers (console, scans, findings, control, events).
import { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import { type PresentationEvent } from "@0/engine/shared";
import { presentationEventBus } from "../presentation/event-bus.js";
import { buildFindingConsoleCommand } from "../finding-handoff.js";
import { workbenchStatus } from "../commands/workbench.js";
import { ConsoleGateway, ConsoleGatewayError } from "./console-gateway.js";
import { WebOperatorServices } from "./operator-services.js";
import { handleInstructionsRequest } from "./operator-instructions.js";
import { handleWorkspaceHostRequest } from "./workspace-host-routes.js";
import { audit, auditActor, auditConsoleRequest, type AuditCaller, auditDatabaseReset, handleAuditLogRequest } from "./audit.js";
import { WebWorkflowService } from "./workflows.js";
import type { WebSentinelService } from "./sentinels.js";
import { GitHubPublicationAuth, parseAuthMode } from "./github-auth.js";
import { GitHubConnector } from "./github-connector.js";
import { handleConnectorRequest } from "./connector-routes.js";
import { handleWebhookConsoleRequest, type WebhookConsoleContext } from "./github-webhook.js";
import { RepositoryCatalog, handleRepositoriesRequest } from "./repositories.js";
import { TeamAuth, getSessionId } from "./team-auth.js";
import { CollaborationService } from "./collaboration.js";
import { assertTeamConsoleMutation } from "./team-web.js";
import { MAX_SNAPSHOT_WINDOW, MAX_EVENTS_WAIT_SECONDS, parseSnapshotWindow, parseMessagePage, summarizeConsoleWorker } from "./console-snapshot-window.js";
import { openSharedDb, evictSharedDb } from "./shared-db.js";
import { findingsServiceFor } from "./findings-service.js";
import { handleFindingFamilyRequest } from "./finding-family-routes.js";
import { invalidateReadCache, readThrough } from "./read-cache.js";
import { handleSelfEditRequest } from "./self-edit-routes.js";
import { SkillsCatalogService, handleSkillsCatalogRequest } from "./skills-catalog.js";
import { createExtensionService } from "@0/engine";
import { handleExtensionRequest } from "./extension-routes.js";
import type { SkillsStore } from "./skills.js";
import { WebRequestError, json, text, readJson, readJsonObject, requireControlToken } from "./dashboard-http.js";
import { type DBFindingRow, type DBScanRow, type DBEventRow, type DashboardRecentEventRow, type DBVerdictRow, type DBSessionRow, type DBWorkerRow, type DBWorkItemRow, normalizeTriageStatus, normalizeWorkflowStatus, parsePayload, presentationEventFromDashboardRow, summarizeRecentEvent, summarizeScan, summarizeWorker, summarizeQueue, normalizeFinding, buildWorkflowSummary, groupFindings, buildCases, buildWorkItems, buildArtifacts, groupByKey } from "./dashboard-summaries.js";

export function parseScanPath(pathname: string): { scanId: string; suffix?: "events" | "findings" } | null {
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

export { workflowTransitionRejection } from "./workflow-transition.js";

function parseFindingFamilyPath(pathname: string): { fingerprint: string; action?: "triage" | "workflow" } | null {
  const match = pathname.match(/^\/api\/finding-family\/([^/]+)(?:\/(triage|workflow))?$/);
  if (!match) return null;
  return {
    fingerprint: decodeURIComponent(match[1]),
    action: match[2] as "triage" | "workflow" | undefined,
  };
}

export function parseControlPath(pathname: string): { action: "reset-database" } | null {
  return pathname === "/api/control/reset-database" ? { action: "reset-database" } : null;
}

function consoleEventsAfter(value: string | null): number {
  if (value === null || value === "") return 0;
  const after = Number(value);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new ConsoleGatewayError("Event cursor must be a non-negative integer.", 400);
  }
  return after;
}

/** Map window/paging parse errors to a 400 instead of a 500. */
function badRequest<T>(parse: () => T): T {
  try { return parse(); } catch (error) { if (error instanceof RangeError) throw new ConsoleGatewayError(error.message, 400); throw error; }
}

function parseEventsWait(value: string | null): number {
  if (value === null || value === "") return 0;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_EVENTS_WAIT_SECONDS) throw new RangeError(`wait must be between 0 and ${MAX_EVENTS_WAIT_SECONDS} seconds.`);
  return seconds;
}

const repositoryCatalogs = new WeakMap<GitHubPublicationAuth, RepositoryCatalog>();
const repositoryCatalogFor = (github: GitHubPublicationAuth): RepositoryCatalog => {
  let catalog = repositoryCatalogs.get(github);
  if (!catalog) { catalog = new RepositoryCatalog({ status: () => github.status() }); repositoryCatalogs.set(github, catalog); }
  return catalog;
};

const skillsCatalogs = new WeakMap<SkillsStore, SkillsCatalogService>();
const skillsCatalogFor = (store: SkillsStore): SkillsCatalogService => {
  let service = skillsCatalogs.get(store);
  if (!service) { service = new SkillsCatalogService({ store }); skillsCatalogs.set(store, service); }
  return service;
};

export async function handleWebConsoleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  gateway: ConsoleGateway,
  operator: WebOperatorServices,
  workflows: WebWorkflowService,
  github: GitHubPublicationAuth,
  sentinels: WebSentinelService,
  team?: { auth: TeamAuth; collaboration?: CollaborationService },
  skills?: SkillsStore,
  webhook?: WebhookConsoleContext,
): Promise<boolean> {
  if (!requestUrl.pathname.startsWith("/api/console/")) return false;
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") invalidateReadCache();
  const path = requestUrl.pathname.slice("/api/console/".length);
  const input = method === "GET" || method === "HEAD" ? undefined : await readJson(req);
  const member = team?.auth.resolveSession(req);
  const author = member ? { userId: member.userId, displayName: member.displayName } : undefined;
  auditConsoleRequest(res, path, method, input, { engineRequest: !team, teamEnabled: team?.auth.enabled === true, ...(member ? { displayName: member.displayName } : {}) });
  if (team?.auth.enabled && method !== "GET" && method !== "HEAD") {
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
    const auditLog = handleAuditLogRequest(path, method, requestUrl.searchParams, { teamEnabled: team?.auth.enabled === true, ...(member?.role ? { role: member.role } : {}) });
    if (auditLog) { json(res, auditLog.status, auditLog.data); return true; }
    if (skills) {
      const catalog = await handleSkillsCatalogRequest(skillsCatalogFor(skills), path, method, input, { canWrite: !team?.auth.enabled || member?.role !== "viewer" });
      if (catalog) { json(res, catalog.status, catalog.data); return true; }
    }
    const extensionService = createExtensionService();
    const connectors = await handleConnectorRequest(extensionService, { github: new GitHubConnector(github) }, path, method, input);
    if (connectors) { json(res, connectors.status, connectors.data); return true; }
    const extensions = await handleExtensionRequest(extensionService, path, method, input, requestUrl.searchParams);
    if (extensions) { json(res, extensions.status, extensions.data); return true; }
    const selfEdit = await handleSelfEditRequest({ method, path, input, req, team });
    if (selfEdit) { json(res, selfEdit.status, selfEdit.data); return true; }
    if (path === "execution" && method === "GET") { json(res, 200, await workbenchStatus()); return true; }
    const repositories = await handleRepositoriesRequest(repositoryCatalogFor(github), path, method, requestUrl.searchParams);
    if (repositories) { json(res, repositories.status, repositories.data); return true; }
    if (path === "github" && method === "GET") { json(res, 200, { github: await github.status() }); return true; }
    const webhookReply = handleWebhookConsoleRequest(path, method, webhook ?? {});
    if (webhookReply) { json(res, webhookReply.status, webhookReply.data); return true; }
    if (path === "github/connect" && method === "POST") { json(res, 200, { github: await github.connect(input) }); return true; }
    if (path === "github/device-auth" && method === "POST") {
      json(res, 202, { github: await github.start(parseAuthMode(input)) }); return true;
    }
    if (path === "github/device-auth" && method === "DELETE") { json(res, 200, { github: await github.cancel() }); return true; }
    const workflow = await workflows.handle(requestUrl.pathname, method, input, requestUrl.searchParams);
    if (workflow) {
      if (team?.collaboration && method !== "GET" && method !== "HEAD" && workflow.status >= 200 && workflow.status < 300) {
        const definition = workflow.data && typeof workflow.data === "object" && "definition" in workflow.data ? workflow.data.definition : undefined;
        const id = definition && typeof definition === "object" && "id" in definition && typeof definition.id === "string" ? definition.id : /^\/api\/console\/workflow-definitions\/([^/]+)/.exec(requestUrl.pathname)?.[1];
        if (id) team.collaboration.notifyChanged("workflow", decodeURIComponent(id));
      }
      json(res, workflow.status, workflow.data); return true;
    }
    const sentinel = await sentinels.handle(requestUrl.pathname, method, input, requestUrl.searchParams, {
      userId: member?.userId ?? "local", displayName: member?.displayName ?? "Local operator",
      ...(team?.auth.enabled ? { role: member?.role ?? "viewer" } : {}),
      onMissionCreated: id => { if (team?.auth.enabled && team.collaboration) team.collaboration.register(id, getSessionId(req)!); },
    });
    if (sentinel) { json(res, sentinel.status, sentinel.data); return true; }
    const instructions = handleInstructionsRequest(path, method, input, requestUrl.searchParams);
    if (instructions) { json(res, instructions.status, instructions.data); return true; }
    const hostRoute = await handleWorkspaceHostRequest(path, method, input, req, res);
    if (hostRoute) { json(res, hostRoute.status, hostRoute.data); return true; }
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
      if (method === "GET") json(res, 200, { sessions: gateway.list() }, { conditional: true });
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
        json(res, 200, { sessions: await gateway.listSavedAsync({
          ...(requestUrl.searchParams.get("cwd") ? { cwd: requestUrl.searchParams.get("cwd") } : {}),
          ...(limit ? { limit: Number(limit) } : {}),
        }) }, { conditional: true });
      } else if (id && parts.length === 2 && method === "GET") json(res, 200, gateway.loadSaved(id));
      else if (id && parts[2] === "transcript" && parts.length === 3 && method === "GET") {
        const params = requestUrl.searchParams;
        const rawWindow = params.get("window");
        const window = rawWindow === null ? undefined : Number(rawWindow);
        if (window !== undefined && (!Number.isSafeInteger(window) || window < 1 || window > MAX_SNAPSHOT_WINDOW)) throw new ConsoleGatewayError(`window must be an integer from 1 to ${MAX_SNAPSHOT_WINDOW}.`, 400);
        const page = params.has("before") || params.has("limit") ? badRequest(() => parseMessagePage(params)) : undefined;
        json(res, 200, gateway.savedTranscript(id, { ...(page?.before !== undefined ? { before: page.before } : {}), ...(page ? { limit: page.limit } : {}), ...(window !== undefined ? { window } : {}) }));
      }
      else if (id && parts.length === 2 && method === "DELETE") { await gateway.removeSaved(id); json(res, 200, { ok: true }); }
      else if (id && parts[2] === "archive" && method === "POST") json(res, 200, { session: gateway.archiveSaved(id, input) });
      else if (id && parts[2] === "resume" && method === "POST") json(res, 201, { session: await gateway.resume(id, input) });
      else if (id && parts[2] === "export" && method === "GET") json(res, 200, gateway.exportSaved(id));
      else json(res, 405, { error: "Method not allowed." });
      return true;
    }
    if (parts[0] !== "sessions" || !parts[1]) return false;
    const id = parts[1];
    const action = parts[2];
    if (!action && method === "GET") {
      const window = badRequest(() => parseSnapshotWindow(requestUrl.searchParams));
      json(res, 200, { snapshot: window ? gateway.getWindowed(id, window) : gateway.get(id) });
    }
    else if (!action && method === "DELETE") {
      workflows.cancelSession(id);
      await gateway.close(id);
      json(res, 200, { ok: true });
    } else if (action === "events" && method === "GET") {
      const after = consoleEventsAfter(requestUrl.searchParams.get("after"));
      const waitSeconds = badRequest(() => parseEventsWait(requestUrl.searchParams.get("wait")));
      if (waitSeconds > 0) {
        // Long-poll: hold until new events, the timeout, or the client going away.
        const abort = new AbortController(); const onClose = () => abort.abort();
        res.once("close", onClose);
        try { await gateway.waitForEvents(id, after, waitSeconds * 1000, abort.signal); } finally { res.removeListener("close", onClose); }
        if (res.destroyed) return true;
      }
      json(res, 200, gateway.eventsAfter(id, after, { resync: requestUrl.searchParams.get("window") === "1" }));
    } else if (action === "messages" && method === "GET") {
      json(res, 200, gateway.messagesPage(id, badRequest(() => parseMessagePage(requestUrl.searchParams))));
    } else if (action === "tools" && parts.length === 3 && method === "GET") {
      json(res, 200, { tools: gateway.tools(id) }, { conditional: true });
    } else if (action === "messages" && method === "POST") {
      const message = author && input && typeof input === "object" && !("workerId" in input) && (!("mode" in input) || input.mode === "send") ? { ...input, mode: "queue" } : input;
      const { queuedMessageId, ...session } = await gateway.send(id, message, author);
      json(res, 202, { session, ...(queuedMessageId ? { queuedMessageId } : {}) });
    }
    else if (action === "retry" && parts.length === 3 && method === "POST") {
      const { queuedMessageId, ...session } = await gateway.retry(id, input, author);
      json(res, 202, { session, ...(queuedMessageId ? { queuedMessageId } : {}) });
    }
    else if (action === "force-stop" && method === "POST") {
      z.object({}).strict().parse(input);
      json(res, 200, { session: await gateway.forceStop(id) });
    }
    else if (action === "cancel" && method === "POST") json(res, 200, { session: await gateway.cancel(id) });
    else if (action === "connection" && parts[3] === "reload" && parts.length === 4 && method === "POST") {
      z.object({}).strict().parse(input ?? {});
      json(res, 200, { session: await gateway.reloadConnection(id) });
    }
    else if (action === "configuration" && method === "PATCH") json(res, 200, { session: await gateway.configure(id, input) });
    else if (action === "title" && parts[3] === "regenerate" && parts.length === 4 && method === "POST") {
      z.object({}).strict().parse(input ?? {});
      json(res, 200, await gateway.regenerateTitle(id));
    }
    else if (action === "clear" && method === "POST") json(res, 200, { session: await gateway.clear(id) });
    else if (action === "continue" && method === "POST") json(res, 202, { session: await gateway.continue(id, input, author) });
    else if (action === "save" && method === "POST") json(res, 200, { session: gateway.save(id) });
    else if (action === "save-as" && method === "POST") {
      z.object({}).strict().parse(input ?? {});
      json(res, 201, { session: gateway.saveAs(id) });
    }
    else if (action === "archive" && method === "POST") {
      workflows.cancelSession(id);
      json(res, 200, { session: await gateway.archive(id) });
    }
    else if (action === "delete" && method === "POST") {
      workflows.cancelSession(id);
      json(res, 200, await gateway.delete(id));
    } else if (action === "export" && method === "GET") json(res, 200, gateway.export(id));
    else if (action === "queue" && parts[3] && parts[4] === "send" && parts.length === 5 && method === "POST") {
      z.object({}).strict().parse(input ?? {});
      json(res, 202, { session: gateway.sendQueuedNow(id, parts[3]) });
    }
    else if (action === "queue" && method === "DELETE") json(res, 200, { session: gateway.removeQueued(id, parts[3]) });
    else if (action === "decisions" && parts[3] && method === "POST") json(res, 200, { session: gateway.resolveDecision(id, parts[3], input) });
    else if (action === "workers") {
      const workerId = parts[3];
      if (!workerId && method === "GET") json(res, 200, { workers: requestUrl.searchParams.get("summary") === "1" ? gateway.workers(id).map(summarizeConsoleWorker) : gateway.workers(id) });
      else if (workerId && parts.length === 4 && workerId !== "stop" && method === "GET") json(res, 200, { worker: gateway.worker(id, workerId) });
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

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  dbPath: string | undefined,
  controlToken: string,
  engineBearer?: string,
  resolveScanDatabase?: (scanId: string) => string | undefined,
  caller?: AuditCaller,
): Promise<boolean> {
  const { osecDB } = await import("@0/engine/storage");
  if (req.method !== "GET" && req.method !== "HEAD") invalidateReadCache();

  if (isPresentationEventsStreamPath(pathname)) {
    if (req.method !== "GET") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }

    const db = await openSharedDb(dbPath);
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

    if (controlPath.action === "reset-database") {
      const { resetOsecDatabase } = await import("@0/engine/storage");
      const { seedVerificationWorkbench } = await import("../commands/db.js");
      const body = await readJsonObject<{ seed?: string }>(req);
      const seed = typeof body.seed === "string" ? body.seed.trim().toLowerCase() : "verification";

      if (!["verification", "empty"].includes(seed)) {
        json(res, 400, { error: `Unsupported seed preset: ${seed}` });
        return true;
      }

      await evictSharedDb(dbPath);
      const path = resetOsecDatabase(dbPath);
      const resetDb = new osecDB(dbPath);
      try {
        const seeded = seed === "verification"
          ? seedVerificationWorkbench(resetDb)
          : { scans: 0, families: 0, workers: 0 };
        json(res, 200, { ok: true, path, seed, ...seeded });
        auditDatabaseReset(seed, { engineRequest: false });
      } finally {
        resetDb.close();
      }
      return true;
    }
  }

  if (pathname === "/api/dashboard") {
    // Three pollers (3-5 s) hit this; share one computation per ~1 s window.
    const body = await readThrough(`dashboard:${dbPath ?? process.env["ZERO_DB_PATH"] ?? ""}`, async () => {
      const db = await openSharedDb(dbPath);
      try {
        // Findings live in the shared database and in one database per `0 scan` run: show them as one list.
        const merged = await findingsServiceFor(dbPath).list();
        const scans = merged.scans.slice(0, 100) as DBScanRow[];
        const groups = merged.families.map(family => {
          const latest = normalizeFinding(family.latest as DBFindingRow);
          return { fingerprint: family.key, latest, count: family.count, scanCount: family.scanCount, sourceScanIds: family.sourceScanIds,
            provenance: family.provenance, workflow: buildWorkflowSummary([latest], [], family.activeSessions, family.verdictCounts) };
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
        return {
          scans: scans.map(summarizeScan),
          cases,
          groups,
          workers: workers.map((worker) => summarizeWorker(worker, workItemsById, casesById)),
          queue: summarizeQueue(workItems, workers),
        };
      } finally {
        db.close();
      }
    });
    json(res, 200, body, { conditional: true });
    return true;
  }

  if (pathname === "/api/scans") {
    const scans = (await findingsServiceFor(dbPath).list()).scans.slice(0, 100) as DBScanRow[];
    json(res, 200, { scans: scans.map(summarizeScan) }, { conditional: true });
    return true;
  }

  if (parseRecentEventsPath(pathname)) {
    const url = new URL(req.url ?? pathname, "http://localhost");
    const rawLimit = Number(url.searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 20;
    const db = await openSharedDb(dbPath);
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

      json(res, 200, { events }, { conditional: true });
    } finally {
      db.close();
    }
    return true;
  }

  const scanPath = parseScanPath(pathname);
  if (scanPath) {
    const scanDb = resolveScanDatabase?.(scanPath.scanId) ?? (await findingsServiceFor(dbPath).sourceOfScan(scanPath.scanId))?.id ?? dbPath;
    const db = await openSharedDb(scanDb);
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
    await handleFindingFamilyRequest(req, res, familyPath.fingerprint, familyPath.action, dbPath, controlToken, engineBearer, caller);
    return true;
  }

  return false;
}
