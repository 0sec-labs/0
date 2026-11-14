import type { BackendDescriptor, ImpactAssessment, RunRecord } from "@0/engine/shared";
import { BackendClient } from "./lib/backend-client";
import { createTeamClient } from "./lib/team-client";
import { bustSharedReads, sharedRead } from "./lib/shared-read";
import { isRequestCancellation } from "./lib/request-cancellation";
import { apiErrorFrom } from "./lib/api-error";
import { withRememberedModel } from "./lib/last-model-choice";
import { outage, withTransientRetry, TransientNetworkError, NonJsonResponseError, isTransientNetworkError } from "./lib/network-resilience";
import { expandSummaryWorkers, MESSAGE_PAGE, OPEN_WINDOW, type ConsoleMessagesPage, type WindowedSnapshot } from "./console/snapshot-window";
export { useBackendApi } from "./backend-context";
import type {
  ConsoleCreateSessionInput,
  ConsoleEventsPage,
  ConsoleMessageInput,
  ConsolePublicExport,
  ConsoleSavedSession,
  ConsoleSessionConfiguration,
  ConsolePublicMessage,
  ConsoleSessionSnapshot,
  ConsoleWorker,
  DesktopConsoleDecisionResponse,
  DesktopConsoleSession,
} from "@0/engine/shared";
import type {
  DashboardResponse,
  FindingFamilyResponse,
  FindingWorkflowStatus,
  RecentEventsResponse,
  ScanEventsResponse,
  ScanFindingsResponse,
  ScanRecord,
} from "./types";

/** Read the per-session control token injected by the dashboard server. */
function getControlToken(): string | null {
  const meta = document.querySelector('meta[name="0-control-token"]');
  return meta?.getAttribute("content") ?? null;
}

let refreshingControlToken: Promise<string | null> | undefined;

/** Recover after a local server restart using its same-origin HTML bootstrap. */
function refreshControlToken(): Promise<string | null> {
  return refreshingControlToken ??= (async () => {
    const response = await fetch("/", {
      credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return null;
    const bootstrap = new DOMParser().parseFromString(await response.text(), "text/html");
    const token = bootstrap.querySelector('meta[name="0-control-token"]')?.getAttribute("content");
    if (!token) return null;
    let meta = document.querySelector('meta[name="0-control-token"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "0-control-token");
      document.head.append(meta);
    }
    meta.setAttribute("content", token);
    return token;
  })().finally(() => { refreshingControlToken = undefined; });
}

export async function localControlFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!path.startsWith("/api/") || path.includes("\\") || new URL(path, window.location.origin).origin !== window.location.origin) {
    throw new Error("Browser controls require a same-origin API path.");
  }
  // Any write invalidates coalesced reads so a refetch after a mutation is never served from the short read window.
  if (init?.method && init.method.toUpperCase() !== "GET") bustSharedReads();
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const token = getControlToken();
  if (token) headers.set("X-0-Control-Token", token);

  const request = () => fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  const response = await request();
  if (response.status !== 403) return response;
  const rejection = await response.clone().json().catch(() => null) as { error?: string } | null;
  if (rejection?.error !== "Invalid or missing control token") return response;
  // Token validation rejects the request before the API action runs, so one
  // retry is safe even for writes. Other authorization failures never retry.
  const current = getControlToken();
  const refreshed = current && current !== token ? current : await refreshControlToken().catch(() => null);
  if (!refreshed || init?.signal?.aborted) return response;
  headers.set("X-0-Control-Token", refreshed);
  return request();
}

export function createBackendApi(backendId: string, descriptor?: BackendDescriptor) {
  const client = new BackendClient(backendId, localControlFetch, descriptor);
  const webFetch = (path: string, init?: RequestInit) => client.request(path, init);
  const teamClient = createTeamClient(backendId, webFetch);
async function webFetchJsonOnce<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await webFetch(path, init);

  if (!response.ok) {
    const body = await response.json().catch(() => null) as unknown;
    throw apiErrorFrom(response, body);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    // HTML or an empty body means the host is restarting or a proxy answered; treat it as a transient drop.
    throw new NonJsonResponseError(`Engine ${client.backendId} returned ${contentType || "non-JSON content"} for ${path}. Reload this page or check connection diagnostics.`);
  }
  const result = await response.json() as T;
  client.signal.throwIfAborted();
  return result;
}

/**
 * A dropped connection or a 502/503/504 (engine restarting) is transient: reads retry with backoff
 * (3 tries over ~6s) and writes are never replayed. The final failure is a TransientNetworkError, never the raw "Failed to fetch".
 */
