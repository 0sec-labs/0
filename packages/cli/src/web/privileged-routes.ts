/**
 * Routes that can run arbitrary code as the operator (custom stdio MCP servers, GitHub plugins) or
 * re-route credentials. They require the browser control token path (never the engine bearer) and,
 * in team mode, the workspace owner.
 */
export function isPrivilegedOperatorRoute(pathname: string, method: string): boolean {
  if (!pathname.startsWith("/api/console/")) return false;
  const path = pathname.slice("/api/console/".length);
  if (/^mcp-servers(?:\/|$)/.test(path)) return method !== "GET" && method !== "HEAD";
  if (/^plugins\/install-github(?:\/|$)/.test(path)) return true;
  if (/^connections\/(?:order|spread)$/.test(path)) return method !== "GET";
  if (/^connections\/[^/]+(?:\/models)?$/.test(path)) return method === "PATCH" || method === "PUT";
  return false;
}

export interface PrivilegedCaller { engineRequest: boolean; teamEnabled: boolean; role?: string }
/** Null when allowed, otherwise the denial to send. */
export function privilegedRouteDenial(pathname: string, method: string, caller: PrivilegedCaller): { status: number; data: { code: string; error: string } } | null {
  if (!isPrivilegedOperatorRoute(pathname, method)) return null;
  if (caller.engineRequest) return { status: 403, data: { code: "browser_only", error: "This action is only available from the browser console." } };
  if (caller.teamEnabled && caller.role !== "owner") return { status: 403, data: { code: "owner_required", error: "Only workspace owners can do this." } };
  return null;
}
