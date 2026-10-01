import type { BackendDescriptor } from "@0/shared";
import { BackendClient } from "./lib/backend-client";
export { useBackendApi } from "./backend-context";
import type {
  ConsoleCreateSessionInput,
  ConsoleEventsPage,
  ConsoleMessageInput,
  ConsolePublicExport,
  ConsoleSavedSession,
  ConsoleSessionConfiguration,
  ConsoleSessionSnapshot,
  DesktopConsoleDecisionResponse,
  DesktopConsoleSession,
} from "@0/shared";
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
async function webFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await webFetch(path, init);

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // Ignore JSON parse failures for non-JSON error bodies.
    }
    throw new Error(message);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new Error(
      `Engine ${client.backendId} returned ${contentType || "non-JSON content"} for ${path}. Reload this page or check connection diagnostics.`,
    );
  }
  const result = await response.json() as T;
  client.signal.throwIfAborted();
  return result;
}

function getDashboard(): Promise<DashboardResponse> {
  return webFetchJson("/api/dashboard");
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
  mode: "probe" | "deep" | "mcp" | "web";
  runtime: "api" | "claude" | "codex" | "gemini" | "auto";
  ensureDaemon?: boolean;
}): Promise<{ ok: true; pid: number | null }> {
  return webFetchJson("/api/control/launch-run", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

async function listConsoleSessions(signal?: AbortSignal): Promise<DesktopConsoleSession[]> {
  const result = await webFetchJson<{ sessions: DesktopConsoleSession[] }>("/api/console/sessions", { signal });
  return result.sessions;
}

async function listSavedConsoleSessions(signal?: AbortSignal): Promise<ConsoleSavedSession[]> {
  const result = await webFetchJson<{ sessions: ConsoleSavedSession[] }>("/api/console/saved", { signal });
  return result.sessions;
}

async function createConsoleSession(input: ConsoleCreateSessionInput): Promise<DesktopConsoleSession> {
  const result = await webFetchJson<{ session: DesktopConsoleSession }>("/api/console/sessions", { method: "POST", body: JSON.stringify(input) });
  return result.session;
}

async function getConsoleSnapshot(id: string, signal?: AbortSignal): Promise<ConsoleSessionSnapshot> {
  const result = await webFetchJson<{ snapshot: ConsoleSessionSnapshot }>(`/api/console/sessions/${encodeURIComponent(id)}`, { signal });
  return result.snapshot;
}

function getConsoleEvents(id: string, after: number, signal?: AbortSignal): Promise<ConsoleEventsPage> {
  return webFetchJson(`/api/console/sessions/${encodeURIComponent(id)}/events?after=${after}`, { signal });
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

function controlConsoleSession(id: string, action: "cancel" | "clear" | "workers/stop"): Promise<{ session: DesktopConsoleSession }> {
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
  return webFetchJson(`/api/console/${saved ? "saved" : "sessions"}/${encodeURIComponent(id)}${workerId ? `/workers/${encodeURIComponent(workerId)}` : ""}/export`);
}


function archiveConsoleSession(id: string, saved = false, archived = true): Promise<{ session: ConsoleSavedSession }> {
  return webFetchJson(`/api/console/${saved ? "saved" : "sessions"}/${encodeURIComponent(id)}/archive`, { method: "POST", body: JSON.stringify({ archived }) });
}

  return { client, webFetch, webFetchJson, getDashboard, getScans, getScan, getScanEvents, getRecentEvents, getScanFindings, getFindingFamily, updateFindingFamilyTriage, updateFindingFamilyWorkflow, recoverStaleWorkers, pruneStoppedWorkers, resetDatabase, startDaemon, stopDaemon, launchRun, listConsoleSessions, listSavedConsoleSessions, createConsoleSession, getConsoleSnapshot, getConsoleEvents, sendConsoleMessage, removeConsoleQueuedMessage, configureConsoleSession, resolveConsoleDecision, controlConsoleSession, stopConsoleWorker, closeConsoleSession, deleteConsoleSession, resumeConsoleSession, deleteSavedConsoleSession, exportConsoleSession, archiveConsoleSession };
}
export type BackendApi = ReturnType<typeof createBackendApi>;