async function webFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const idempotent = !init?.method || ["GET", "HEAD"].includes(init.method.toUpperCase());
  const onSuccess = () => { if (outage.success() && typeof window !== "undefined") window.dispatchEvent(new Event("0-network-recovered")); };
  try {
    return await withTransientRetry(() => webFetchJsonOnce<T>(path, init), { signal: init?.signal ?? undefined, delays: idempotent ? undefined : [], onFailure: () => outage.failure(), onSuccess });
  } catch (cause) {
    if (!(cause instanceof TransientNetworkError) && isTransientNetworkError(cause) && !init?.signal?.aborted) throw new TransientNetworkError(cause);
    throw cause;
  }
}

  // Several views poll these under different query keys; one request serves them all within the window.
  const READ_WINDOW_MS = 4000;
  const coalesced = <T,>(path: string, signal?: AbortSignal) => sharedRead<T>(`${client.backendId}:${path}`, READ_WINDOW_MS, () => webFetchJson<T>(path), signal);

function getDashboard(): Promise<DashboardResponse> {
  return coalesced("/api/dashboard");
}

function getRuns(): Promise<RunRecord[]> {
  return coalesced("/api/work");
}

async function getScans(): Promise<ScanRecord[]> {
  const data = await webFetchJson<{ scans: ScanRecord[] }>("/api/scans");
  return data.scans;
}

async function getScan(scanId: string): Promise<ScanRecord> {
  const data = await webFetchJson<{ scan: ScanRecord }>(`/api/scans/${encodeURIComponent(scanId)}`);
  return data.scan;
}

function getScanEvents(scanId: string): Promise<ScanEventsResponse> {
  return webFetchJson(`/api/scans/${encodeURIComponent(scanId)}/events`);
}

function getRecentEvents(limit = 20): Promise<RecentEventsResponse> {
  return webFetchJson(`/api/events/recent?limit=${encodeURIComponent(String(limit))}`);
}

function getScanFindings(scanId: string): Promise<ScanFindingsResponse> {
  return webFetchJson(`/api/scans/${encodeURIComponent(scanId)}/findings`);
}

function getFindingFamily(fingerprint: string): Promise<FindingFamilyResponse> {
  return webFetchJson(`/api/finding-family/${encodeURIComponent(fingerprint)}`);
}

function updateFindingImpactAssessment(findingId: string, impactAssessment: ImpactAssessment): Promise<{ findingId: string; impactAssessment: ImpactAssessment }> {
  return webFetchJson(`/api/findings/${encodeURIComponent(findingId)}/impact-assessment`, { method: "POST", body: JSON.stringify(impactAssessment) });
}
function clearFindingImpactAssessment(findingId: string): Promise<{ findingId: string; impactAssessment: null }> {
  return webFetchJson(`/api/findings/${encodeURIComponent(findingId)}/impact-assessment`, { method: "DELETE" });
}

function updateFindingFamilyTriage(
  fingerprint: string,
  triageStatus: "new" | "accepted" | "suppressed",
  triageNote: string,
): Promise<{ ok: true }> {
  return webFetchJson(`/api/finding-family/${encodeURIComponent(fingerprint)}/triage`, {
    method: "POST",
    body: JSON.stringify({ triageStatus, triageNote }),
  });
}

function updateFindingFamilyWorkflow(
  fingerprint: string,
  workflowStatus: FindingWorkflowStatus,
  workflowAssignee: string,
): Promise<{ ok: true }> {
  return webFetchJson(`/api/finding-family/${encodeURIComponent(fingerprint)}/workflow`, {
    method: "POST",
    body: JSON.stringify({ workflowStatus, workflowAssignee }),
  });
}

function recoverStaleWorkers(staleAfterMs = 30_000): Promise<{ ok: true; recovered: number }> {
  return webFetchJson("/api/control/recover-stale-workers", {
    method: "POST",
    body: JSON.stringify({ staleAfterMs }),
  });
}

