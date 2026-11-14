/**
 * Route authority for /api/console. Two independent gates:
 *
 * 1. Engine bearer (the credential held by attached engines, host workers and the remote proxy).
 *    It is DEFAULT-DENY for every mutating /api/console route: only the allowlist below is
 *    reachable with it. Anything that can run code as the operator, change provider credentials or
 *    base URLs, change operator consent/execution settings, install or enable plugins/MCP servers,
 *    self-edit, or create automations that launch runs requires the browser control token and
 *    returns 403 `browser_only`. A new mutating route is therefore browser-only until it is added
 *    to ENGINE_ALLOWED_MUTATIONS with a justification (see privileged-routes.test.ts).
 * 2. Team mode owner gate (isPrivilegedOperatorRoute): routes that act on the operator's machine,
 *    credentials or global preferences need the workspace owner.
 */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface EngineAllowedMutation { pattern: RegExp; methods: readonly string[]; why: string }
/** Paths are relative to /api/console/. */
export const ENGINE_ALLOWED_MUTATIONS: readonly EngineAllowedMutation[] = [
  { pattern: /^sessions$/, methods: ["POST"], why: "Attached engines and the remote proxy create chat sessions." },
  { pattern: /^sessions\/[^/]+(?:\/.*)?$/, methods: ["POST", "PATCH", "DELETE", "PUT"], why: "Session lifecycle: messages, cancel, configuration of that session, decisions, workers, queue." },
  { pattern: /^saved\/[^/]+(?:\/(?:archive|resume))?$/, methods: ["POST", "DELETE"], why: "Saved conversation resume/archive/delete used by remote clients." },
  { pattern: /^remote-sessions(?:\/.*)?$/, methods: ["POST", "PATCH"], why: "Provider-session transport for attached engines." },
  { pattern: /^provider-relays(?:\/.*)?$/, methods: ["POST", "PUT", "PATCH", "DELETE"], why: "Provider relay transport is engine-only by design." },
  { pattern: /^workflows$/, methods: ["POST"], why: "Launch a session-scoped workflow from a template." },
  { pattern: /^workflows\/[^/]+\/cancel$/, methods: ["POST"], why: "Cancel a session-scoped workflow job." },
  { pattern: /^workflow-definitions\/[^/]+\/run$/, methods: ["POST"], why: "Run an operator-approved existing workflow definition." },
  { pattern: /^workflow-executions\/[^/]+\/cancel$/, methods: ["POST"], why: "Cancel a running workflow execution." },
  { pattern: /^project\/directories$/, methods: ["POST"], why: "Read-only directory listing (POST body carries the path)." },
];

/**
 * Same default-deny for every mutating route OUTSIDE /api/console. Patterns match the full pathname.
 * Anything not listed (team setup/users/auth, workers deploy/stop/repair, skills, engagements,
 * findings-access keys, backend registry, control daemon/reset/prune, ...) is browser-only.
 * Remote clients only reach routes the backend transport admits (backendCapabilitiesForApiPath).
 *
 * `/api/workflow-engine/call` deliberately includes `save_workflow`: the `0 mcp-server` workflow
 * tool set (MCP_WORKFLOW_TOOL_NAMES) and the remote-workflow-runtime expose it so an MCP client can
 * author workflows on an attached engine. It is validated and revision-guarded server-side, unlike
 * the browser-only POST /api/console/workflow-definitions, which stays default-deny for the bearer.
 */
export const ENGINE_ALLOWED_API_MUTATIONS: readonly EngineAllowedMutation[] = [
  { pattern: /^\/api\/workflow-engine\/call$/, methods: ["POST"], why: "Attached engine/MCP/remote workflow runtime invokes the bounded engine operation set (sessions, runs, workflows, assessments)." },
  { pattern: /^\/api\/control\/launch-run$/, methods: ["POST"], why: "Launching an assessment is equivalent to session create plus start_assessment, both engine-allowed." },
  { pattern: /^\/api\/scans\/[^/]+\/resume$/, methods: ["POST"], why: "Equivalent to the engine-allowed resume_scan operation; admitted by the remote backend transport." },
  { pattern: /^\/api\/finding-family\/[^/]+\/(?:triage|workflow)$/, methods: ["POST"], why: "Finding triage/assignment on a remote engine (artifacts capability); data-only." },
  { pattern: /^\/api\/findings\/[^/]+\/impact-assessment$/, methods: ["POST", "DELETE"], why: "Business impact notes on a remote engine (artifacts capability); data-only." },
];

/** The engine bearer must never ride the registry proxy: it would borrow other backends' credentials or re-enter local routes after the gate. */
const ENGINE_DENIED_ANY_METHOD = /^\/api\/backends\/[^/]+\/proxy(?:\/|$)/;

function isEngineAllowedRoute(pathname: string, method: string): boolean {
  if (ENGINE_DENIED_ANY_METHOD.test(pathname)) return false;
  if (READ_METHODS.has(method)) return true;
  if (pathname.startsWith("/api/console/")) {
    const path = pathname.slice("/api/console/".length);
    return ENGINE_ALLOWED_MUTATIONS.some(entry => entry.methods.includes(method) && entry.pattern.test(path));
  }
  if (pathname.startsWith("/api/")) return ENGINE_ALLOWED_API_MUTATIONS.some(entry => entry.methods.includes(method) && entry.pattern.test(pathname));
  return true;
}

/** True when the engine bearer must be refused (every mutating /api/console route outside the allowlist). */
export function isBrowserOnlyRoute(pathname: string, method: string): boolean {
  return !isEngineAllowedRoute(pathname, method);
}

/**
 * Owner-gated routes in team mode: code execution as the operator (custom stdio MCP servers, GitHub
 * plugins), credential routing and operator-global settings.
 */
export function isPrivilegedOperatorRoute(pathname: string, method: string): boolean {
  if (!pathname.startsWith("/api/console/")) return false;
  const path = pathname.slice("/api/console/".length);
  if (/^mcp-servers(?:\/|$)/.test(path)) return !READ_METHODS.has(method);
  if (/^plugins\/(?:install|install-github|enable|disable|run)(?:\/|$)/.test(path)) return method !== "GET";
  if (/^service-plugins(?:\/|$)/.test(path)) return !READ_METHODS.has(method);
  if (path === "connections") return method === "POST";
  if (/^connections\/(?:order|spread)$/.test(path)) return method !== "GET";
  if (/^connections\/[^/]+(?:\/models)?$/.test(path)) return method === "PATCH" || method === "PUT";
  if (/^providers\/[^/]+\/device-auth$/.test(path)) return method === "POST" || method === "DELETE";
  if (/^settings(?:\/reset)?$/.test(path)) return method === "PATCH" || method === "POST";
  return false;
}

export interface PrivilegedCaller { engineRequest: boolean; teamEnabled: boolean; role?: string }
/** Null when allowed, otherwise the denial to send. */
export function privilegedRouteDenial(pathname: string, method: string, caller: PrivilegedCaller): { status: number; data: { code: string; error: string } } | null {
  if (caller.engineRequest && isBrowserOnlyRoute(pathname, method)) return { status: 403, data: { code: "browser_only", error: "This action is only available from the browser console." } };
  if (!isPrivilegedOperatorRoute(pathname, method)) return null;
  if (caller.engineRequest) return { status: 403, data: { code: "browser_only", error: "This action is only available from the browser console." } };
  if (caller.teamEnabled && caller.role !== "owner") return { status: 403, data: { code: "owner_required", error: "Only workspace owners can do this." } };
  return null;
}