function pruneStoppedWorkers(): Promise<{ ok: true; deleted: number }> {
  return webFetchJson("/api/control/prune-stopped-workers", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

function resetDatabase(seed: "verification" | "empty"): Promise<{
  ok: true;
  path: string;
  seed: "verification" | "empty";
  scans: number;
  families: number;
  workers: number;
}> {
  return webFetchJson("/api/control/reset-database", {
    method: "POST",
    body: JSON.stringify({ seed }),
  });
}

function startDaemon(args?: {
  label?: string;
  pollIntervalMs?: number;
}): Promise<{ ok: true; pid: number | null; label: string }> {
  return webFetchJson("/api/control/start-daemon", {
    method: "POST",
    body: JSON.stringify(args ?? {}),
  });
}

function stopDaemon(): Promise<{ ok: true; stopped: number }> {
  return webFetchJson("/api/control/stop-daemon", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

function launchRun(args: {
  target: string;
  depth: "quick" | "default" | "deep";
  runtime?: "api" | "auto";
}): Promise<{ ok: true; engineOwned: true; sessionId: string; runId: string; jobId?: string }> {
  return webFetchJson("/api/control/launch-run", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

async function listConsoleSessions(signal?: AbortSignal): Promise<DesktopConsoleSession[]> {
  const result = await coalesced<{ sessions: DesktopConsoleSession[] }>("/api/console/sessions", signal);
  return result.sessions;
}

async function listSavedConsoleSessions(signal?: AbortSignal): Promise<ConsoleSavedSession[]> {
  const result = await coalesced<{ sessions: ConsoleSavedSession[] }>("/api/console/saved", signal);
  return result.sessions;
}

async function createConsoleSession(input: ConsoleCreateSessionInput): Promise<DesktopConsoleSession> {
  const remembered = withRememberedModel(client.backendId, input);
  try {
    return (await webFetchJson<{ session: DesktopConsoleSession }>("/api/console/sessions", { method: "POST", body: JSON.stringify(remembered) })).session;
  } catch (cause) {
    // A remembered model whose connection disappeared must not block starting a mission.
    if (remembered === input || isTransientNetworkError(cause)) throw cause;
    return (await webFetchJson<{ session: DesktopConsoleSession }>("/api/console/sessions", { method: "POST", body: JSON.stringify(input) })).session;
  }
}

/**
 * Opens a session from a bounded snapshot (last `window` messages/events, worker summaries, no tool catalog).
 * A server that predates windowing ignores the parameters and returns the full snapshot without a `window`
 * field, which every consumer treats as "everything is already here".
 */
async function getConsoleSnapshot(id: string, signal?: AbortSignal, window: number = OPEN_WINDOW): Promise<WindowedSnapshot> {
  const result = await webFetchJson<{ snapshot: WindowedSnapshot }>(`/api/console/sessions/${encodeURIComponent(id)}?window=${window}&workers=summary`, { signal });
  return expandSummaryWorkers(result.snapshot);
}

/** Long-poll when `wait` is set; `resync` asks for a cheap `{ resync: true }` instead of a full gap snapshot. */
function getConsoleEvents(id: string, after: number, signal?: AbortSignal, options: { wait?: number; resync?: boolean } = {}): Promise<ConsoleEventsPage & { resync?: true }> {
  const query = `after=${after}${options.wait ? `&wait=${options.wait}` : ""}${options.resync ? "&window=1" : ""}`;
  return webFetchJson(`/api/console/sessions/${encodeURIComponent(id)}/events?${query}`, { signal });
}

async function getConsoleTools(id: string, signal?: AbortSignal): Promise<ConsoleSessionSnapshot["tools"]> {
  return (await webFetchJson<{ tools: ConsoleSessionSnapshot["tools"] }>(`/api/console/sessions/${encodeURIComponent(id)}/tools`, { signal })).tools;
}

async function getConsoleWorker(id: string, workerId: string, signal?: AbortSignal): Promise<ConsoleWorker> {
  return (await webFetchJson<{ worker: ConsoleWorker }>(`/api/console/sessions/${encodeURIComponent(id)}/workers/${encodeURIComponent(workerId)}`, { signal })).worker;
}

function getConsoleMessagesPage(id: string, before: number, limit: number = MESSAGE_PAGE, signal?: AbortSignal): Promise<ConsoleMessagesPage> {
  return webFetchJson(`/api/console/sessions/${encodeURIComponent(id)}/messages?before=${before}&limit=${limit}`, { signal });
}

/** Read-only saved transcript. Servers without the transcript route answer with the whole record from the old path. */
async function getSavedTranscript(id: string, options: { window?: number; before?: number; limit?: number } = {}, signal?: AbortSignal): Promise<ConsoleMessagesPage & { meta: ConsoleSavedSession }> {
  const query = options.before !== undefined ? `before=${options.before}&limit=${options.limit ?? MESSAGE_PAGE}` : options.window !== undefined ? `window=${options.window}` : "";
  const base = `/api/console/saved/${encodeURIComponent(id)}`;
  try {
    const page = await webFetchJson<ConsoleMessagesPage & { meta: ConsoleSavedSession }>(`${base}/transcript${query ? `?${query}` : ""}`, { signal });
    if (Array.isArray(page.messages) && typeof page.firstIndex === "number") return page;
  } catch (cause) {
    if (isRequestCancellation(cause) || signal?.aborted || !/\b40[45]\b|not found|method not allowed/i.test(cause instanceof Error ? cause.message : "")) throw cause;
  }
  const legacy = await webFetchJson<{ meta: ConsoleSavedSession; messages: ConsolePublicMessage[] }>(base, { signal });
  return { meta: legacy.meta, messages: legacy.messages, total: legacy.messages.length, firstIndex: 0, hasMore: false };
}

function sendConsoleMessage(id: string, input: ConsoleMessageInput): Promise<{ session: DesktopConsoleSession }> {
  return webFetchJson(`/api/console/sessions/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify(input) });
}

function removeConsoleQueuedMessage(id: string, queueId?: string): Promise<unknown> {
  return webFetchJson(`/api/console/sessions/${encodeURIComponent(id)}/queue${queueId ? `/${encodeURIComponent(queueId)}` : ""}`, { method: "DELETE" });
}

function configureConsoleSession(id: string, input: ConsoleSessionConfiguration): Promise<{ session: DesktopConsoleSession }> {
  return webFetchJson(`/api/console/sessions/${encodeURIComponent(id)}/configuration`, { method: "PATCH", body: JSON.stringify(input) });
}

function resolveConsoleDecision(id: string, decisionId: string, response: DesktopConsoleDecisionResponse): Promise<{ session: DesktopConsoleSession }> {
  return webFetchJson(`/api/console/sessions/${encodeURIComponent(id)}/decisions/${encodeURIComponent(decisionId)}`, { method: "POST", body: JSON.stringify(response) });
}

function controlConsoleSession(id: string, action: "cancel" | "force-stop" | "clear" | "workers/stop" | "title/regenerate"): Promise<{ session: DesktopConsoleSession }> {
  return webFetchJson(`/api/console/sessions/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" });
}

function stopConsoleWorker(id: string, workerId: string): Promise<unknown> {
  return webFetchJson(`/api/console/sessions/${encodeURIComponent(id)}/workers/${encodeURIComponent(workerId)}/stop`, { method: "POST", body: "{}" });
}

function closeConsoleSession(id: string): Promise<{ ok: true }> {
  return webFetchJson(`/api/console/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

function deleteConsoleSession(id: string): Promise<{ sessionId: string; savedId?: string }> {
  return webFetchJson(`/api/console/sessions/${encodeURIComponent(id)}/delete`, { method: "POST", body: "{}" });
}

async function resumeConsoleSession(id: string, input: ConsoleCreateSessionInput = {}): Promise<DesktopConsoleSession> {
  const result = await webFetchJson<{ session: DesktopConsoleSession }>(`/api/console/saved/${encodeURIComponent(id)}/resume`, { method: "POST", body: JSON.stringify(input) });
  return result.session;
}

function deleteSavedConsoleSession(id: string): Promise<{ ok: true }> {
  return webFetchJson(`/api/console/saved/${encodeURIComponent(id)}`, { method: "DELETE" });
}

function exportConsoleSession(id: string, saved = false, workerId?: string): Promise<ConsolePublicExport> {
  if (workerId && saved) throw new Error("Saved root exports cannot address a live worker.");
  return webFetchJson(`/api/console/${saved ? "saved" : "sessions"}/${encodeURIComponent(id)}${workerId ? `/engines/${encodeURIComponent(workerId)}` : ""}/export`);
}


function archiveConsoleSession(id: string, saved = false, archived = true): Promise<{ session: ConsoleSavedSession }> {
  return webFetchJson(`/api/console/${saved ? "saved" : "sessions"}/${encodeURIComponent(id)}/archive`, { method: "POST", body: JSON.stringify({ archived }) });
}

  return { client, teamClient, webFetch, webFetchJson, getDashboard, getRuns, getScans, getScan, getScanEvents, getRecentEvents, getScanFindings, getFindingFamily, updateFindingImpactAssessment, clearFindingImpactAssessment, updateFindingFamilyTriage, updateFindingFamilyWorkflow, recoverStaleWorkers, pruneStoppedWorkers, resetDatabase, startDaemon, stopDaemon, launchRun, listConsoleSessions, listSavedConsoleSessions, createConsoleSession, getConsoleSnapshot, getConsoleEvents, getConsoleTools, getConsoleWorker, getConsoleMessagesPage, getSavedTranscript, sendConsoleMessage, removeConsoleQueuedMessage, configureConsoleSession, resolveConsoleDecision, controlConsoleSession, stopConsoleWorker, closeConsoleSession, deleteConsoleSession, resumeConsoleSession, deleteSavedConsoleSession, exportConsoleSession, archiveConsoleSession };
}
export type BackendApi = ReturnType<typeof createBackendApi>;
